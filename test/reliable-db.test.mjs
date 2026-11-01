import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReliableDb, stateName } from '../shared/reliable-db.mjs';
function slot(size = 128, little = true, type = 0, state = 254) {
  const bytes = new Uint8Array(size).fill(255), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x12345678, little); bytes[4] = state;
  v.setUint16(6, 19, little); bytes[8] = type; bytes[9] = 0; bytes[10] = bytes[11] = 0;
  v.setUint32(12, 0x87654321, little); v.setUint32(16, 0xaabbccdd, little); v.setUint32(20, 0x11223344, little);
  bytes.set([0x12, 0x34, 0x56], 24); return bytes;
}
test('decodes both byte orders and preserves identifiers/body without padding', () => {
  for (const little of [true, false]) {
    const bytes = new Uint8Array(130); bytes.set(slot(128, little), 2);
    const r = parseReliableDb(bytes.subarray(2), 128, little).records[0];
    assert.equal(r.dbSeq, 0x12345678); assert.equal(r.seq, 0x87654321);
    assert.equal(r.serial, 0xaabbccdd); assert.equal(r.time, 0x11223344);
    assert.deepEqual([...r.body], [0x12, 0x34, 0x56]); assert.deepEqual(r.issues, []);
    assert.equal(r.uniq.split(' ').length, 12);
  }
});
test('skips erased slots, retains offsets and distinct reply states', () => {
  const bytes = new Uint8Array(512).fill(255); bytes.set(slot(128, true, 1, 0), 128); bytes.set(slot(128, true, 3, 7), 384);
  const parsed = parseReliableDb(bytes);
  assert.equal(parsed.empty, 2); assert.equal(parsed.slots, 4);
  assert.deepEqual(parsed.records.map(r => r.offset), [128, 384]);
  assert.equal(parsed.records[1].errcode, 0); assert.match(stateName(parsed.records[1].state), /错误回复/);
  assert.equal(stateName(254), '待确认'); assert.equal(stateName(0), '成功回复');
});
test('256-byte whole records and invalid lengths/types/truncation', () => {
  assert.deepEqual(parseReliableDb(slot(256, true, 2), 256).records[0].issues, []);
  for (const length of [0, 15, 121, 65535]) {
    const bytes = slot(); new DataView(bytes.buffer).setUint16(6, length, true);
    const r = parseReliableDb(bytes).records[0]; assert.ok(r.issues.length); assert.equal(r.body, undefined);
  }
  assert.ok(parseReliableDb(slot(128, true, 99)).records[0].issues.length);
  for (let length = 1; length < 128; length++) assert.ok(parseReliableDb(slot().slice(0, length)).records[0].issues.length);
  assert.equal(parseReliableDb(new Uint8Array()).slots, 0);
  assert.throws(() => parseReliableDb(slot(), 64));
});
