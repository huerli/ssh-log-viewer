import fixtureLock from './worker-fixture-lock.cjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import workerModule from '../electron/reverse-ssh-worker.cjs';

const { buildStopWorkerCommand, stopReverseSshWorker } = workerModule;
const linuxOnly = { skip: process.platform !== 'linux' };
const destination = { port: 28281, host: 'worker-fixture.invalid', sshPort: 2222 };
let directory, binary, sshBinary, compilerUnavailable = false;

let releaseFixtureLock;
before(async () => {
  if (process.platform !== 'linux') return;
  releaseFixtureLock = await fixtureLock.acquireWorkerFixtureLock();
  directory = await mkdtemp(path.join(os.tmpdir(), 'viewer-worker-'));
  binary = path.join(directory, 'reverse-ssh-worker');
  sshBinary = path.join(directory, 'ssh');
  const source = path.join(directory, 'fixture.c');
  // Real executable names and NUL-separated argv avoid relying on process titles
  // or installing a fixture at the production worker path.
  await writeFile(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  name = name ? name + 1 : argv[0];
  if (strcmp(name, "ssh") == 0) {
    int ready = atoi(argv[1]);
    write(ready, "r", 1);
    close(ready);
    for (;;) pause();
  }
  if (getenv("WORKER_FIXTURE_IGNORE_TERM")) signal(SIGTERM, SIG_IGN);
  int ready[2];
  if (pipe(ready) < 0) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    close(ready[0]);
    signal(SIGTERM, SIG_DFL);
    char fd[24];
    snprintf(fd, sizeof fd, "%d", ready[1]);
    execl(getenv("WORKER_FIXTURE_SSH_BINARY"), "ssh", fd, (char *)NULL);
    _exit(4);
  }
  close(ready[1]);
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 5;
  close(ready[0]);
  printf("%d\\n", child);
  fflush(stdout);
  for (;;) pause();
}
`);
  try { await promisify(execFile)('cc', ['-O0', '-o', binary, source]); }
  catch (error) {
    if (error.code === 'ENOENT') { compilerUnavailable = true; return; }
    throw error;
  }
  await copyFile(binary, sshBinary);
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function localClient() {
  const client = new EventEmitter();
  client.exec = (command, callback) => {
    const process = spawn('sh', ['-c', command]);
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

async function alive(pid) {
  try { return !/^State:\s+[ZX]/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t, options = {}) {
  if (compilerUnavailable) { t.skip('C compiler is unavailable for isolated process fixtures'); return; }
  const args = [String(options.port ?? destination.port), options.host ?? destination.host, String(options.sshPort ?? destination.sshPort)];
  const child = spawn(binary, args, {
    argv0: options.argv0 ?? '/usr/local/sbin/reverse-ssh-worker',
    env: { ...process.env, WORKER_FIXTURE_SSH_BINARY: sshBinary, ...(options.ignoreTerm ? { WORKER_FIXTURE_IGNORE_TERM: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sshPid;
  t.after(async () => {
    child.kill('SIGKILL');
    if (sshPid) { try { process.kill(sshPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  });
  sshPid = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Worker fixture startup timed out')), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker fixture exited before startup: ${code}`)); });
  });
  return { child, sshPid };
}

function mockedClient(reply) {
  const client = new EventEmitter();
  client.exec = (_command, callback) => {
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.close = () => {};
    callback(null, channel);
    queueMicrotask(() => reply(client, channel));
  };
  return client;
}

test('validates worker endpoint ports before requesting remote exec', async () => {
  let invoked = false;
  const client = { exec() { invoked = true; } };
  for (const field of ['port', 'sshPort']) {
    for (const value of [0, -1, 65536, 1.5, '2222', NaN]) {
      const options = { ...destination, [field]: value };
      assert.throws(() => buildStopWorkerCommand(options), /端口无效/);
      await assert.rejects(stopReverseSshWorker(client, options), /端口无效/);
    }
  }
  assert.equal(invoked, false);
  assert.doesNotThrow(() => buildStopWorkerCommand());
});

test('an absent matching worker is a successful no-op', linuxOnly, async () => {
  assert.equal((await stopReverseSshWorker(localClient(), destination)).stopped, false);
});

test('a unique direct worker and its SSH child stop, while other processes survive', linuxOnly, async t => {
  const worker = await fixture(t);
  if (!worker) return;
  const unrelated = spawn('sleep', ['30']);
  t.after(() => unrelated.kill('SIGKILL'));
  assert.equal((await stopReverseSshWorker(localClient())).stopped, true);
  assert.equal(await alive(worker.child.pid), false);
  assert.equal(await alive(worker.sshPid), false);
  assert.equal(await alive(unrelated.pid), true);
});

test('multiple direct workers are rejected without stopping workers or their SSH children', linuxOnly, async t => {
  const first = await fixture(t);
  if (!first) return;
  const second = await fixture(t, { port: destination.port + 1 });
  await assert.rejects(stopReverseSshWorker(localClient()), /多个|唯一/);
  for (const worker of [first, second]) {
    assert.equal(await alive(worker.child.pid), true);
    assert.equal(await alive(worker.sshPid), true);
  }
});

test('endpoint filtering distinguishes workers sharing a port or destination', linuxOnly, async t => {
  const target = await fixture(t);
  if (!target) return;
  const otherHost = await fixture(t, { host: 'other-worker-fixture.invalid' });
  const otherSshPort = await fixture(t, { sshPort: destination.sshPort + 1 });
  const otherPort = await fixture(t, { port: destination.port + 1 });
  assert.equal((await stopReverseSshWorker(localClient(), destination)).stopped, true);
  assert.equal(await alive(target.child.pid), false);
  assert.equal(await alive(target.sshPid), false);
  for (const worker of [otherHost, otherSshPort, otherPort]) {
    assert.equal(await alive(worker.child.pid), true);
    assert.equal(await alive(worker.sshPid), true);
  }
});

test('an unmatched destination sharing the reverse port is reported without stopping anything', linuxOnly, async t => {
  const worker = await fixture(t, { host: 'alias-worker-fixture.invalid' });
  if (!worker) return;
  await assert.rejects(stopReverseSshWorker(localClient(), destination), /不匹配|地址.*端口/);
  assert.equal(await alive(worker.child.pid), true);
  assert.equal(await alive(worker.sshPid), true);
});

test('a worker that ignores TERM keeps its SSH child and never receives KILL', linuxOnly, async t => {
  const worker = await fixture(t, { ignoreTerm: true });
  if (!worker) return;
  await assert.rejects(stopReverseSshWorker(localClient(), destination), /未响应|未退出|仍在运行/);
  assert.equal(await alive(worker.child.pid), true);
  assert.equal(await alive(worker.sshPid), true);
  assert.doesNotMatch(await readFile(`/proc/${worker.child.pid}/status`, 'utf8'), /^State:\s+T/m, 'a failed cleanup must resume the paused worker');
});

test('a similarly named argv path is never treated as the production worker', linuxOnly, async t => {
  const worker = await fixture(t, { argv0: '/tmp/reverse-ssh-worker' });
  if (!worker) return;
  assert.equal((await stopReverseSshWorker(localClient(), destination)).stopped, false);
  assert.equal(await alive(worker.child.pid), true);
  assert.equal(await alive(worker.sshPid), true);
});

test('tunneled disconnect after the parent-stopped handshake is expected', async () => {
  const client = mockedClient((connection, channel) => {
    channel.emit('data', 'REVERSE_WORKER_PARENT_');
    channel.emit('data', 'STOPPED\n');
    connection.emit('close');
    channel.emit('close', undefined);
  });
  assert.equal((await stopReverseSshWorker(client, { ...destination, tunneled: true })).stopped, true);
  assert.equal(client.listenerCount('close'), 0);
});

test('a tunneled close after only a stop request reports unverified stopping', async () => {
  const client = mockedClient((connection, channel) => {
    channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
    connection.emit('close');
  });
  assert.deepEqual(await stopReverseSshWorker(client, { ...destination, tunneled: true }), {
    stopped: false, stopRequested: true, verificationPending: true,
  });
});

test('a reported failing exit status remains a failure after a tunneled stop request', async () => {
  const client = mockedClient((_connection, channel) => {
    channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
    channel.emit('close', 1);
  });
  await assert.rejects(stopReverseSshWorker(client, { ...destination, tunneled: true }), /失败/);
});

test('disconnect before the handshake and direct disconnect after it remain failures', async () => {
  const early = mockedClient(connection => connection.emit('close'));
  await assert.rejects(stopReverseSshWorker(early, { ...destination, tunneled: true }), /提前关闭|无法确认/);
  const direct = mockedClient((connection, channel) => {
    channel.emit('data', 'REVERSE_WORKER_PARENT_STOPPED\n');
    connection.emit('close');
  });
  await assert.rejects(stopReverseSshWorker(direct), /提前关闭|无法确认/);
});

test('exec failures and missing or unsuccessful completion output are reported', async () => {
  await assert.rejects(stopReverseSshWorker({ exec: (_command, done) => done(new Error('fixture permission denied')) }), /fixture permission denied/);
  await assert.rejects(stopReverseSshWorker(mockedClient((_client, channel) => {
    channel.emit('data', 'unrecognized result\n');
    channel.emit('close', 0);
  })), /有效|结果/);
  await assert.rejects(stopReverseSshWorker(mockedClient((_client, channel) => {
    channel.stderr.emit('data', 'fixture worker stop denied');
    channel.emit('close', 1);
  })), /fixture worker stop denied/);
  assert.equal((await stopReverseSshWorker(mockedClient((_client, channel) => {
    channel.emit('data', 'REVERSE_WORKER_STOPPED\n');
    channel.emit('close', 0);
  }))).stopped, true);
});

after(async () => { await releaseFixtureLock?.(); });
