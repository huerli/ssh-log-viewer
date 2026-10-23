const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-delete-settings-'));
  let app;
  const launch = () => _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: temp } });
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.evaluate(async () => {
      const jump = { name: 'shared-hop', host: '127.0.0.1', port: 22, username: 'jumper', auth: 'password', password: 'hop-secret', rememberPassword: true, enabled: true };
      await window.viewer.saveJumpProfile(jump);
      for (const name of ['first', 'second']) await window.viewer.saveProfile({ name, host: '127.0.0.1', port: 22, username: 'tester', auth: 'password', password: 'target-secret', rememberPassword: true, jumpName: jump.name, jump });
    });
    await page.reload();
    await page.getByLabel('已保存连接').selectOption('first');
    await page.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await page.getByLabel('连接名称', { exact: true }).waitFor();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.getByRole('button', { name: '删除连接', exact: true }).click();
    assert.equal((await page.evaluate(() => window.viewer.settings())).profiles.length, 2);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const before = JSON.parse(await fs.readFile(path.join(temp, 'credentials.json'), 'utf8'));
    await page.getByRole('button', { name: '删除连接', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.status-bar').textContent.includes('连接配置已删除'));
    let settings = await page.evaluate(() => window.viewer.settings());
    assert.deepEqual(settings.profiles.map(item => item.name), ['second']);
    assert.equal(settings.jumpProfiles.length, 1);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(temp, 'credentials.json'), 'utf8'))).length, Object.keys(before).length - 1);
    await page.getByLabel('已保存连接').selectOption('second');
    await page.getByLabel('连接名称', { exact: true }).fill('second');
    await page.locator('.jump-controls button').click();
    const dialog = page.getByRole('dialog', { name: '跳板机配置' });
    await dialog.getByRole('button', { name: '删除跳板机', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.status-bar').textContent.includes('跳板机配置已删除'));
    settings = await page.evaluate(() => window.viewer.settings());
    assert.equal(settings.jumpProfiles.length, 0);
    assert.equal(settings.profiles[0].jumpName, undefined);
    assert.equal(settings.profiles[0].jump.enabled, true);
    assert.equal(settings.profiles[0].jump.host, '');
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(temp, 'credentials.json'), 'utf8'))).length, 1);
    assert.equal((await page.evaluate(() => window.viewer.loadProfile('second'))).password, 'target-secret');
    assert.equal(await dialog.getByRole('button', { name: '删除跳板机', exact: true }).isDisabled(), true);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.locator('.app').waitFor();
    settings = await page.evaluate(() => window.viewer.settings());
    assert.deepEqual(settings.profiles.map(item => item.name), ['second']);
    assert.equal(settings.jumpProfiles.length, 0);
    console.log('PASS: cancel/delete connection, credential cleanup, shared jump deletion, retained target password, restart persistence');
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
