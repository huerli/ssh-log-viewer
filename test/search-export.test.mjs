import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { formatSearchExport, writeSearchExport } = createRequire(import.meta.url)('../electron/search-export.cjs');
const data = { query: 'needle*中文', file: '/local/source.log', count: 12000, capped: true, partial: true, matches: [{ line: 0, text: 'needle,"中文"' }, { file: '/other.log', line: 8, text: 'second\trow' }] };
test('result exports preserve content, one-based lines, no source filenames and partial/capped metadata', () => {
  const txt = formatSearchExport(data, 'out.txt');
  assert.match(txt, /\[1\] needle,"中文"/);
  assert.match(txt, /搜索尚未完成或已取消/);
  assert.match(txt, /仅导出展示范围内/);
  const json = JSON.parse(formatSearchExport(data, 'out.json'));
  assert.equal(json.query, data.query);
  assert.equal(json.matches[1].line, 9);
  assert.equal(json.exportedMatches, 2);
  assert.equal(json.totalMatches, 12000);
  assert.equal(json.partial, true);
  assert.equal(json.matches[0].text, data.matches[0].text);
  const csv = formatSearchExport(data, 'out.csv');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"1","needle,""中文"""'));
  for (const extension of ['txt', 'csv', 'json']) {
    const output = formatSearchExport(data, 'out.' + extension);
    assert.ok(!output.includes('/local/source.log'));
    assert.ok(!output.includes('/other.log'));
    assert.ok(!output.includes('来源文件'));
  }
  assert.equal('file' in json.matches[0], false);
  assert.throws(() => formatSearchExport({ matches: [] }, 'out.txt'));
  assert.throws(() => formatSearchExport({ matches: [{ line: -1, text: 'bad' }] }, 'out.txt'));
});

test('streamed exports preserve complete lines beyond the previous single-line limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-export-long-'));
  try {
    const text = 'x'.repeat(1024 * 1024 + 37) + '中文结尾"\\';
    const data = { query: 'tail', count: 1, matches: [{ line: 0, text }] };
    const output = path.join(dir, 'out.json');
    async function* readText(match) {
      for (let index = 0; index < match.text.length; index += 65536) yield match.text.slice(index, index + 65536);
    }
    await writeSearchExport(data, output, readText);
    const parsed = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(parsed.matches[0].text, text);
    assert.match(parsed.note, /不限制单行长度/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
