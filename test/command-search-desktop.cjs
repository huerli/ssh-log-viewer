const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-command-search-'));
  const sockets = new Set(), sent = [], errors = [];
  let app;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = '';
    socket.on('data', data => { pending += data.toString(); while (pending.includes('\n')) { const index = pending.indexOf('\n'); const text = pending.slice(0, index).trim(); pending = pending.slice(index + 1); if (text) sent.push(text); } });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(path.join(temp, 'settings.json'), JSON.stringify({ sshEnabled: true, telnetEnabled: true, autoCheckUpdates: false }));
    app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0', VIEWER_DATA_DIR: temp } });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await page.locator('.app').waitFor();
    const seed = [
      { id: 'default', name: '常用', commands: [{ id: 'local', name: '本组命令', text: 'local' }] },
      { id: 'network', device: '主控板', name: '网络诊断', commands: [{ id: 'ping', name: '检查目标连接', text: 'ping {{目标地址}}' }, { id: 'route', name: '显示路由', text: 'IP ROUTE SHOW' }] },
    ];
    await page.evaluate(({ port, seed }) => {
      localStorage.setItem('direct-telnet-nodes', JSON.stringify([{ id: 'fixture', name: '测试连接', host: '127.0.0.1', port }]));
      localStorage.setItem('telnet-command-groups', JSON.stringify(seed));
      localStorage.setItem('ssh-command-groups', JSON.stringify([{ id: 'ssh', name: 'SSH', commands: [{ id: 'only', name: 'SSH专用命令', text: 'ssh-only' }] }]));
    }, { port: server.address().port, seed });
    await page.reload();
    await page.getByLabel('Telnet 连接选择', { exact: true }).selectOption('fixture');
    await page.locator('.telnet-connection-actions').getByRole('button', { name: '连接', exact: true }).click();
    await page.getByLabel('Telnet 连接状态', { exact: true }).filter({ hasText: '已连接' }).waitFor();
    const bar = page.locator('.command-button-bar:visible');
    const search = bar.getByRole('searchbox', { name: '搜索命令', exact: true });
    const results = page.getByRole('region', { name: '命令搜索结果' });
    await search.fill('网络诊断 route');
    assert.equal(await results.getByRole('button').count(), 1);
    await results.getByRole('button', { name: /显示路由/ }).click();
    assert.equal(await bar.getByLabel('设备大组', { exact: true }).inputValue(), '主控板');
    await page.waitForFunction(() => document.querySelector('[aria-label="Telnet 输入"]'));
    await search.fill('ping');
    await results.getByRole('button', { name: /检查目标连接/ }).click();
    const parameters = page.getByRole('dialog', { name: '填写命令变量' });
    await parameters.getByLabel('目标地址', { exact: true }).fill('127.0.0.1');
    await parameters.getByRole('button', { name: '发送命令', exact: true }).click();
    await search.fill('SSH专用命令');
    await results.getByText('没有匹配的命令，请尝试其他关键词。').waitFor();
    await search.press('Escape'); await results.waitFor({ state: 'hidden' });
    await search.fill('本组命令');
    await results.getByRole('button', { name: /本组命令/ }).waitFor();
    await bar.getByRole('button', { name: '清空命令搜索' }).click();
    assert.equal(await search.inputValue(), '');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('telnet-command-groups'))), seed);
    // Give the socket event loop a turn before checking delivery.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(sent, ['IP ROUTE SHOW', 'ping 127.0.0.1']);
    assert.deepEqual(errors, []);
    console.log('PASS: cross-device/group search, multiple keywords, case-insensitive content, protocol isolation, parameter prompting, actual send, clear/Escape, unchanged configuration');
  } finally {
    if (app) await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
