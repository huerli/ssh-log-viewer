const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { dropLocal } = require('./drop-local.cjs');

async function selectAndContext(page, text) {
  const target = page.locator('.line-content').filter({ hasText: text }).first();
  const box = await target.evaluate((element, word) => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const offset = node.textContent.indexOf(word);
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + word.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + Math.min(3, rect.width / 2), y: rect.y + rect.height / 2 };
      }
    }
  }, text);
  assert.ok(box, `could not find text ${text} in viewport`);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.getByRole('menu', { name: '日志文本操作' }).waitFor();
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-highlight-'));
  let app;
  try {
    const logFile = path.join(temp, 'ver.log');
    await fs.writeFile(logFile, [
      'notice timing phase=distribution distribution finished slot=112',
      'notice distribution start slot=3',
      'notice timing phase=distribution distribution finished slot=3',
      'info normal line alpha=1 beta=2',
    ].join('\n') + '\n');

    app = await _electron.launch({
      ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }),
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await dropLocal(page, logFile);
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('4 行'));

    const searchInput = page.getByPlaceholder('搜索全文关键词或正则表达式…');
    // 1. Search and jump to "distribution"
    await searchInput.fill('distribution');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.line-content mark')].some(m => m.textContent === 'distribution'));
    assert.equal(await page.locator('.clear-extra-highlights').count(), 0, 'search jump should not add extra manual highlights');

    // 2. Search and jump to "phase=distribution" -> old "distribution" highlight must NOT linger
    await searchInput.fill('phase=distribution');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').first().click();
    await page.waitForFunction(() => {
      const marks = [...document.querySelectorAll('.line-content mark')].map(m => m.textContent);
      return marks.length === 2 && marks.every(t => t === 'phase=distribution');
    });
    const markTexts = await page.locator('.line-content mark').allTextContents();
    assert.deepEqual(markTexts, ['phase=distribution', 'phase=distribution']);

    // Clear search -> all search highlights gone
    await searchInput.fill('');
    await page.waitForFunction(() => document.querySelectorAll('.line-content mark').length === 0);

    // 3. Context filter highlights while active and clears highlight when filter is cancelled
    await selectAndContext(page, 'alpha=1');
    await page.getByRole('menuitem', { name: '仅显示包含该字符串的行' }).click();
    await page.locator('.filter-bar').waitFor();
    await page.waitForFunction(() => {
      const marks = [...document.querySelectorAll('.line-content mark')].map(m => m.textContent);
      return marks.length === 1 && marks[0] === 'alpha=1';
    });
    await page.getByRole('button', { name: '取消筛选', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.line-content mark').length === 0);

    // 4. Manual right-click highlight shows clear button and can be cleared in one click
    await selectAndContext(page, 'beta=2');
    await page.getByRole('menuitem', { name: '高亮所有该字符串', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.line-content mark').length === 1);
    const clearBtn = page.getByRole('button', { name: '清除高亮 (1)', exact: true });
    await clearBtn.waitFor();
    await clearBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('.line-content mark').length === 0);
    assert.equal(await page.locator('.clear-extra-highlights').count(), 0);

    assert.deepEqual(errors, []);
    console.log('Highlight behavior regression test passed');
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
