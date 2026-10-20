const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-copy-result-'));
  let app;
  try {
    const lines = ['INFO copy-marker 中文第一条', 'ERROR copy-marker 第二条'];
    const file = path.join(temp, 'copy.log');
    await fs.writeFile(file, lines.join('\n'));
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '打开本地文件/文件夹', exact: true }).first().click();
    await page.getByLabel('选择路径', { exact: true }).fill(temp);
    await page.getByRole('button', { name: '打开路径', exact: true }).click();
    await page.getByLabel('本地路径', { exact: true }).waitFor();
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').fill('copy-marker');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.search-result-row').length === 2 && !document.querySelector('.search-bar .primary').disabled);
    const read = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const first = page.locator('.search-result-row').first();
    await first.getByRole('button', { name: '复制第 1 行日志', exact: true }).click();
    assert.equal(await read(), lines[0]);
    async function selectFirst() {
      await first.locator('.search-result-text').evaluate(element => {
        const range = document.createRange(); range.setStart(element.firstChild, 5); range.setEnd(element.firstChild, 16);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
    }
    await selectFirst();
    await first.getByRole('button', { name: '复制第 1 行日志', exact: true }).click();
    assert.equal(await read(), 'copy-marker');
    await first.locator('.search-result-text').dispatchEvent('contextmenu', { clientX: 400, clientY: 450 });
    await page.getByRole('menuitem', { name: '复制选中内容', exact: true }).click();
    assert.equal(await read(), 'copy-marker');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await first.locator('.search-result-text').dispatchEvent('contextmenu', { clientX: 400, clientY: 450 });
    await page.getByRole('menuitem', { name: '复制整条日志', exact: true }).click();
    assert.equal(await read(), lines[0]);
    await first.locator('.result').focus();
    await page.keyboard.press('Control+c');
    assert.equal(await read(), lines[0]);
    await selectFirst();
    await page.keyboard.press('Control+c');
    assert.equal(await read(), 'copy-marker');
    // An unrelated row's selection must not leak into copying the second row.
    await page.getByRole('button', { name: '复制第 2 行日志', exact: true }).click();
    assert.equal(await read(), lines[1]);
    assert.equal(await page.locator('.document-bar strong').textContent(), '尚未打开日志');
    console.log('Search result copy passed: full row, selection, context menu, Ctrl+C, row isolation and no navigation.');
  } finally { if (app) await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
