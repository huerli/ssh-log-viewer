import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import terminalModule from '../electron/ssh-terminal.cjs';
import modeModule from '../electron/terminal-mode.cjs';
const { createSshTerminal, createSshLog } = terminalModule;
const { createTerminalMode } = modeModule;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class Channel extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.stderr.setEncoding = encoding => this.stderr.encoding = encoding; this.written = []; this.windows = []; }
  setEncoding(encoding) { this.encoding = encoding; }
  write(text) { this.written.push(text); }
  setWindow(...size) { this.windows.push(size); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function fixture(overrides = {}) {
  const events = [], channels = [], requests = [];
  let mode = 'printable', destroyed = false;
  const client = {
    shell(options, callback) { requests.push(options); const channel = new Channel(); channels.push(channel); callback(null, channel); },
    destroy() { destroyed = true; },
  };
  const terminal = createSshTerminal({
    getClient: () => client, getTarget: () => 'server.example', getRoot: () => '/unused',
    getLogMode: () => mode, emit: event => events.push(event), createLog: async () => '/session.log',
    ...overrides,
  });
  return { terminal, channels, events, requests, client, setMode: value => mode = value, isDestroyed: () => destroyed };
}

test('SSH terminal reuses authenticated client with PTY, raw input, resize, stdout/stderr and independent close', async () => {
  const writes = [];
  const f = fixture({ fileSystem: { appendFile: async (...args) => writes.push(args) } });
  assert.equal(await f.terminal.open(120, 35), true);
  assert.deepEqual(f.requests, [{ term: 'xterm-256color', cols: 120, rows: 35 }]);
  assert.equal(f.channels[0].encoding, 'utf8');
  assert.equal(f.channels[0].stderr.encoding, 'utf8');
  assert.equal(f.events.at(-1).message, '已连接');
  assert.equal(f.events.at(-1).file, '/session.log');
  f.terminal.write('echo 测试\r'); f.terminal.write('\x03');
  f.terminal.resize(90, 20);
  assert.deepEqual(f.channels[0].written, ['echo 测试\r', '\x03']);
  assert.deepEqual(f.channels[0].windows, [[20, 90, 0, 0]]);
  f.channels[0].emit('data', '\x1b[31m中文\x1b[0m\r\n\x07');
  f.channels[0].stderr.emit('data', 'stderr\r\n');
  await f.terminal.drain();
  assert.deepEqual(writes.map(args => args[1]), ['中文\r\n', 'stderr\r\n']);
  assert.equal(f.events.filter(event => event.type === 'ssh-terminal-data').length, 2);
  f.terminal.close();
  assert.ok(f.channels[0].destroyed);
  assert.equal(f.events.at(-1).message, '已断开');
  assert.equal(f.isDestroyed(), false);
  assert.throws(() => f.terminal.write('closed'), /未连接/);
  assert.throws(() => f.terminal.resize(0, 20), /尺寸无效/);
  assert.throws(() => fixture({ getClient: () => undefined }).terminal.open(), /请先连接 SSH/);
});

test('SSH output recording respects none/all/printable and overwrite/export affect only current unique session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-terminal-'));
  const f = fixture({ getRoot: () => root, createLog: createSshLog });
  try {
    await f.terminal.open();
    const first = f.terminal.outputFile;
    f.channels[0].emit('data', 'older\n');
    await f.terminal.open();
    const second = f.terminal.outputFile;
    assert.notEqual(first, second);
    assert.equal(await readFile(first, 'utf8'), 'older\n');
    f.setMode('none'); f.channels[1].emit('data', 'ignored\n');
    f.setMode('all'); f.channels[1].emit('data', '\x1b[31mraw\x1b[0m\n');
    await f.terminal.drain();
    assert.equal(await readFile(second, 'utf8'), '\x1b[31mraw\x1b[0m\n');
    const overwriting = f.terminal.overwrite();
    f.setMode('printable'); f.channels[1].emit('data', '\x1b[32mcurrent\x1b[0m\n');
    await overwriting;
    const exported = path.join(root, 'export.log');
    await f.terminal.copyOutput(exported);
    assert.equal(await readFile(exported, 'utf8'), 'current\n');
    assert.equal(await readFile(first, 'utf8'), 'older\n');
    f.terminal.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSH session log paths are dated, unique and contain unsafe host strings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-terminal-path-'));
  try {
    const now = new Date(2026, 9, 24, 11, 22, 33);
    const first = await createSshLog(root, '192.168.1.2', now);
    const second = await createSshLog(root, '192.168.1.2', now);
    assert.equal(path.dirname(first), path.join(root, 'ssh', '2026-10-24', '192.168.1.2'));
    assert.notEqual(first, second);
    const named = await createSshLog(root, '机车1234--root@127.0.0.1_2220', now);
    assert.equal(path.basename(path.dirname(named)), '机车1234--root@127.0.0.1_2220');
    const unsafe = await createSshLog(root, '../../outside', now);
    assert.ok(unsafe.startsWith(path.join(root, 'ssh', '2026-10-24') + path.sep));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed SSH logging leaves the live terminal usable and emits a separate log error', async () => {
  const f = fixture({ fileSystem: { appendFile: async () => { throw new Error('disk full'); } } });
  await f.terminal.open();
  f.channels[0].emit('data', 'still displayed');
  await f.terminal.drain();
  assert.match(f.events.at(-1).message, /disk full/);
  assert.equal(f.events.at(-1).type, 'ssh-terminal-log-error');
  assert.equal(f.events.some(event => event.type === 'ssh-terminal-status' && event.message === '已断开'), false);
  f.terminal.write('still connected\r');
  f.terminal.close();
  const missingLog = fixture({ createLog: async () => { throw new Error('permission denied'); } });
  await missingLog.terminal.open();
  assert.equal(missingLog.events[0].type, 'ssh-terminal-log-error');
  assert.equal(missingLog.events.at(-1).message, '已连接');
  missingLog.terminal.close();
});

test('closing a pending SSH log setup prevents shell creation and drain waits for setup', async () => {
  const log = deferred();
  const f = fixture({ createLog: () => log.promise });
  const opening = f.terminal.open();
  await tick();
  f.terminal.close();
  await assert.rejects(opening, /已取消/);
  let drained = false;
  const draining = f.terminal.drain().then(() => drained = true);
  await tick(); assert.equal(drained, false);
  log.resolve('/late.log');
  await draining;
  assert.equal(f.requests.length, 0);
  assert.equal(f.terminal.outputFile, undefined);
  assert.equal(f.events.some(event => event.message === '已连接'), false);
});

test('late SSH shell callbacks cannot revive a closed terminal or overwrite the next session', async () => {
  const callbacks = [];
  const client = { shell: (_options, callback) => callbacks.push(callback) };
  const f = fixture({ getClient: () => client });
  const opening = f.terminal.open(); await tick();
  f.terminal.close(); await assert.rejects(opening, /已取消/);
  const nextOpening = f.terminal.open(); await tick();
  const late = new Channel(); callbacks[0](null, late);
  assert.equal(late.destroyed, true);
  late.emit('data', 'stale output');
  const next = new Channel(); callbacks[1](null, next);
  await nextOpening;
  assert.equal(f.events.filter(event => event.message === '已连接').length, 1);
  assert.equal(f.events.some(event => event.type === 'ssh-terminal-data'), false);
  f.terminal.close();
});

test('leaving Telnet preserves pending work and only explicit cancellation invalidates it', async () => {
  const closed = [];
  const modes = createTerminalMode({ closeSsh: () => closed.push('ssh'), closeTelnet: () => closed.push('telnet') });
  assert.equal(modes.mode, 'telnet');
  const token = modes.token();
  const gate = deferred();
  let connected = false;
  const pending = (async () => { await gate.promise; modes.check(token); connected = true; })();
  modes.select('ssh'); gate.resolve();
  await pending;
  assert.equal(connected, true);
  assert.deepEqual(closed, []);
  modes.select('telnet');
  const next = modes.token(); modes.cancel();
  assert.throws(() => modes.check(next), /已取消/);
  assert.deepEqual(closed, ['ssh']);
  assert.throws(() => modes.select('invalid'), /模式无效/);
});

test('SSH shell timeout rejects promptly and destroys a channel that arrives after timeout', async () => {
  let callback;
  const f = fixture({ shellTimeout: 10, getClient: () => ({ shell: (_options, done) => callback = done }) });
  await assert.rejects(f.terminal.open(), /连接超时/);
  const late = new Channel(); callback(null, late);
  assert.equal(late.destroyed, true);
  assert.equal(f.events.some(event => event.message === '已连接'), false);
  assert.throws(() => f.terminal.write('closed'), /未连接/);
});
