import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildIndex, readPage, searchFile, readFilteredPage, readFullLine, MAX_LINE_BYTES } from '../electron/log-core.mjs';

test('UTF-8, CRLF, index boundary, EOF without newline and empty files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-test-'));
  try {
    const file = path.join(dir, 'test.log');
    const lines = Array.from({ length: 1300 }, (_, i) => `${i} 中文日志 ${i === 512 ? 'ERROR Needle' : 'INFO'}`);
    await writeFile(file, lines.join('\r\n'));
    const index = await buildIndex(file);
    assert.equal(index.lines, lines.length);
    for (const start of [0, 510, 512, 1023, 1299]) {
      const page = await readPage(file, index, start, 5);
      assert.deepEqual(page.map(row => row.text), lines.slice(start, start + 5));
      assert.equal(page[0].line, start);
    }
    assert.equal((await searchFile(file, 'needle')).count, 1);
    assert.equal((await searchFile(file, 'needle', { caseSensitive: true })).count, 0);
    assert.equal((await searchFile(file, '^512.*ERROR', { regex: true })).matches[0].line, 512);
    await assert.rejects(searchFile(file, '[', { regex: true }));
    await writeFile(file, ''); assert.equal((await buildIndex(file)).lines, 0);
    await writeFile(file, '\n\n'); assert.equal((await buildIndex(file)).lines, 2);
    assert.equal((await readPage(file, await buildIndex(file), 0, 5)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multibyte characters across chunks and bounded exceptionally long lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-long-'));
  try {
    const file = path.join(dir, 'long.log');
    await writeFile(file, 'x'.repeat(262143) + '中文 Needle\n' + 'z'.repeat(MAX_LINE_BYTES + 10) + '\nlast');
    const result = await searchFile(file, '中文 Needle');
    assert.equal(result.count, 1); assert.equal(result.truncatedLines, 0);
    await writeFile(file, 'z'.repeat(MAX_LINE_BYTES + 10) + 'AFTER-LIMIT\n');
    assert.equal((await searchFile(file, 'after-limit')).count, 1);
    assert.equal((await searchFile(file, 'AFTER-LIMIT', { regex: true })).truncatedLines, 1);
    await writeFile(file, 'x'.repeat(262143) + '中文 Needle\n' + 'z'.repeat(MAX_LINE_BYTES + 10) + '\nlast');
    const page = await readPage(file, await buildIndex(file), 0, 3);
    assert.equal(page[0].text.length, 12000);
    assert.equal(page[0].displayTruncated, true);
    assert.equal(page[1].truncated, true); assert.equal(page[2].text, 'last');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('full-line reader has no single-line length limit and preserves CRLF semantics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-full-line-'));
  try {
    const file = path.join(dir, 'long.log');
    const prefix = 'first line';
    const target = 'x'.repeat(MAX_LINE_BYTES + 262147) + '中文终点';
    await writeFile(file, `${prefix}\r\n${target}\r\nlast`);
    const chunks = [];
    for await (const chunk of readFullLine(file, Buffer.byteLength(prefix) + 2)) chunks.push(chunk);
    assert.equal(chunks.join(''), target);
    const last = [];
    for await (const chunk of readFullLine(file, Buffer.byteLength(`${prefix}\r\n${target}\r\n`))) last.push(chunk);
    assert.equal(last.join(''), 'last');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('50MB log indexing, random page and full search benchmark', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-50mb-'));
  try {
    const file = path.join(dir, 'large.log');
    const row = '2026-10-12 16:00:00 INFO 中文日志 service=request trace=1234567890 payload=' + 'x'.repeat(60) + '\n';
    const batch = Buffer.from(row.repeat(4096));
    const handle = await open(file, 'w');
    let bytes = 0, lines = 0;
    while (bytes < 50 * 1024 * 1024) { await handle.write(batch); bytes += batch.length; lines += 4096; }
    await handle.write(Buffer.from('ERROR benchmark-unique 最后一行')); await handle.close();
    const start = performance.now(); const index = await buildIndex(file); const indexed = performance.now();
    assert.equal(index.lines, lines + 1);
    const page = await readPage(file, index, lines - 100, 101); const paged = performance.now();
    assert.equal(page.at(-1).text, 'ERROR benchmark-unique 最后一行');
    const result = await searchFile(file, 'benchmark-unique'); const searched = performance.now();
    assert.equal(result.count, 1); assert.equal(result.matches[0].line, lines);
    assert.ok(index.checkpoints.length < 2000);
    t.diagnostic(`${(index.size / 1024 ** 2).toFixed(1)}MB / ${index.lines} lines: index=${(indexed-start).toFixed(0)}ms page=${(paged-indexed).toFixed(0)}ms search=${(searched-paged).toFixed(0)}ms; sparse checkpoints=${index.checkpoints.length}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pathological regex stays in a terminable worker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-cancel-'));
  try {
    const file = path.join(dir, 'regex.log'); await writeFile(file, 'a'.repeat(10000) + '!');
    const worker = new Worker(new URL('../electron/worker.mjs', import.meta.url), { workerData: { kind: 'search', file, query: '(a+)+$', options: { regex: true } } });
    await new Promise(resolve => setTimeout(resolve, 150));
    const start = performance.now(); await worker.terminate();
    assert.ok(performance.now() - start < 3000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('literal filter exceeds search-result cap, preserves UTF-8 byte offsets and original line numbers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-filter-'));
  try {
    const file = path.join(dir, 'filtered.log');
    const lines = Array.from({ length: 25001 }, (_, i) => `${i} 中文 ${i % 2 ? 'no match' : 'a.b,[x]'}`);
    await writeFile(file, lines.join('\r\n'));
    const result = await searchFile(file, 'a.b,[x]', { collectPositions: true });
    assert.equal(result.count, 12501); assert.equal(result.matches.length, 10000);
    assert.equal(result.positions.length, 25002);
    const page = await readFilteredPage(file, result.positions, 12000, 5);
    assert.deepEqual(page.map(row => row.text), [24000, 24002, 24004, 24006, 24008].map(i => lines[i]));
    assert.deepEqual(page.map(row => row.line), [24000, 24002, 24004, 24006, 24008]);
    assert.deepEqual(page.map(row => row.position), [12000, 12001, 12002, 12003, 12004]);
    assert.equal(page[0].offset, Buffer.byteLength(lines.slice(0, 24000).join('\r\n') + '\r\n'));
    assert.equal((await readFilteredPage(file, result.positions, 12500, 10))[0].text, lines.at(-1));
    assert.deepEqual(await readFilteredPage(file, new Float64Array(), 0), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('search progress streams match deltas before EOF and flushes sparse final matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-stream-'));
  try {
    const file = path.join(dir, 'stream.log');
    const lines = ['needle first 中文', ...Array(12000).fill('unmatched filler '.repeat(8)), 'needle last 无换行'];
    await writeFile(file, lines.join('\r\n'));
    const updates = [];
    const result = await searchFile(file, 'needle', {}, update => updates.push(structuredClone(update)));
    const matchingUpdates = updates.filter(update => update.matches?.length);
    assert.ok(matchingUpdates.length >= 2, 'first match must be delivered separately from the EOF match');
    assert.equal(matchingUpdates[0].matches[0].line, 0);
    assert.ok(matchingUpdates[0].bytes < matchingUpdates[0].size, 'first result arrives before the full file is scanned');
    assert.deepEqual(updates.flatMap(update => update.matches || []), result.matches);
    assert.equal(matchingUpdates.at(-1).count, 2);
    assert.equal(matchingUpdates.at(-1).matches.at(-1).line, lines.length - 1);
    assert.equal(result.matches.at(-1).text, lines.at(-1));
    for (let i = 1; i < updates.length; i++) {
      assert.ok(updates[i].count >= updates[i - 1].count);
      assert.ok(updates[i].bytes >= updates[i - 1].bytes);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('streamed results honor the 10000 display cap without duplicates and filters omit match payloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-stream-cap-'));
  try {
    const file = path.join(dir, 'cap.log');
    await writeFile(file, Array.from({ length: 10003 }, (_, i) => `needle ${i} 中文`).join('\n'));
    const updates = [];
    const result = await searchFile(file, 'needle', {}, update => updates.push(structuredClone(update)));
    const streamed = updates.flatMap(update => update.matches || []);
    assert.deepEqual(streamed, result.matches);
    assert.equal(streamed.length, 10000);
    assert.equal(new Set(streamed.map(match => match.line)).size, 10000);
    assert.equal(result.count, 10003);
    assert.equal(result.capped, true);
    assert.equal(updates.at(-1).count, result.count);
    assert.equal(updates.at(-1).capped, true);
    const filteredUpdates = [];
    const filtered = await searchFile(file, 'needle', { collectPositions: true }, update => filteredUpdates.push(update));
    assert.equal(filtered.count, 10003);
    assert.equal(filtered.positions.length / 2, 10003);
    assert.ok(filteredUpdates.every(update => !update.matches?.length), 'filter progress must not transfer result excerpts');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('plain search supports ordered star wildcards without changing regex or literal filters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-wildcard-'));
  try {
    const file = path.join(dir, 'log');
    await writeFile(file, [
      'INFO remove readIdle time over 27s session disconnected 2098267890303354',
      'INFO remove readIdle time over 27s another-id 123',
      '2098267890303354 before remove readIdle time over 27s',
      'remove readIdle time over 27s',
      '2098267890303354',
      'prefix a.b[1](x)+ end 42 suffix',
      'UPPER mid END',
      'literal a*b marker',
      'literal axb marker',
    ].join('\n'));
    const updates = [];
    const result = await searchFile(file, 'remove readIdle time over 27s * 2098267890303354', {}, update => updates.push(update));
    assert.deepEqual(result.matches.map(row => row.line), [0]);
    assert.deepEqual(updates.flatMap(update => update.matches || []), result.matches);
    assert.equal((await searchFile(file, 'a.b[1](x)+*42')).count, 1);
    assert.equal((await searchFile(file, 'upper*end')).count, 1);
    assert.equal((await searchFile(file, 'upper*end', { caseSensitive: true })).count, 0);
    assert.equal((await searchFile(file, 'UPPER**END')).count, 1);
    assert.equal((await searchFile(file, '*')).count, 9);
    assert.equal((await searchFile(file, 'a\\*b', { regex: true })).count, 1);
    assert.equal((await searchFile(file, 'a*b', { collectPositions: true })).count, 1);
    await writeFile(file, '起点' + 'x'.repeat(MAX_LINE_BYTES + 262142) + '中文终点\n起点\n中文终点');
    assert.equal((await searchFile(file, '起点*中文终点')).count, 1, 'wildcards cover long lines and chunk boundaries, without crossing newline');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
