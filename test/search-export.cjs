const { dropLocal } = require('./drop-local.cjs');
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync } = require('node:zlib');
const assert = require('node:assert/strict');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-export-'));
  let app;
  try {
    const root = path.join(temp, 'logs'); await fs.mkdir(root);
    const longLine = 'x'.repeat(1024 * 1024 + 128) + ' needle-tail 中文';
    const archiveLine = 'y'.repeat(1024 * 1024 + 64) + ' needle-gzip-tail 中文';
    await fs.writeFile(path.join(root, 'source.log'), `INFO needle 中文\n${longLine}\nERROR needle second\n`);
    await fs.writeFile(path.join(root, 'z-archive.log.gz'), gzipSync(`${archiveLine}\n`));
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    const page = await app.firstWindow();
    assert.equal(await page.getByRole('button', { name: '导出结果', exact: true }).isDisabled(), true);
    await dropLocal(page, root);
    await page.getByLabel('本地路径', { exact: true }).waitFor();
    const input = page.getByPlaceholder('搜索全文关键词或正则表达式…');
    await input.fill('needle'); await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.search-result-row').length === 4 && !document.querySelector('.search-bar .primary').disabled);
    await input.fill('new draft query');
    for (const extension of ['txt', 'csv', 'json']) {
      const output = path.join(temp, 'results.' + extension);
      await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
      await page.getByRole('button', { name: '导出结果', exact: true }).click();
      await page.waitForFunction(output => document.querySelector('.status-bar')?.textContent.includes('已导出 4 条') && document.querySelector('.status-bar')?.textContent.includes(output), output);
      const text = await fs.readFile(output, 'utf8'); assert.match(text, /needle 中文/);
      assert.ok(text.includes('needle-tail 中文'), `complete long line missing from ${extension}`);
      assert.ok(text.includes('needle-gzip-tail 中文'), `complete gzip line missing from ${extension}`);
      if (extension === 'json') { const data = JSON.parse(text); assert.equal(data.query, 'needle'); assert.equal(data.partial, false); assert.equal(data.matches[0].line, 1); assert.equal(data.matches[1].text, longLine); assert.ok(data.matches.some(match => match.text === archiveLine)); assert.equal('file' in data.matches[0], false); }
    }
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    await page.getByRole('button', { name: '导出结果', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '导出结果' && !button.disabled));
    assert.equal(await page.locator('.search-results .result').count(), 4);
    console.log('Search export passed: complete unlimited single lines from plain and gzip sources in TXT/CSV/JSON, save dialog, original query snapshot, no source filenames, line numbers and cancellation.');
  } finally { if (app) await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
