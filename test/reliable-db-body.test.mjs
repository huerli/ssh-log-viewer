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
  assert.match(decodeReliableBody(2, new Uint8Array(36)).error, /全程记录内容缺失/);
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

test('whole record decodes TAX time and event fields within the declared detail', () => {
  for (const little of [true, false]) {
    const body = new Uint8Array(128);
    const view = new DataView(body.buffer);
    body[36] = 23;
    view.setInt32(40, -65138, little);
    view.setUint32(88, 1780991858, little);
    body[103] = 23;
    body.set(new TextEncoder().encode('防控点'), 104);
    view.setUint16(125, 321, little);
    body[127] = 0xff;
    const result = decodeReliableBody(2, body, little);
    const values = Object.fromEntries(result.fields.map(field => [field.key, field.value]));
    assert.equal(result.error, undefined);
    assert.equal(values.kmpos, -65138);
    assert.equal(values.get_tax_time, 1780991858);
    assert.equal(values.detail_len, 23);
    assert.equal(values.point_name, '防控点');
    assert.equal(values.distance, 321);
    assert.deepEqual(result.remaining, Uint8Array.of(255));

    assert.match(decodeReliableBody(2, body.subarray(0, 126), little).error, /明细长度异常/);
    body[36] = 254;
    assert.deepEqual(decodeReliableBody(2, body, little).remaining, body.slice(104));
  }
});

test('portable records decode the train number and UI operation result', () => {
  const body = new Uint8Array(108);
  body[36] = 21;
  body.set(new TextEncoder().encode('K1096'), 88);
  body[103] = 4;
  body.set([5, 1, 112, 0], 104);
  const { fields, error } = decodeReliableBody(2, body, true, true);
  assert.equal(error, undefined);
  assert.equal(fields.find(field => field.key === 'portable_train_no')?.value, 'K1096');
  assert.equal(fields.find(field => field.key === 'get_tax_time'), undefined);
  assert.equal(fields.find(field => field.key === 'operate_result')?.description, '进入推进');
  assert.equal(fields.find(field => field.key === 'cab_side')?.description, 'II 端');
});

test('whole-record state and OOB labels preserve the raw codes', () => {
  const body = new Uint8Array(138);
  body[36] = 5;
  body[103] = 34;
  body[37] = 1;
  body[58] = 4;
  body[85] = 5;
  body[87] = 4;
  body[124] = 31;
  body[125] = 3;
  const fields = decodeReliableBody(2, body).fields;
  assert.equal(fields.find(field => field.key === 'shuntting_state').description, '调车');
  assert.equal(fields.find(field => field.key === 'rtk_state').description, '固定解');
  assert.equal(fields.find(field => field.key === 'work_condition').description, '零位、向前');
  assert.equal(fields.find(field => field.key === 'cell_mode').description, '4G');
  assert.equal(fields.find(field => field.key === 'point_type').description, '信号机');
  const actionField = bytes => decodeReliableBody(2, bytes).fields.find(field => field.key === 'action_type');
  assert.equal(actionField(body).value, 3);
  assert.equal(actionField(body).description, '进入语音提示');

  body[36] = 18;
  body[103] = 26;
  assert.equal(actionField(body.subarray(0, 130)).description, '大解锁');
});
