import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { snapshotCommand } = createRequire(import.meta.url)('../electron/download-snapshot.cjs');
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const main = await fs.readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('function compressRemote('), main.indexOf('async function downloadInto('));
const compress = vm.runInNewContext(source + '\ncompressRemote', { Error, snapshotCommand });
const client = { exec(command, callback) {
  const child = spawn('/bin/sh', ['-c', command]);
  child.signal = signal => child.kill(signal);
  child.close = () => child.kill();
  // Match the SSH channel interface while consuming stdout.
  child.on('data', () => {});
  callback(null, child);
} };

test('remote compression command preserves content and safely quotes filenames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-compress-test-'));
  try {
    const input = path.join(root, "中文 ' $file.log");
    const output = path.join(root, 'result.gz');
    const content = '中文日志\n'.repeat(10000);
    await fs.writeFile(input, content);
    await compress(client, input, output, Buffer.byteLength(content), new AbortController().signal);
    assert.equal(gunzipSync(await fs.readFile(output)).toString(), content);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    await assert.rejects(compress(client, input, output, Buffer.byteLength(content), new AbortController().signal), /远程压缩失败/);
    assert.equal(gunzipSync(await fs.readFile(output)).toString(), content);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(compress(client, input, output, Buffer.byteLength(content), controller.signal), /操作已取消/);
    await assert.rejects(compress(client, input + '-missing', path.join(root, 'missing.gz'), Buffer.byteLength(content), new AbortController().signal), /远程压缩失败/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
