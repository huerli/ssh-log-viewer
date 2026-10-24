const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createServer } = require('./ssh-fixture.cjs');
const { createJump, reverseTunnel } = require('./jump-fixture.cjs');
const listening = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-release-ui-'));
  let app, target, jump, reverse, other, finishExec, startedExec, deny = true;
  const started = new Promise(resolve => { startedExec = resolve; });
  const gate = new Promise(resolve => { finishExec = resolve; });
  try {
    await fs.mkdir(path.join(temp, 'target/system/log'), { recursive: true });
    target = await createServer(path.join(temp, 'target'));
    jump = await createJump([], { exec: async ({ stream, client, clients, forwards }) => {
      assert.ok(clients.has(client));
      if (deny) {
        startedExec(); await gate;
        assert.ok(clients.has(client), 'disconnect waits while jump authentication is still active');
        stream.stderr.write('fixture cleanup denied'); stream.exit(1); stream.end();
      } else {
        const owner = forwards.get(reverse.port);
        const closed = new Promise(resolve => owner.listener.once('close', resolve));
        owner.client.end();
        await closed;
        stream.write('JUMP_PORT_RELEASED\n'); stream.exit(0); stream.end();
      }
    } });
    reverse = await reverseTunnel(jump, target.port); other = await reverseTunnel(jump, target.port);
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('.connection-settings-toggle').click();
    await page.getByLabel('通过跳板机连接', { exact: true }).check();
    await page.getByLabel('连接名称', { exact: true }).fill('端口释放测试');
    await page.getByLabel('主机', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('端口', { exact: true }).fill(String(reverse.port));
    await page.getByLabel('用户名', { exact: true }).fill('tester');
    await page.getByLabel('密码', { exact: true }).fill('fixture-password');
    await page.getByLabel('选择跳板机', { exact: true }).selectOption('__manual__');
    const dialog = page.getByRole('dialog', { name: '跳板机配置' });
    for (const [label, value] of [['跳板机名称', '测试跳板'], ['跳板机主机', '127.0.0.1'], ['跳板机端口', String(jump.port)], ['跳板机用户名', 'jumper'], ['跳板机密码', 'jump-password']]) await dialog.getByLabel(label, { exact: true }).fill(value);
    await dialog.getByRole('button', { name: '保存并使用', exact: true }).click();
    await page.locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.connection-pill.connected').waitFor();
    await page.locator('.connection-actions').getByRole('button', { name: '断开', exact: true }).click();
    await started;
    assert.equal(await page.locator('.connection-actions').getByRole('button', { name: '断开中…', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).isDisabled(), true);
    assert.equal(await listening(reverse.port), true);
    finishExec();
    await page.locator('.connection-pill.connected').waitFor({ state: 'hidden' });
    await page.getByText(/fixture cleanup denied/).first().waitFor();
    assert.equal(await listening(reverse.port), true);
    assert.equal(await listening(other.port), true);
    deny = false;
    await page.locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.connection-pill.connected').waitFor();
    await page.locator('.connection-actions').getByRole('button', { name: '断开', exact: true }).click();
    await page.locator('.connection-pill.connected').waitFor({ state: 'hidden' });
    assert.equal(await listening(reverse.port), false);
    assert.equal(await listening(other.port), true);
    assert.equal(jump.commands.length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: upper disconnect waits for live jump exec, closes sessions on remote failure, reconnects, frees only selected listener and updates disconnected UI.');
  } finally {
    finishExec?.(); if (app) await app.close(); reverse?.close(); other?.close();
    if (jump) await jump.close(); if (target) await target.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
