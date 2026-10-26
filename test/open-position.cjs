const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-position-'));
  let app;
  try {
    const file = path.join(temp, 'position.log');
    await fs.writeFile(file, Array.from({ length: 20000 }, (_, i) => `position-${i} 中文`).join('\n') + '\n');
    app = await _electron.launch({ args: ['.'], env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '打开本地文件/文件夹', exact: true }).first().click();
    await page.getByLabel('选择路径', { exact: true }).fill(file);
    await page.getByRole('button', { name: '打开路径', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('20,000 行'));
    await page.waitForFunction(() => document.querySelector('[data-line="0"] .line-content')?.textContent === 'position-0 中文');
    assert.equal(await page.locator('.log-viewport').evaluate(e => e.scrollTop), 0);
    await page.getByRole('button', { name: '末尾', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-line="19999"] .line-content')?.textContent === 'position-19999 中文');
    await page.getByRole('button', { name: '首行', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.log-viewport')?.scrollTop === 0);
    console.log('PASS: opening indexed log stays at first line; explicit end/start navigation works');
  } finally { if (app) await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
