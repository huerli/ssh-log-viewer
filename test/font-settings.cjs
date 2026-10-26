const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-font-'));
  let app;
  const launch = () => _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
  try {
    const file = path.join(temp, 'font.log');
    await fs.writeFile(file, Array.from({ length: 600 }, (_, index) => `INFO font-marker 日志 ${index + 1}`).join('\n'));
    app = await launch();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    let page = await app.firstWindow();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: '打开本地文件/文件夹', exact: true }).first().click();
    await page.getByLabel('选择路径', { exact: true }).fill(file);
    await page.getByRole('button', { name: '打开路径', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('600 行'));
    await page.getByRole('button', { name: '字体设置', exact: true }).click();
    await page.getByLabel('日志字体', { exact: true }).fill('DejaVu Sans Mono');
    await page.getByLabel('日志字号', { exact: true }).fill('24');
    assert.equal(await page.locator('.font-preview').evaluate(e => getComputedStyle(e).fontSize), '24px');
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.locator('.font-preview').evaluate(element => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `24px ${getComputedStyle(element).fontFamily}`;
      // Multi-stroke numerals need enough space to stay legible beside ASCII.
      return context.measureText('Ⅲ').width > context.measureText('I').width;
    }));
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('.log-viewport').evaluate(e => getComputedStyle(e).fontSize), '12px');
    await page.getByRole('button', { name: '字体设置', exact: true }).click();
    await page.getByLabel('日志字体', { exact: true }).fill('DejaVu Sans Mono');
    await page.getByLabel('日志字号', { exact: true }).fill('32');
    await page.screenshot({ path: path.resolve(__dirname, '../docs/font-settings.png') });
    await page.getByRole('button', { name: '应用并保存', exact: true }).click();
    await page.getByRole('dialog', { name: '日志字体设置' }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.log-viewport').evaluate(e => getComputedStyle(e).fontSize), '32px');
    assert.ok((await page.locator('.log-viewport').evaluate(e => getComputedStyle(e).fontFamily)).includes('DejaVu Sans Mono'));
    const rowHeights = await page.locator('.log-row').evaluateAll(rows => rows.map(e => e.getBoundingClientRect().height));
    assert.ok(rowHeights.length > 1 && rowHeights.every(height => height === 58));
    await page.getByRole('button', { name: '末尾', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.line-content')].some(e => e.textContent.endsWith('日志 600')));
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').fill('font-marker');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.status-bar')?.textContent.includes('搜索完成'));
    assert.equal(await page.locator('.search-results .result').first().evaluate(e => e.getBoundingClientRect().height), 58);
    assert.equal(await page.locator('.search-results .result span').first().evaluate(e => getComputedStyle(e).fontSize), '32px');
    const rejected = await page.evaluate(async () => {
      try { await window.viewer.saveLogFont({ family: 'Consolas', size: 99 }); return false; } catch { return true; }
    });
    assert.equal(rejected, true);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('.app')?.style.getPropertyValue('--log-font-size') === '32px');
    await page.getByRole('button', { name: '字体设置', exact: true }).click();
    assert.equal(await page.getByLabel('日志字体', { exact: true }).inputValue(), 'DejaVu Sans Mono');
    assert.equal(await page.getByLabel('日志字号', { exact: true }).inputValue(), '32');
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await page.getByRole('button', { name: '应用并保存', exact: true }).click();
    await page.getByRole('dialog', { name: '日志字体设置' }).waitFor({ state: 'hidden' });
    const settings = JSON.parse(await fs.readFile(path.join(temp, 'config/settings.json'), 'utf8'));
    assert.deepEqual(settings.logFont, { family: 'Cascadia Code', size: 12 });
    assert.deepEqual(errors, []);
    console.log('Font settings passed: preview, cancel, max-size row heights, last-line jump, search result fonts, invalid input rejection, restart persistence and default reset.');
  } finally { if (app) await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
