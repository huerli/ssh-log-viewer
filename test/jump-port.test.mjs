import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, link, symlink, copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import jumpPort from '../electron/jump-port.cjs';

const { releaseJumpPort, buildJumpPortReleaseCommand } = jumpPort;
const linuxOnly = { skip: process.platform !== 'linux' };

// Execute exactly the generated remote shell command against isolated local
// listener processes, using the same channel events supplied by ssh2.
function localClient(env = process.env) {
  const client = new EventEmitter();
  client.exec = (command, callback) => {
    const process = spawn('sh', ['-c', command], { env });
    const channel = new EventEmitter();
    channel.stderr = process.stderr;
    channel.close = () => process.kill();
    callback(null, channel);
    process.stdout.on('data', chunk => channel.emit('data', chunk));
    process.on('error', error => channel.emit('error', error));
    process.on('close', code => channel.emit('close', code));
  };
  return client;
}

async function listeningProcess(t, { executable = 'sshd', title = 'sshd: fixture@notty', hosts = ['127.0.0.1'], ignoreTerm = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'viewer-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let binary = process.execPath;
  if (executable === 'sshd') {
    binary = path.join(directory, 'sshd');
    try { await link(process.execPath, binary); }
    catch { await copyFile(process.execPath, binary, constants.COPYFILE_FICLONE); }
  }
  const script = path.join(directory, 'listen.cjs');
  await writeFile(script, `
    const net = require('node:net');
    process.title = ${JSON.stringify(title)};
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    Promise.all(${JSON.stringify(hosts)}.map(host => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen({host, port: 0, ipv6Only: host.includes(':')}, () => resolve(server.address().port));
    }))).then(ports => console.log(JSON.stringify(ports))).catch(error => { console.error(error); process.exit(1); });
  `);
  const child = spawn(binary, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ports = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve(JSON.parse(output.trim()));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Listener fixture exited: ${code}`)));
  });
  return { child, ports };
}

async function accepts(port, host = '127.0.0.1') {
  const socket = net.connect({ port, host });
  try { await once(socket, 'connect'); return true; }
  catch { return false; }
  finally { socket.destroy(); }
}

test('validates ports without executing a command', async () => {
  let invoked = false;
  const client = { exec() { invoked = true; } };
  for (const port of [0, 65536, -1, 1.5, '2200', NaN]) {
    assert.throws(() => buildJumpPortReleaseCommand(port), /端口无效/);
    await assert.rejects(releaseJumpPort(client, port), /端口无效/);
  }
  assert.equal(invoked, false);
  assert.doesNotThrow(() => buildJumpPortReleaseCommand(22));
});

test('stops only the matching loopback SSH session and confirms the port is free', linuxOnly, async t => {
  const target = await listeningProcess(t);
  const unrelated = await listeningProcess(t);
  const result = await releaseJumpPort(localClient(), target.ports[0]);
  assert.equal(result.released, true);
  assert.match(result.message, /重建反向 SSH 隧道/);
  assert.equal(await accepts(target.ports[0]), false);
  assert.equal(await accepts(unrelated.ports[0]), true);
  assert.equal((await releaseJumpPort(localClient(), target.ports[0])).released, false);
});

test('IPv6 localhost listeners are released', linuxOnly, async t => {
  const target = await listeningProcess(t, { hosts: ['::1'] });
  assert.equal((await releaseJumpPort(localClient(), target.ports[0])).released, true);
  assert.equal(await accepts(target.ports[0], '::1'), false);
});

test('refuses a non-SSH service even when its process title looks like sshd', linuxOnly, async t => {
  const target = await listeningProcess(t, { executable: 'node' });
  await assert.rejects(releaseJumpPort(localClient(), target.ports[0]), /非 SSH 服务/);
  assert.equal(await accepts(target.ports[0]), true);
});

test('refuses an SSH master and a session that owns another listening port', linuxOnly, async t => {
  const master = await listeningProcess(t, { title: 'sshd: /usr/sbin/sshd -D [listener]' });
  await assert.rejects(releaseJumpPort(localClient(), master.ports[0]), /主服务/);
  assert.equal(await accepts(master.ports[0]), true);
  const shared = await listeningProcess(t, { hosts: ['127.0.0.1', '127.0.0.1'] });
  await assert.rejects(releaseJumpPort(localClient(), shared.ports[0]), /其他地址或端口/);
  assert.equal(await accepts(shared.ports[0]), true);
  assert.equal(await accepts(shared.ports[1]), true);
});

test('refuses wildcard listeners and never escalates TERM to KILL', linuxOnly, async t => {
  const wildcard = await listeningProcess(t, { hosts: ['0.0.0.0'] });
  await assert.rejects(releaseJumpPort(localClient(), wildcard.ports[0]), /非 localhost/);
  assert.equal(await accepts(wildcard.ports[0]), true);
  const resistant = await listeningProcess(t, { ignoreTerm: true });
  await assert.rejects(releaseJumpPort(localClient(), resistant.ports[0]), /仍在监听/);
  assert.equal(await accepts(resistant.ports[0]), true);
});

test('remote exec and premature disconnect failures are reported', async () => {
  await assert.rejects(releaseJumpPort({ exec: (command, done) => done(new Error('permission denied')) }, 2200), /permission denied/);
  const client = new EventEmitter();
  client.exec = () => queueMicrotask(() => client.emit('close'));
  await assert.rejects(releaseJumpPort(client, 2200), /提前关闭/);
  assert.equal(client.listenerCount('close'), 0);
});

test('times out after eight seconds and closes a late arriving command channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback, closed = false;
  const pending = releaseJumpPort({ exec: (command, done) => { callback = done; } }, 2200);
  t.mock.timers.tick(8000);
  await assert.rejects(pending, /超时（8 秒）/);
  callback(null, { close: () => { closed = true; } });
  assert.equal(closed, true);
});

test('a real OpenSSH reverse tunnel is released without closing other sessions', linuxOnly, async t => {
  try { await access('/usr/sbin/sshd'); } catch { t.skip('OpenSSH server is not installed'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'viewer-real-sshd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'key');
  await promisify(execFile)('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await copyFile(`${key}.pub`, path.join(directory, 'authorized_keys'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = path.join(directory, 'sshd_config');
  await writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${key}\nPidFile ${directory}/pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin yes\nAllowTcpForwarding yes\nLogLevel VERBOSE\n`);
  const server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config]);
  t.after(() => server.kill());
  let serverLog = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OpenSSH startup timed out: ${serverLog}`)), 5000);
      server.stderr.on('data', chunk => {
        serverLog += chunk;
        if (serverLog.includes('Server listening on')) { clearTimeout(timer); resolve(); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error(serverLog)); });
    });
  } catch (error) {
    if (/privilege separation|Operation not permitted|Permission denied/.test(error.message)) { t.skip(`Local sshd cannot start: ${error.message}`); return; }
    throw error;
  }
  const privateKey = await readFile(key);
  const connect = async () => {
    const client = new ssh2.Client();
    t.after(() => client.destroy());
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).on('error', reject);
      client.connect({ host: '127.0.0.1', port, username: os.userInfo().username, privateKey, readyTimeout: 5000 });
    });
    return client;
  };
  const cleanup = await connect(), target = await connect(), other = await connect();
  const forward = client => new Promise((resolve, reject) => client.forwardIn('127.0.0.1', 0, (error, assigned) => error ? reject(error) : resolve(assigned)));
  const cleanupPort = await forward(cleanup);
  await assert.rejects(releaseJumpPort(cleanup, cleanupPort), /当前跳板机连接/);
  await new Promise((resolve, reject) => cleanup.unforwardIn('127.0.0.1', cleanupPort, error => error ? reject(error) : resolve()));
  const targetPort = await forward(target), otherPort = await forward(other);
  const targetClosed = once(target, 'close');
  assert.equal((await releaseJumpPort(cleanup, targetPort)).released, true);
  await targetClosed;
  assert.equal(await accepts(targetPort), false);
  assert.equal(await accepts(otherPort), true);
  assert.equal((await releaseJumpPort(cleanup, targetPort)).released, false);
  assert.equal((await releaseJumpPort(cleanup, otherPort)).released, true);
});


test('BusyBox ash and applets release only the selected listener', linuxOnly, async t => {
  let busybox;
  for (const candidate of ['/usr/bin/busybox', '/bin/busybox']) {
    try { await access(candidate); busybox = candidate; break; } catch {}
  }
  if (!busybox) { t.skip('BusyBox is unavailable'); return; }
  const tools = await mkdtemp(path.join(os.tmpdir(), 'viewer-jump-busybox-'));
  t.after(() => rm(tools, { recursive: true, force: true }));
  for (const applet of ['sh', 'awk', 'readlink', 'tr', 'od', 'sleep', 'ls']) await symlink(busybox, path.join(tools, applet));
  const target = await listeningProcess(t);
  const other = await listeningProcess(t);
  assert.equal((await releaseJumpPort(localClient({ ...process.env, PATH: tools }), target.ports[0])).released, true);
  assert.equal(await accepts(target.ports[0]), false);
  assert.equal(await accepts(other.ports[0]), true);
});
