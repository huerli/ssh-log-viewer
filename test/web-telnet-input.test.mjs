import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { normalizeWebInput } = createRequire(import.meta.url)('../electron/web-telnet.cjs');
test('Web terminal and shortcut input use the backend command framing', () => {
  assert.equal(normalizeWebInput('dev-get-info\n'), 'send dev-get-info\r\n');
  assert.equal(normalizeWebInput('send dev-get-info\r\n'), 'send dev-get-info\r\n');
  for (const command of ['help', 'history', 'quit']) assert.equal(normalizeWebInput(command + '\n'), command + '\r\n');
  assert.equal(normalizeWebInput('\x03'), '\x03');
  assert.equal(normalizeWebInput('\n'), '\r\n');
});
