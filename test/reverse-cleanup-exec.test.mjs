import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import cleanup from '../electron/reverse-cleanup-exec.cjs';

const { runReverseCleanup } = cleanup;

function fixture({ late = false } = {}) {
  const client = new EventEmitter();
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  let callback, closes = 0;
  channel.close = () => { closes += 1; };
  client.exec = (command, done) => {
    assert.equal(command, 'fixture command');
    callback = done;
    if (!late) callback(null, channel);
  };
  return { client, channel, get closes() { return closes; }, callback: (...args) => callback(...args) };
}

function assertClean(f) {
  for (const [target, events] of [[f.client, ['close', 'error']], [f.channel, ['data', 'exit']], [f.channel.stderr, ['data']]]) {
    for (const event of events) assert.equal(target.listenerCount(event), 0, `leaked ${event} listener`);
  }
  // Still-open channels have only an error guard, which releases on close.
  assert.ok(f.channel.listenerCount('error') <= 1);
  assert.equal(f.channel.listenerCount('close'), f.channel.listenerCount('error'));
  f.channel.emit('close', 0);
  assert.equal(f.channel.listenerCount('error'), 0);
  assert.equal(f.channel.listenerCount('close'), 0);
}

for (const prefix of ['REVERSE_WORKER', 'REVERSE_SSH']) {
  for (const [marker, stopped] of [['STOPPED', true], ['ABSENT', false]]) {
    test(`${prefix}_${marker} completes without channel close`, async () => {
      const f = fixture();
      const result = runReverseCleanup(f.client, 'fixture command');
      f.channel.emit('data', `${prefix}_${marker}\n`);
      assert.deepEqual(await result, { stopped });
      assert.equal(f.closes, 0);
      assertClean(f);
    });
  }
}

test('accepts split markers and CRLF only after the complete marker line', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let settled = false;
  const result = runReverseCleanup(f.client, 'fixture command').then(value => { settled = true; return value; });
  f.channel.emit('data', Buffer.from('diagnostic line\nREVERSE_WORKER_ST'));
  f.channel.emit('data', Buffer.from('OPPED\r'));
  await Promise.resolve();
  assert.equal(settled, false);
  f.channel.emit('data', Buffer.from('\n'));
  assert.deepEqual(await result, { stopped: true });
  t.mock.timers.tick(20000);
  assertClean(f);
});

test('an unterminated or embedded completion token is not confirmation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  f.channel.emit('data', 'prefix REVERSE_WORKER_STOPPED\nREVERSE_WORKER_STOPPED');
  f.channel.emit('close', 0);
  await assert.rejects(result, /有效.*结果/);
  assertClean(f);
});

test('discovery may take up to twenty seconds without the old six-second failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  t.mock.timers.tick(19999);
  f.channel.emit('data', 'REVERSE_WORKER_ABSENT\n');
  assert.deepEqual(await result, { stopped: false });
});

test('discovery timeout fails and closes the command channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  t.mock.timers.tick(20000);
  await assert.rejects(result, /超时（20 秒）/);
  assert.equal(f.closes, 1);
  assertClean(f);
});

for (const prefix of ['REVERSE_WORKER', 'REVERSE_SSH']) {
  test(`${prefix} tunneled request with a hanging channel becomes pending after six seconds`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    let settled = false;
    const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true }).then(value => { settled = true; return value; });
    t.mock.timers.tick(19000);
    f.channel.emit('data', `${prefix}_STOP_REQUESTED\n`);
    t.mock.timers.tick(5999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await result, { stopped: false, stopRequested: true, verificationPending: true });
    assert.equal(f.closes, 0, 'pending success must leave scheduled remote signals alive');
    assertClean(f);
  });
}

test('parent acknowledgement is reflected in pending tunnel verification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_PARENT_STOPPED\n');
  t.mock.timers.tick(6000);
  assert.deepEqual(await result, { stopped: true, stopRequested: true, verificationPending: true });
  assert.equal(f.closes, 0);
});

test('duplicate acknowledgements do not extend the stop deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  t.mock.timers.tick(5999);
  f.channel.emit('data', 'REVERSE_WORKER_PARENT_STOPPED\n');
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { stopped: true, stopRequested: true, verificationPending: true });
});

test('direct request without final confirmation remains a failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  t.mock.timers.tick(6000);
  await assert.rejects(result, /超时（6 秒）/);
  assert.equal(f.closes, 1);
  assertClean(f);
});

for (const [target, event, args] of [['client', 'close', []], ['channel', 'close', [undefined]], ['channel', 'error', [new Error('connection lost')]]]) {
  test(`tunneled ${target} ${event} after acknowledgement is expected`, async () => {
    const f = fixture();
    const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
    f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
    f[target].emit(event, ...args);
    assert.deepEqual(await result, { stopped: false, stopRequested: true, verificationPending: true });
    assert.equal(f.closes, 0);
    assertClean(f);
  });
}

for (const code of [1, 255, 'unknown']) {
  test(`failure status ${code} remains a failure after a stop request`, async () => {
    const f = fixture();
    const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
    f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
    f.channel.emit('close', code);
    await assert.rejects(result, /失败/);
    assertClean(f);
  });
}

test('nonzero exit is rejected before a later tunnel disconnect', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  f.channel.emit('exit', 1);
  f.client.emit('close');
  await assert.rejects(result, /失败/);
});

test('stderr delivered after the failed exit event is retained until close', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  f.channel.emit('exit', 1);
  f.channel.stderr.emit('data', 'worker denied\n');
  f.channel.emit('close', 1);
  await assert.rejects(result, /worker denied/);
  assertClean(f);
});

test('a failed exit never becomes completion success and its drain wait is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  f.channel.emit('exit', 1);
  f.channel.emit('data', 'REVERSE_WORKER_STOPPED\n');
  f.channel.stderr.emit('data', 'worker denied\n');
  t.mock.timers.tick(250);
  await assert.rejects(result, /worker denied/);
  assertClean(f);
});

test('a failed exit followed by missing close status cannot become pending success', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  f.channel.emit('exit', 1);
  f.channel.emit('close', undefined);
  await assert.rejects(result, /失败/);
  assertClean(f);
});

test('stderr diagnostics cannot become a completion or pending success', async () => {
  for (const event of ['completion', 'disconnect']) {
    const f = fixture();
    const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
    f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
    f.channel.stderr.emit('data', 'fixture worker stop denied\n');
    if (event === 'completion') f.channel.emit('data', 'REVERSE_WORKER_STOPPED\n');
    else f.client.emit('close');
    await assert.rejects(result, /fixture worker stop denied/);
    assertClean(f);
  }
});

test('completion markers on stderr are not trusted', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  f.channel.stderr.emit('data', 'REVERSE_WORKER_STOPPED\n');
  f.channel.emit('close', 0);
  await assert.rejects(result);
});

test('premature disconnect and direct disconnect after acknowledgement fail', async () => {
  for (const acknowledged of [false, true]) {
    const f = fixture();
    const result = runReverseCleanup(f.client, 'fixture command', { tunneled: !acknowledged });
    if (acknowledged) f.channel.emit('data', 'REVERSE_WORKER_PARENT_STOPPED\n');
    f.client.emit('close');
    await assert.rejects(result, /提前关闭|无法确认/);
    assertClean(f);
  }
});

test('combined stdout and stderr are bounded to sixteen KiB in bytes', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  f.channel.emit('data', Buffer.alloc(16380, 120));
  f.channel.stderr.emit('data', '中文');
  await assert.rejects(result, /输出异常/);
  assertClean(f);
});

test('a late exec callback is closed after timeout and releases listeners on close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ late: true });
  const result = runReverseCleanup(f.client, 'fixture command');
  t.mock.timers.tick(20000);
  await assert.rejects(result, /超时/);
  f.callback(null, f.channel);
  assert.equal(f.closes, 1);
  assertClean(f);
});

test('exec callback errors and synchronous throws clean up client listeners', async () => {
  for (const synchronous of [false, true]) {
    const f = fixture({ late: true });
    if (synchronous) f.client.exec = () => { throw new Error('fixture exec throw'); };
    const result = runReverseCleanup(f.client, 'fixture command');
    if (!synchronous) f.callback(new Error('fixture exec denied'));
    await assert.rejects(result, /fixture exec/);
    assertClean(f);
  }
});

test('progress reports stages as strings and observer exceptions do not break cleanup', async () => {
  const f = fixture();
  const progress = [];
  const result = runReverseCleanup(f.client, 'fixture command', { onProgress(message) { progress.push(message); throw new Error('observer failure'); } });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\nREVERSE_WORKER_PARENT_STOPPED\nREVERSE_WORKER_STOPPED\n');
  assert.deepEqual(await result, { stopped: true });
  assert.equal(progress.length, 4);
  assert.ok(progress.every(message => typeof message === 'string' && message.length));
  assertClean(f);
});

test('an open completed channel tolerates late errors until close releases its guard', async () => {
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command');
  f.channel.emit('data', 'REVERSE_WORKER_STOPPED\n');
  assert.deepEqual(await result, { stopped: true });
  assert.equal(f.closes, 0);
  assert.doesNotThrow(() => f.channel.emit('error', new Error('late tunnel error')));
  assert.doesNotThrow(() => f.channel.emit('error', new Error('another late error')));
  assertClean(f);
});

test('a pending channel tolerates late errors without closing before delayed remote signals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const result = runReverseCleanup(f.client, 'fixture command', { tunneled: true });
  f.channel.emit('data', 'REVERSE_WORKER_STOP_REQUESTED\n');
  t.mock.timers.tick(6000);
  assert.equal((await result).verificationPending, true);
  assert.doesNotThrow(() => f.channel.emit('error', new Error('expected tunnel disconnect')));
  assert.equal(f.closes, 0);
  assertClean(f);
});

test('a channel arriving after timeout is guarded while close is in flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ late: true });
  const result = runReverseCleanup(f.client, 'fixture command');
  t.mock.timers.tick(20000);
  await assert.rejects(result, /超时/);
  f.callback(null, f.channel);
  assert.equal(f.closes, 1);
  assert.doesNotThrow(() => f.channel.emit('error', new Error('late channel failure')));
  assertClean(f);
});
