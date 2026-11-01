import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReliableDbTime } from '../shared/reliable-db.mjs';
test('converts Unix seconds using local timezone with explicit UTC offset', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    assert.equal(formatReliableDbTime(0), '1970-01-01 08:00:00 UTC+08:00');
    assert.equal(formatReliableDbTime(0x6ae58c4f), '2026-10-31 14:35:59 UTC+08:00');
    process.env.TZ = 'America/New_York';
    assert.equal(formatReliableDbTime(0), '1969-12-31 19:00:00 UTC-05:00');
    assert.equal(formatReliableDbTime(undefined), '—');
    assert.equal(formatReliableDbTime(NaN), '—');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
