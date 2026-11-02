import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { readSqlite, isSqliteFile } = require('../electron/sqlite-reader.cjs');
test('SQLite read-only schema, pagination, values, identifiers and validation', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'sqlite-reader-')); const file = path.join(root, 'data');
 try {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "odd\""name" (id INTEGER PRIMARY KEY, label TEXT, big INTEGER, data BLOB, empty TEXT); CREATE VIEW sample AS SELECT * FROM "odd\""name";`);
  const insert = db.prepare(`INSERT INTO "odd\""name" VALUES (?, ?, ?, ?, NULL)`);
  for(let i=0;i<105;i++) insert.run(i, i === 0 ? '中文' : 'x'.repeat(4200), 9223372036854775807n, Buffer.from([0,255]));
  db.close();
  const before = await readFile(file);
  assert.equal(await isSqliteFile(file), true);
  assert.equal(readSqlite(file).tables.length, 2);
  const first = readSqlite(file, 'odd"name');
  assert.equal(first.rows.length, 100); assert.equal(first.hasMore, true);
  assert.equal(first.rows[0].big, '9223372036854775807'); assert.equal(first.rows[0].empty, null);
  assert.equal(first.rows[0].label, '中文'); assert.match(first.rows[0].data, /00ff/);
  assert.match(first.rows[1].label, /显示截断/);
  assert.equal(readSqlite(file, 'sample', 100).rows.length, 5);
  assert.equal(readSqlite(file, 'sample', 0, {field:'label', query:'中文', mode:'contains'}).total, 1);
  assert.equal(readSqlite(file, 'sample', 0, {field:'id', query:'104', mode:'exact'}).rows[0].id, '104');
  assert.equal(readSqlite(file, 'sample', 0, {field:'data', query:'00ff'}).total, 105);
  assert.equal(readSqlite(file, 'sample', 0, {query:"' OR 1=1 --"}).total, 0);
  assert.equal(readSqlite(file, 'sample', 0, {query:'%'}).total, 0);
  assert.throws(() => readSqlite(file, 'sample', 0, {field:'missing',query:'x'}));
  assert.equal(readSqlite(file, 'sample', 200).hasMore, false);
  assert.throws(() => readSqlite(file, 'sample; DROP TABLE sample')); assert.throws(() => readSqlite(file, 'sample', -1));
  assert.deepEqual(await readFile(file), before);
  await writeFile(path.join(root,'bad'), 'not sqlite'); assert.equal(await isSqliteFile(path.join(root,'bad')), false);
  assert.throws(() => readSqlite(path.join(root,'missing')));
 } finally { await rm(root, {recursive:true,force:true}); }
});
