const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createServer } = require('./ssh-fixture.cjs');

(async () => {
  const temp = await fs.mkdtemp('/tmp/log-routing-');
  const servers = [];
  let app;
  try {
    await fs.mkdir(path.join(temp, 'downloads'));
    await fs.mkdir(path.join(temp, 'config'));
    await fs.writeFile(path.join(temp, 'downloads/local.log'), 'local-log-marker\n');
    const profiles = [];
    for (const name of ['112', '20']) {
      const root = path.join(temp, name);
      const folder = path.join(root, 'system/log');
      await fs.mkdir(folder, { recursive: true });
      const lines = Array.from({ length: 240 }, (_, i) => `${name}-row-${i + 1}`);
      await fs.writeFile(path.join(folder, 'active.log'), lines.join('\n') + '\n');
      await fs.writeFile(path.join(folder, `only-${name}.log`), `only on ${name}\n`);
      const server = await createServer(root, { shell: true });
      servers.push(server);
      profiles.push({ name, host: '127.0.0.1', port: server.port, username: 'tester', auth: 'password', keyPath: '' });
    }
    await fs.writeFile(path.join(temp, 'config/settings.json'), JSON.stringify({
      sshEnabled: true, autoCheckUpdates: false, profiles,
      directories: { download: path.join(temp, 'downloads'), extract: path.join(temp, 'extract') }
    }));
    app = await _electron.launch({
      ...(process.argv[2] ? { executablePath: process.argv[2] } : { args: ['.'] }),
      env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') }
    });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const page = await app.firstWindow();
    const visible = () => page.locator('.session-workspace:visible');
    const tab = name => visible().getByRole('tab', { name, exact: true });
    const openRemote = () => visible().locator('.file-entry').filter({ hasText: 'active.log' }).dblclick();
    const sourceTab = name => `日志 · ${name} / active.log`;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    async function connect(name) {
      await visible().getByLabel('已保存连接', { exact: true }).selectOption(name);
      await visible().locator('.connection-actions').getByRole('button', { name: '⚙ 设置', exact: true }).click();
      await visible().getByLabel('密码', { exact: true }).fill('fixture-password');
      await visible().getByRole('button', { name: '保存配置', exact: true }).click();
      await visible().locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).click();
      await visible().getByLabel('SSH 终端状态', { exact: true }).filter({ hasText: '已连接' }).waitFor();
    }
    async function assertActive(name) {
      assert.equal(await tab(name).getAttribute('aria-selected'), 'true');
    }
    async function waitForLine(text) {
      await visible().locator('.line-content').getByText(text, { exact: true }).waitFor();
    }

    await connect('112');
    await openRemote();
    await waitForLine('112-row-1');
    await assertActive(sourceTab('112'));
    await visible().locator('.file-entry').filter({ hasText: 'only-112.log' }).waitFor();
    await visible().locator('input[name="search-query"]').fill('112-row-170');
    await visible().getByRole('button', { name: '搜索全文', exact: true }).click();
    await visible().locator('.search-result-row').getByText('112-row-170', { exact: true }).waitFor();
    await visible().locator('.log-viewport').evaluate(view => { view.scrollTop = 2600; });
    await page.waitForFunction(() => document.querySelector('.session-workspace:not([style*="display: none"]) .log-viewport')?.scrollTop > 2400);

    await tab('日志查看').click();
    await connect('20');
    await openRemote();
    await waitForLine('20-row-1');
    await assertActive(sourceTab('20'));
    await visible().locator('.file-entry').filter({ hasText: 'only-20.log' }).waitFor();
    assert.equal(await visible().locator('.file-entry').filter({ hasText: 'only-112.log' }).count(), 0);
    assert.equal(await visible().locator('input[name="search-query"]').inputValue(), '');

    await tab(sourceTab('112')).click();
    assert.equal(await visible().locator('input[name="search-query"]').inputValue(), '112-row-170');
    await visible().locator('.search-result-row').getByText('112-row-170', { exact: true }).waitFor();
    assert.ok(await visible().locator('.log-viewport').evaluate(view => view.scrollTop > 2400));

    await tab('SSH · 112').click();
    await openRemote();
    await assertActive(sourceTab('112'));
    assert.equal(await tab(sourceTab('112')).count(), 1);
    assert.ok(await visible().locator('.log-viewport').evaluate(view => view.scrollTop > 2400));

    await visible().getByRole('button', { name: '实时跟随', exact: true }).click();
    await tab(sourceTab('20')).click();
    await fs.appendFile(path.join(temp, '112/system/log/active.log'), '112-appended-marker\n');
    await visible().getByRole('button', { name: '末尾', exact: true }).click();
    await waitForLine('20-row-240');
    await tab(sourceTab('112')).click();
    await waitForLine('112-appended-marker');

    await visible().getByRole('button', { name: `关闭 ${sourceTab('112')}`, exact: true }).click();
    await tab('SSH · 112').click();
    await visible().getByLabel('SSH 终端状态', { exact: true }).filter({ hasText: '已连接' }).waitFor();
    await tab(sourceTab('20')).click();
    await waitForLine('20-row-240');

    await visible().getByRole('button', { name: '关闭 SSH · 20', exact: true }).click();
    await tab('SSH · 20').waitFor({ state: 'hidden' });
    await assertActive(sourceTab('20'));
    await waitForLine('20-row-240');
    await visible().getByRole('complementary', { name: '已下载文件', exact: true }).getByRole('button', { name: '≡ local.log', exact: true }).click();
    await waitForLine('local-log-marker');
    await assertActive('日志查看');
    await tab(sourceTab('20')).click();
    await waitForLine('20-row-240');
    assert.deepEqual(errors, []);
    console.log('PASS: identical paths on two SSH connections stay independent, retain search and scroll, follow in background, and close independently');
  } finally {
    await app?.close();
    await Promise.all(servers.map(server => server.close()));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
