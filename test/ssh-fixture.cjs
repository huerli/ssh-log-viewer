const { Server, utils } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const STATUS = utils.sftp.STATUS_CODE;

// A loopback-only SFTP server. The optional fake shell never executes OS commands.
async function createServer(root, options = {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const clients = new Set();
  const requests = [];
  const shells = [], pendingShells = [];
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'fixture-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      if (options.shell) {
        const shell = { input: '', pty: null, windows: [], closed: false, channel: null };
        session.on('pty', (acceptPty, _reject, info) => { shell.pty = info; acceptPty(); });
        session.on('window-change', (acceptWindow, _reject, info) => { shell.windows.push(info); acceptWindow?.(); });
        session.on('shell', acceptShell => {
          shells.push(shell);
          const open = () => {
            const channel = acceptShell(); shell.channel = channel;
            channel.on('error', () => {});
            channel.on('data', data => { shell.input += data.toString(); });
            channel.on('close', () => { shell.closed = true; });
            if (typeof options.shell === 'function') options.shell(shell);
          };
          if (options.holdShell) pendingShells.push(open); else open();
        });
      }
      session.on('sftp', acceptSftp => {
      const sftp = acceptSftp(), handles = new Map(); let next = 1;
      for (const type of ['REALPATH', 'STAT', 'LSTAT', 'OPENDIR', 'READDIR', 'OPEN', 'READ']) {
        sftp.on(type, () => requests.push(type));
      }
      const resolve = name => {
        const normalized = path.posix.resolve('/', name);
        const local = path.resolve(root, '.' + normalized);
        if (local !== root && !local.startsWith(root + path.sep)) throw new Error('outside fixture');
        return local;
      };
      const status = (id, error) => sftp.status(id, error?.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE);
      const handle = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(next); handles.set(next++, value); return buffer; };
      const get = buffer => handles.get(buffer.readUInt32BE(0));
      const attrs = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
      sftp.on('REALPATH', (id, name) => { try { const local = resolve(name); sftp.name(id, [{ filename: '/' + path.relative(root, local).split(path.sep).join('/'), longname: '', attrs: {} }]); } catch (e) { status(id, e); } });
      for (const type of ['STAT', 'LSTAT']) sftp.on(type, (id, name) => {
        try { fs.stat(resolve(name), (e, stat) => e ? status(id, e) : sftp.attrs(id, attrs(stat))); } catch (e) { status(id, e); }
      });
      sftp.on('OPENDIR', (id, name) => {
        try { fs.readdir(resolve(name), (e, entries) => e ? status(id, e) : sftp.handle(id, handle({ directory: resolve(name), entries, sent: false }))); } catch (e) { status(id, e); }
      });
      sftp.on('READDIR', (id, h) => {
        const value = get(h); if (!value || value.sent) return sftp.status(id, STATUS.EOF);
        value.sent = true;
        sftp.name(id, value.entries.map(name => ({ filename: name, longname: name, attrs: attrs(fs.statSync(path.join(value.directory, name))) })));
      });
      sftp.on('OPEN', (id, name) => { try { fs.open(resolve(name), 'r', (e, fd) => e ? status(id, e) : sftp.handle(id, handle({ fd }))); } catch (e) { status(id, e); } });
      sftp.on('FSTAT', (id, h) => { const value = get(h); if (!value?.fd) return status(id); fs.fstat(value.fd, (e, stat) => e ? status(id, e) : sftp.attrs(id, attrs(stat))); });
      sftp.on('READ', (id, h, offset, length) => {
        const value = get(h); if (!value?.fd) return status(id);
        const buffer = Buffer.alloc(Math.min(length, 65536));
        fs.read(value.fd, buffer, 0, buffer.length, offset, (e, bytes) => e ? status(id, e) : bytes ? sftp.data(id, buffer.subarray(0, bytes)) : sftp.status(id, STATUS.EOF));
      });
      sftp.on('CLOSE', (id, h) => {
        const value = get(h); handles.delete(h.readUInt32BE(0));
        if (value?.fd) fs.close(value.fd, () => sftp.status(id, STATUS.OK)); else sftp.status(id, STATUS.OK);
      });
      sftp.on('close', () => { for (const value of handles.values()) if (value.fd) fs.close(value.fd, () => {}); handles.clear(); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, get count() { return clients.size; }, requests, shells, releaseShells: () => { for (const open of pendingShells.splice(0)) open(); }, close: () => { for (const client of clients) client.end(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createServer };
