import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
const { snapshotCommand, sourceChanged } = createRequire(import.meta.url)('../electron/download-snapshot.cjs');

test('download accepts appended logs but rejects truncation, replacement and changing archives', () => {
  const before = { size: 100, mtime: 1 };
  assert.equal(sourceChanged(before, {size: 120, mtime: 2}, true), false);
  assert.equal(sourceChanged(before, before, true), false);
  assert.equal(sourceChanged(before, {size: 90, mtime: 2}, true), true);
  assert.equal(sourceChanged(before, {size: 100, mtime: 2}, true), true);
  assert.equal(sourceChanged(before, {size: 120, mtime: 2}, false), true);
});

test('remote compression bounds the snapshot and removes staging files on success or short reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'download-snapshot-'));
  try {
    const file = path.join(root, "log ' $(false)"), output = path.join(root, "out '.gz");
    await writeFile(file, 'initial\nappended\n');
    execFileSync('/bin/sh', ['-c', snapshotCommand(file, output, 8)]);
    assert.equal(gunzipSync(await readFile(output)).toString(), 'initial\n');
    assert.equal((await readdir(root)).some(name => name.endsWith('.raw')), false);
    assert.throws(() => execFileSync('/bin/sh', ['-c', snapshotCommand(file, output + '.short', 100)]));
    assert.equal((await readdir(root)).some(name => name.endsWith('.raw')), false);
    assert.throws(() => snapshotCommand(file, output, -1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
