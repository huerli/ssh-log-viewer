const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-search-history-'));
  let app;
  try {
    const root = path.join(temp, 'logs');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'history.log'), 'INFO first-marker\nERROR second-marker\n');
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '打开本地文件/文件夹', exact: true }).first().click();
    await page.getByLabel('选择路径', { exact: true }).fill(root);
    await page.getByRole('button', { name: '打开路径', exact: true }).click();
    let input = page.getByRole('combobox', { name: '搜索全文关键词或正则表达式', exact: true });
    let history = page.getByRole('listbox', { name: '搜索历史', exact: true });
    await input.click();
    assert.equal(await history.count(), 0);
    for (const query of ['first-marker', 'second-marker', 'first-marker']) {
      await input.fill(query);
      await page.getByRole('button', { name: '搜索全文', exact: true }).click();
      await page.waitForFunction(query => JSON.parse(localStorage.getItem('ssh-log-viewer.search-history') || '[]')[0] === query && document.querySelector('.search-results')?.textContent.includes(query), query);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, 'config', 'settings.json'), 'utf8')).searchHistory, ['first-marker', 'second-marker']);
    await input.fill('');
    assert.deepEqual(await history.getByRole('option').allTextContents(), ['first-marker', 'second-marker']);
    await history.getByRole('option', { name: 'second-marker', exact: true }).click();
    assert.equal(await input.inputValue(), 'second-marker');
    assert.equal(await history.count(), 0);
    // Choosing a record only fills the input; the last completed result is preserved.
    assert.ok((await page.locator('.search-results').textContent()).includes('first-marker'));
    await input.fill('');
    await input.press('Escape');
    assert.equal(await history.count(), 0);
    await input.click();
    await input.press('ArrowDown');
    await input.press('Enter');
    assert.equal(await input.inputValue(), 'first-marker');
    await input.fill('');
    await page.getByLabel('文件名匹配', { exact: true }).click();
    assert.equal(await history.count(), 0);
    await app.close();
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    page = await app.firstWindow();
    input = page.getByRole('combobox', { name: '搜索全文关键词或正则表达式', exact: true });
    history = page.getByRole('listbox', { name: '搜索历史', exact: true });
    await page.waitForFunction(() => window.viewer && document.querySelector('.search-history-input'));
    await page.waitForFunction(async () => JSON.stringify((await window.viewer.settings()).searchHistory) === localStorage.getItem('ssh-log-viewer.search-history'));
    await input.click();
    assert.deepEqual(await history.getByRole('option').allTextContents(), ['first-marker', 'second-marker']);
    await page.screenshot({ path: path.resolve(__dirname, '../docs/search-history.png') });
    await page.getByRole('button', { name: '清空搜索历史', exact: true }).click();
    assert.equal(await history.count(), 0);
    await app.close();
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    page = await app.firstWindow();
    input = page.getByRole('combobox', { name: '搜索全文关键词或正则表达式', exact: true });
    history = page.getByRole('listbox', { name: '搜索历史', exact: true });
    await page.waitForFunction(() => window.viewer && document.querySelector('.search-history-input'));
    await page.waitForFunction(async () => JSON.stringify((await window.viewer.settings()).searchHistory) === localStorage.getItem('ssh-log-viewer.search-history'));
    await input.click();
    assert.equal(await history.count(), 0);
    await fs.writeFile(path.join(root, 'blocked.gz'), 'unused');
    await page.getByRole('button', { name: '打开本地文件/文件夹', exact: true }).first().click();
    await page.getByLabel('选择路径', { exact: true }).fill(root);
    await page.getByRole('button', { name: '打开路径', exact: true }).click();
    await page.getByLabel('本地路径', { exact: true }).waitFor();
    await page.getByLabel('搜索范围', { exact: true }).selectOption('folder');
    await page.getByLabel('文件名匹配', { exact: true }).fill('blocked.gz');
    await app.evaluate(() => {
      const fs = process.mainModule.require('node:fs');
      const { PassThrough } = process.mainModule.require('node:stream');
      const original = fs.createReadStream;
      fs.createReadStream = function(file, options) {
        if (String(file).endsWith('blocked.gz')) { global.historySearchBlocked = true; return new PassThrough(); }
        return original.call(this, file, options);
      };
    });
    await input.fill('canceled-marker');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await app.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!global.historySearchBlocked && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!global.historySearchBlocked) throw new Error('Search did not reach blocked input');
    });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, 'config', 'settings.json'), 'utf8')).searchHistory, ['canceled-marker']);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await app.close();
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    page = await app.firstWindow();
    await page.waitForFunction(() => localStorage.getItem('ssh-log-viewer.search-history') === '["canceled-marker"]');
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').click();
    assert.deepEqual(await page.getByRole('listbox', { name: '搜索历史', exact: true }).getByRole('option').allTextContents(), ['canceled-marker']);
    assert.deepEqual(errors, []);
    console.log('Search history passed: search submission persistence, deduplication, click/keyboard selection, empty-input visibility, full application restart, clear and canceled-search persistence.');
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
