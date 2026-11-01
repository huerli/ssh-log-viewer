import test from 'node:test';
import assert from 'node:assert/strict';
import { wholeRecordTypes, enumDescription, recordTypeDescription } from '../shared/reliable-db-enums.mjs';
test('EN_WRCD_TYPE preserves explicit values, holes and implicit values from header', () => {
  assert.equal(wholeRecordTypes[7].name, 'WRCDTYPE_SPEED_CHANGE');
  assert.equal(wholeRecordTypes[13].name, 'WRCDTYPE_TAX_STATUS');
  assert.equal(wholeRecordTypes[14], undefined);
  assert.equal(wholeRecordTypes[27].name, 'WRCDTYPE_MAX');
  assert.equal(wholeRecordTypes[103].name, 'WRCDTYPE_INVALID');
  assert.match(enumDescription(wholeRecordTypes, 13), /13 · WRCDTYPE_TAX_STATUS（TAX箱状态变化）/);
});
test('record type uses whole record or alarm subtype and leaves unknown types explicit', () => {
  const body = new Uint8Array(104); body[36] = 7;
  assert.match(recordTypeDescription(2, body), /WRCDTYPE_SPEED_CHANGE/);
  body[39] = 2;
  assert.match(recordTypeDescription(0, body), /ALMTYPE_GNSS/);
  assert.match(recordTypeDescription(1, body), /TRSTRANS_EVENT/);
  body[36] = 14;
  assert.equal(recordTypeDescription(2, body), '14 · 未定义');
});
