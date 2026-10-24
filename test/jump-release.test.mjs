import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import sessionModule from '../electron/ssh-session.cjs';
import targetFixture from './ssh-fixture.cjs';
import jumpFixture from './jump-fixture.cjs';

const { connectSession } = sessionModule;
const { createServer } = targetFixture;
const { createJump, reverseTunnel } = jumpFixture;
const profile = (port, jumpPort) => ({ host: '127.0.0.1', port, username: 'tester', auth: 'password', password: 'fixture-password', jump: { enabled: true, host: '127.0.0.1', port: jumpPort, username: 'jumper', auth: 'password', password: 'jump-password' } });
const options = () => ({ signal: new AbortController().signal, verify: (_identity, _role, _hash, callback) => callback(true) });
const realpath = session => new Promise((resolve, reject) => session.sftp.realpath('/system/log', (error, value) => error ? reject(error) : resolve(value)));
const listening = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
const reply = (stream, output, code = 0) => { stream.write(output); stream.exit(code); stream.end(); };

async function fixture(run, exec) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-release-'));
  let target, jump, reverse, unrelated, session;
  try {
    await mkdir(path.join(root, 'system/log'), { recursive: true });
    target = await createServer(root);
    jump = await createJump([], { exec });
    reverse = await reverseTunnel(jump, target.port);
    unrelated = await reverseTunnel(jump, target.port);
    session = await connectSession(profile(reverse.port, jump.port), options());
    await run({ target, jump, reverse, unrelated, session });
  } finally {
    session?.close(); reverse?.close(); unrelated?.close();
    if (jump) await jump.close();
    if (target) await target.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('explicit jump release waits for remote exec while authenticated and frees only its target listener', async () => {
  let context, finishExec, execStarted;
  const started = new Promise(resolve => { execStarted = resolve; });
  const gate = new Promise(resolve => { finishExec = resolve; });
  await fixture(async value => {
    context = value;
    const { session, jump, reverse, unrelated } = value;
    assert.equal(await realpath(session), '/system/log');
    let completed = false;
    const releasing = session.releaseJumpPort().then(() => { completed = true; });
    await started;
    assert.equal(completed, false, 'release awaits remote completion');
    assert.equal(session.jump._sock.destroyed, false, 'jump connection remains open to run cleanup');
    assert.equal(await listening(reverse.port), true, 'listener remains bound until remote cleanup');
    finishExec();
    await releasing;
    assert.equal(await listening(reverse.port), false, 'selected reverse listener is released');
    assert.equal(await listening(unrelated.port), true, 'unrelated reverse listener remains bound');
    assert.equal(jump.commands.length, 1);
    session.close();
    assert.equal(jump.events[0].type, 'exec', 'remote cleanup precedes connection teardown');
  }, async ({ command, stream, client, clients, forwards }) => {
    assert.ok(clients.has(client), 'remote exec runs on a live jump connection');
    execStarted();
    await gate;
    assert.ok(command.includes(String(context.reverse.port)), 'cleanup selects the target port');
    const owner = forwards.get(context.reverse.port);
    const closed = new Promise(resolve => owner.listener.once('close', resolve));
    owner.client.end(); // Simulate stopping the device's SSH process, including its active channels.
    await closed;
    reply(stream, 'JUMP_PORT_RELEASED\n');
  });
});

test('ordinary session close preserves the device reverse tunnel and executes no remote cleanup', async () => {
  await fixture(async ({ session, jump, reverse, unrelated }) => {
    session.close();
    assert.equal(await listening(reverse.port), true);
    assert.equal(await listening(unrelated.port), true);
    assert.deepEqual(jump.commands, []);
  }, () => { assert.fail('ordinary close must not invoke remote exec'); });
});

test('a rejected remote release keeps normal session close usable', async () => {
  await fixture(async ({ session, jump, reverse }) => {
    await assert.rejects(session.releaseJumpPort(), /fixture cleanup denied/);
    assert.equal(await listening(reverse.port), true);
    assert.equal(await realpath(session), '/system/log');
    session.close();
    assert.equal(jump.commands.length, 1);
  }, ({ stream }) => {
    stream.stderr.write('fixture cleanup denied');
    reply(stream, '', 1);
  });
});

test('an already absent listener is a successful no-op and the session can still close', async () => {
  await fixture(async ({ session, jump }) => {
    const result = await session.releaseJumpPort();
    assert.equal(result.released, false);
    assert.equal(jump.commands.length, 1);
    session.close();
  }, ({ stream }) => reply(stream, 'JUMP_PORT_ABSENT\n'));
});

test('a direct SSH session does not attempt jump cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-direct-release-'));
  let target, session;
  try {
    target = await createServer(root);
    const direct = profile(target.port, 1); delete direct.jump;
    session = await connectSession(direct, options());
    const result = await session.releaseJumpPort();
    assert.equal(result.released, false);
    session.close();
  } finally {
    session?.close(); if (target) await target.close();
    await rm(root, { recursive: true, force: true });
  }
});
