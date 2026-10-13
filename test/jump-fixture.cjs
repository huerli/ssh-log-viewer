const { Server, Client, utils } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const net = require('node:net');
async function createJump(allowedPorts = [], options = {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const clients = new Set(), sockets = new Set(), listeners = new Set(), allowed = new Set(allowedPorts), requests = [], answers = [];
  const pipe = (socket, channel) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket); channel.destroy(); }); socket.on('error', () => channel.destroy()); channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy()); socket.pipe(channel).pipe(socket); };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (options.keyboardOnly) {
        if (ctx.username !== 'jumper' || ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
        return ctx.prompt([{ prompt: options.prompt || 'Password: ', echo: false }], responses => { answers.push(responses); responses[0] === 'jump-password' ? ctx.accept() : ctx.reject(['keyboard-interactive']); });
      }
      const parsed = utils.parseKey(key);
      const password = ctx.method === 'password' && ctx.password === 'jump-password';
      const publickey = ctx.method === 'publickey' && ctx.key.data.equals(parsed.getPublicSSH()) && (!ctx.signature || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo));
      ctx.username === 'jumper' && (password || publickey) ? ctx.accept() : ctx.reject();
    });
    client.on('tcpip', (accept, reject, info) => {
      requests.push(info);
      if (info.destIP !== '127.0.0.1' || !allowed.has(info.destPort)) return reject();
      const socket = net.connect({ host: info.destIP, port: info.destPort });
      socket.once('error', () => reject()); socket.once('connect', () => pipe(socket, accept()));
    });
    client.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward' || info.bindAddr !== '127.0.0.1' || info.bindPort !== 0) return reject();
      const listener = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {});
        client.forwardOut('127.0.0.1', listener.address().port, '127.0.0.1', socket.remotePort, (error, channel) => error ? socket.destroy() : pipe(socket, channel));
      });
      listeners.add(listener); listener.on('error', () => reject());
      listener.listen(0, '127.0.0.1', () => { allowed.add(listener.address().port); accept(listener.address().port); });
      client.on('close', () => { if (listener.listening) listener.close(); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, privateKey: key, requests, answers, get count() { return clients.size; }, close: async () => { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); for (const listener of listeners) if (listener.listening) listener.close(); await new Promise(resolve => server.close(resolve)); } };
}
async function reverseTunnel(jump, targetPort) {
  const client = new Client(); const sockets = new Set(); client.on('error', () => {});
  client.on('tcp connection', (info, accept, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: targetPort }); sockets.add(socket); socket.on('error', () => { reject(); socket.destroy(); });
    socket.on('connect', () => { const channel = accept(); socket.pipe(channel).pipe(socket); channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy()); socket.on('close', () => { sockets.delete(socket); channel.destroy(); }); });
  });
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port: jump.port, username: 'jumper', password: 'jump-password' }); });
  const port = await new Promise((resolve, reject) => client.forwardIn('127.0.0.1', 0, (error, port) => error ? reject(error) : resolve(port)));
  return { port, close: () => { for (const socket of sockets) socket.destroy(); client.destroy(); } };
}
module.exports = { createJump, reverseTunnel };
