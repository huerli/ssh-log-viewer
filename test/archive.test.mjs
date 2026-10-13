import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync, crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tar = require('tar-stream');
const { extractArchive, safePath } = require('../electron/archive.cjs');

function zipFile(name, data) {
  const filename = Buffer.from(name); const contents = Buffer.from(data); const crc = crc32(contents);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + contents.length, 16);
  return Buffer.concat([local, filename, contents, central, filename, end]);
}
async function tarFile(name, contents, type = 'file') {
  const pack = tar.pack(); const chunks = [];
  const result = (async () => { for await (const chunk of pack) chunks.push(chunk); return Buffer.concat(chunks); })();
  pack.entry({ name, type, ...(type === 'symlink' ? { linkname: '/etc/passwd' } : {}) }, contents); pack.finalize();
  return result;
}

test('gzip, zip and tar.gz extraction preserves Chinese logs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-archive-'));
  try {
    const content = 'INFO 中文\nERROR 测试\n';
    for (const ext of ['gz', 'zip', 'tar.gz']) {
      const source = path.join(dir, `log.${ext}`), target = path.join(dir, ext);
      const buffer = ext === 'gz' ? gzipSync(content) : ext === 'zip' ? zipFile('nested/log.txt', content) : gzipSync(await tarFile('nested/log.txt', content));
      await writeFile(source, buffer);
      const result = await extractArchive(source, target, new AbortController().signal);
      assert.equal(result.files, 1);
      assert.equal(await readFile(path.join(target, ext === 'gz' ? 'log' : 'nested/log.txt'), 'utf8'), content);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reject archive traversal, links and existing target directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-unsafe-'));
  try {
    for (const name of ['../escape', '/etc/passwd', 'C:/escape', 'nested/../../escape', 'nested\\escape']) assert.throws(() => safePath(dir, name));
    const source = path.join(dir, 'unsafe.tar.gz');
    await writeFile(source, gzipSync(await tarFile('../escape', 'bad')));
    const target = path.join(dir, 'target');
    await assert.rejects(extractArchive(source, target, new AbortController().signal), /不安全/);
    await assert.rejects(access(target));
    await writeFile(source, gzipSync(await tarFile('link', '', 'symlink')));
    await assert.rejects(extractArchive(source, target, new AbortController().signal), /不支持/);
    await assert.rejects(extractArchive(source, dir, new AbortController().signal));
    await writeFile(path.join(dir, 'unsafe.zip'), zipFile('../escape', 'bad'));
    await assert.rejects(extractArchive(path.join(dir, 'unsafe.zip'), target, new AbortController().signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelled extraction removes incomplete outputs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-abort-'));
  try {
    const source = path.join(dir, 'log.gz'), target = path.join(dir, 'target');
    await writeFile(source, gzipSync('test'.repeat(100000)));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(extractArchive(source, target, controller.signal));
    await assert.rejects(access(target));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
