import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCommandStream } from '../shared/command-stream.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sends in order, waits between writes, and completes once', async () => {
  const sent = [], times = [];
  let completed = 0;
  await new Promise((resolve, reject) => startCommandStream({
    commands: ['first', 'second'], interval: 10, repeat: false,
    send: async command => { sent.push(command); times.push(Date.now()); },
    onProgress: count => assert.equal(count, sent.length),
    onDone: () => { completed++; resolve(); }, onError: reject,
  }));
  assert.deepEqual(sent, ['first', 'second']);
  assert.ok(times[1] - times[0] >= 8);
  assert.equal(completed, 1);
});

test('stop during an in-flight write prevents further sends and progress', async () => {
  let release, sent = 0, progress = 0;
  const stop = startCommandStream({ commands: ['one', 'two'], interval: 100, repeat: true,
    send: () => { sent++; return new Promise(resolve => { release = resolve; }); },
    onProgress: () => progress++, onDone: () => assert.fail('unexpected completion'), onError: assert.fail,
  });
  stop(); release(); await wait(130);
  assert.equal(sent, 1); assert.equal(progress, 0);
});

test('repeat wraps the list and write failures stop the stream', async () => {
  const sent = [];
  const error = await new Promise(resolve => startCommandStream({ commands: ['a', 'b'], interval: 100, repeat: true,
    send: async command => { sent.push(command); if (sent.length === 3) throw new Error('disconnected'); },
    onProgress: () => {}, onDone: () => assert.fail('unexpected completion'), onError: resolve,
  }));
  await wait(130);
  assert.deepEqual(sent, ['a', 'b', 'a']); assert.match(error.message, /disconnected/);
});

test('rejects invalid intervals and empty lists', () => {
  for (const interval of [0, 9, NaN, Infinity, 86400001]) assert.throws(() => startCommandStream({ commands: ['a'], interval }));
  assert.throws(() => startCommandStream({ commands: [], interval: 100 }));
});

test('uses each step interval including the loop boundary and snapshots the queue', async () => {
  const commands = [{text: 'a', interval: 100}, {text: 'b', interval: 240}];
  const sent = [], times = [];
  let stop;
  await new Promise((resolve, reject) => {
    stop = startCommandStream({ commands, repeat: true,
      send: async command => { sent.push(command); times.push(Date.now()); },
      onProgress: count => { if (count === 3) { stop(); resolve(); } },
      onDone: () => assert.fail('unexpected completion'), onError: reject,
    });
    commands[1].text = 'changed'; commands[1].interval = 100;
  });
  assert.deepEqual(sent, ['a', 'b', 'a']);
  assert.ok(times[1] - times[0] >= 90);
  assert.ok(times[2] - times[1] >= 230);
  await wait(130); assert.equal(sent.length, 3);
});

test('validates every step before sending the first command', () => {
  let sent = false;
  assert.throws(() => startCommandStream({commands: [{text: 'ok', interval: 100}, {text: 'bad', interval: 0}], send: () => { sent = true; }}));
  assert.equal(sent, false);
});
