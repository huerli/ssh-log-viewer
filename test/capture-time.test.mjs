import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { formatCaptureTimestamp } from '../shared/capture-time.mjs';

test('capture dates retain microseconds and handle epoch, negative values and carry', () => {
  assert.equal(formatCaptureTimestamp(1794287023.009509, true), '2026-11-10 05:03:43.009509');
  assert.equal(formatCaptureTimestamp(0, true), '1970-01-01 00:00:00.000000');
  assert.equal(formatCaptureTimestamp(-0.000001, true), '1969-12-31 23:59:59.999999');
  assert.equal(formatCaptureTimestamp(0.9999999, true), '1970-01-01 00:00:01.000000');
  for (const value of [null, NaN, Infinity, 9e12]) assert.equal(formatCaptureTimestamp(value, true), '—');
});

test('local display uses the capture date timezone offset, including DST and fractional offsets', () => {
  const module = new URL('../shared/capture-time.mjs', import.meta.url).href;
  const run = (zone, time) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {formatCaptureTimestamp,captureUtcOffset} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify([formatCaptureTimestamp(${time}),captureUtcOffset(${time})]));`], { env: { ...process.env, TZ: zone }, encoding: 'utf8' }));
  assert.deepEqual(run('Asia/Singapore', 1794287023.009509), ['2026-11-10 13:03:43.009509', 'UTC+08:00']);
  assert.deepEqual(run('Asia/Kolkata', 0), ['1970-01-01 05:30:00.000000', 'UTC+05:30']);
  assert.deepEqual(run('America/New_York', 1704067200), ['2023-12-31 19:00:00.000000', 'UTC-05:00']);
  assert.deepEqual(run('America/New_York', 1719792000), ['2024-06-30 20:00:00.000000', 'UTC-04:00']);
});
