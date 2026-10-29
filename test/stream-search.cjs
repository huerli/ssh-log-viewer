const { dropLocal } = require('./drop-local.cjs');
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

// Hold only worker completion messages. Real progress still traverses worker ->
// main -> preload -> React, while the search IPC promise cannot yet resolve.
async function holdSearchCompletion(app) {
  await app.evaluate(() => {
    const { Worker } = process.mainModule.require('node:worker_threads');
    const originalEmit = Worker.prototype.emit;
    const held = [];
    const heldWorkers = new Set();
    Worker.prototype.emit = function (event, ...args) {
      if (event === 'message' && args[0]?.type === 'result' && Array.isArray(args[0].result?.matches)) {
        heldWorkers.add(this);
        held.push([this, event, args, this.listeners(event)]);
        return true;
      }
      if (event === 'exit' && heldWorkers.has(this)) {
        held.push([this, event, args, this.listeners(event)]);
        return true;
      }
      return originalEmit.call(this, event, ...args);
    };
    global.releaseSearchCompletion = () => {
      Worker.prototype.emit = originalEmit;
      for (const [worker, , args, listeners] of held) {
        for (const listener of listeners) listener.apply(worker, args);
      }
      delete global.releaseSearchCompletion;
    };
    global.heldSearchResults = () => held.filter(([, event]) => event === 'message').length;
  });
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-stream-ui-'));
  let app;
  try {
    const root = path.join(temp, 'logs');
    const first = path.join(root, 'a.log');
    await fs.mkdir(root);
    await fs.writeFile(first, 'stream-marker first 中文\nplain row\nstream-marker last\n');
    await fs.writeFile(path.join(root, 'b.log'), 'stream-marker second-file\nreplacement-only\n');
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await dropLocal(page, root);
    await page.getByLabel('本地路径', { exact: true }).waitFor();
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').fill('stream-marker');

    await page.locator('.file-entry').filter({ hasText: 'b.log' }).dblclick();
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('2 行'));
    assert.ok(await page.locator('.line-content mark').count() >= 1, 'jumped result highlights matched terms');
    await page.getByLabel('搜索范围', { exact: true }).selectOption('folder');
    await holdSearchCompletion(app);
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').first().waitFor();
    assert.equal(await page.getByRole('button', { name: '搜索全文', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isVisible(), true);
    assert.match(await page.locator('.search-results').textContent(), /stream-marker/);
    assert.equal(await page.locator('.search-results .result-file').first().textContent(), 'b.log');
    assert.match(await page.locator('.batch-summary').textContent(), /\/2/);
    await page.locator('.search-results .result').first().click();
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('2 行'));
    assert.equal(await page.getByRole('button', { name: '搜索全文', exact: true }).isDisabled(), true, 'opening an incremental result keeps the folder search active');
    // Wait for the completion gate itself, rather than assuming worker timing.
    await app.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!global.heldSearchResults()) {
        if (Date.now() > deadline) throw new Error('Search worker did not reach the completion gate');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await app.evaluate(() => global.releaseSearchCompletion());
    await page.waitForFunction(() => document.querySelector('.batch-summary')?.textContent.includes('2/2'));
    await page.waitForFunction(() => !document.querySelector('.search-bar button.primary')?.disabled);
    assert.equal(await page.locator('.search-results .result').count(), 3);
    assert.deepEqual(await page.locator('.search-results .result-file').allTextContents(), ['b.log', 'a.log', 'a.log']);

    await page.locator('.file-entry').filter({ hasText: 'a.log' }).dblclick();
    await page.waitForFunction(() => document.querySelector('.document-bar')?.textContent.includes('3 行'));
    await page.getByLabel('搜索范围', { exact: true }).selectOption('current');
    await holdSearchCompletion(app);
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').first().waitFor();
    assert.equal(await page.getByRole('button', { name: '搜索全文', exact: true }).isDisabled(), true);
    await app.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!global.heldSearchResults()) {
        if (Date.now() > deadline) throw new Error('Search worker did not reach the completion gate');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    assert.equal(await page.locator('.search-results .result').count(), 2);
    await app.evaluate(() => global.releaseSearchCompletion());
    await page.waitForFunction(() => !document.querySelector('.search-bar button.primary')?.disabled);
    assert.equal(await page.locator('.search-results .result').count(), 2, 'final response replaces streamed matches without duplicates');

    // A canceled request may still have a late completion waiting in transit.
    await holdSearchCompletion(app);
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').first().waitFor();
    await app.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!global.heldSearchResults()) {
        if (Date.now() > deadline) throw new Error('Search worker did not reach the completion gate');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').fill('no-such-match');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await app.evaluate(() => global.releaseSearchCompletion());
    await page.waitForFunction(() => !document.querySelector('.search-bar button.primary')?.disabled);
    assert.equal(await page.locator('.search-results .result').count(), 0);
    assert.match(await page.locator('.search-results').textContent(), /未找到匹配内容/);
    const prioritized = await page.evaluate(async paths => window.viewer.searchExtracted(paths, 'stream-marker', { regex: false, caseSensitive: false }, 'priority-extracted'), [path.join(root, 'b.log'), first]);
    assert.deepEqual(prioritized.paths, [first, path.join(root, 'b.log')]);
    assert.equal(prioritized.matches[0].file, first);
    const limited = await page.evaluate(async root => window.viewer.searchLocalFiles(root, 'b.log', 'stream-marker', { regex: false, caseSensitive: false }, 'priority-scope'), root);
    assert.equal(limited.files, 1);
    assert.equal(limited.matches[0].file, path.join(root, 'b.log'));
    assert.deepEqual(errors, []);
    console.log('Streaming search passed: folder/current results render before completion, result navigation keeps searches active, final results do not duplicate, cancellation rejects stale completion.');
  } finally {
    if (app) {
      await app.evaluate(() => global.releaseSearchCompletion?.()).catch(() => {});
      await app.close();
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
