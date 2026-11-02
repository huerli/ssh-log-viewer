import test from 'node:test';
import assert from 'node:assert/strict';
import {fileTypes, fileTypeDescription} from '../shared/file-type.mjs';
test('EN_FILETYPE uses bits 16–23, preserves unknown and invalid values',()=>{
 for(const [code, entry] of Object.entries(fileTypes)) assert.ok(fileTypeDescription(String((1 << 24) + Number(code) * 65536 + 1)).includes(entry[0]));
 assert.match(fileTypeDescription(16842753),/FILETYPE_SYS_EXE/);
 assert.match(fileTypeDescription('0x01020001'),/FILETYPE_JAR/);
 assert.match(fileTypeDescription(0x01770001),/未知类型/);
 for(const bad of [null, undefined, -1, 'not an id', 0x100000000]) assert.equal(fileTypeDescription(bad),'—');
});
