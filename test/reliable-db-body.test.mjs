import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseReliableDb } from '../shared/reliable-db.mjs';
import { decodeReliableBody } from '../shared/reliable-db-body.mjs';
test('whole record matches existing native decoder fixture field by field', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/reliable-wholercd.bin', import.meta.url)));
  const expected = JSON.parse(await readFile(new URL('./fixtures/reliable-wholercd.json', import.meta.url), 'utf8')).data[0].body;
  const record = parseReliableDb(bytes, 256).records[0];
  const result = decodeReliableBody(record.type, record.body);
  assert.equal(result.error, undefined);
  for (const fields of Object.values(expected)) for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    assert.equal(result.fields.find(field => field.key === key)?.value, value, key);
  }
});
test('alarm and event decode Chinese comments, signed coordinates and endianness', () => {
  for (const type of [0, 1]) for (const little of [true, false]) {
    const start = type === 0 ? 48 : 36;
    const text = new TextEncoder().encode('搜星恢复');
    const bytes = new Uint8Array(start + text.length);
    const view = new DataView(bytes.buffer);
    bytes[start - 1] = text.length; bytes.set(text, start);
    view.setInt32(type === 0 ? 28 : 16, -104, little);
    const result = decodeReliableBody(type, bytes, little);
    assert.equal(result.error, undefined);
    assert.equal(result.fields.find(field => field.key === 'longi').value, -104);
    assert.equal(result.fields.find(field => field.key === 'comment').value, '搜星恢复');
    bytes[start - 1] = 255;
    assert.match(decodeReliableBody(type, bytes, little).error, /超出业务体长度/);
  }
});
test('truncation and unsupported business types stay explicit', () => {
  assert.match(decodeReliableBody(2, new Uint8Array(2)).error, /超出业务体长度/);
  assert.match(decodeReliableBody(3, new Uint8Array(20)).error, /暂无字段定义/);
  assert.match(decodeReliableBody(0, undefined).error, /长度异常/);
});
test('tail detail preserves text and escapes binary control bytes', async () => {
  const { describeReliableTail } = await import('../shared/reliable-db-body.mjs');
  const text = describeReliableTail(new TextEncoder().encode('详情内容'));
  assert.equal(text.text, '详情内容');
  const bytes = Uint8Array.from([0x32, 0x88, 0xe6, 0x6a, 0, 0, 0, 0]);
  assert.equal(describeReliableTail(bytes).firstValue, 0x6ae68832);
  assert.match(describeReliableTail(bytes).text, /\\x00\\x00\\x00\\x00$/);
  assert.equal(describeReliableTail(new Uint8Array()), undefined);
});
