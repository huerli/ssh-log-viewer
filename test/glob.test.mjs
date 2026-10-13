import test from 'node:test';
import assert from 'node:assert/strict';
import { filenamePattern } from '../shared/glob.mjs';
test('filename wildcard matches literal punctuation and never accepts paths', () => {
  const pattern = filenamePattern('signal.2026-10-12.*');
  assert.ok(pattern.test('signal.2026-10-12.01.log')); assert.ok(pattern.test('signal.2026-10-12.02.log.gz'));
  assert.ok(!pattern.test('signalX2026-10-12.01.log')); assert.ok(!pattern.test('signal.2026-10-13.01.log'));
  assert.ok(filenamePattern('中文[1]?.log').test('中文[1]a.log'));
  for (const value of ['../*.log', 'a\\\\b', 'x\ny', 'a'.repeat(257)]) assert.throws(() => filenamePattern(value));
});

test('date fragments include log/gzip suffixes while complete filenames stay exact', () => {
  for (const fragment of ['*10-13', '10-13', '2026-10-13', 'signal.2026-10-13']) {
    const matcher = filenamePattern(fragment);
    assert.ok(matcher.test('signal.2026-10-13.log'));
    assert.ok(matcher.test('signal.2026-10-13.01.log.gz'));
    assert.ok(!matcher.test('signal.2026-10-12.log.gz'));
  }
  assert.ok(filenamePattern('wdg').test('wdg.2026-10-13.log.gz'));
  assert.ok(!filenamePattern('cancel.log').test('other-cancel.log'));
  assert.ok(!filenamePattern('signal.2026-10-13.log').test('signal.2026-10-13.log.gz'));
  assert.ok(!filenamePattern('signal*').test('other-signal.log'));
});
