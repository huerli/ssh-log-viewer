const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-connection-transfer-'));
  let app;
  try {
    await fs.mkdir(path.join(temp, 'config'), { recursive: true });
    await fs.writeFile(path.join(temp, 'config/settings.json'), JSON.stringify({ sshEnabled: true, telnetEnabled: true, autoCheckUpdates: false }));
    app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0', VIEWER_DATA_DIR: path.join(temp, 'config') }, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.locator('.app').waitFor();
    await page.evaluate(async () => {
      await window.viewer.saveProfile({ name: '迁移 SSH', host: '192.0.2.1', port: 22, username: 'tester', auth: 'password', keyPath: '', password: 'secret-password', rememberPassword: true });
      localStorage.setItem('direct-telnet-nodes', JSON.stringify([{ id: 'direct-1', name: '迁移 Telnet', host: '192.0.2.2', port: 23 }]));
      localStorage.setItem('web-telnet-nodes', JSON.stringify([{ id: 'web-1', name: '迁移 Web', address: 'http://example.test', username: 'tester', rememberPassword: true }]));
    });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await page.evaluate(() => {
      window.__connectionTransfer = null;
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => { const url = originalCreate(blob); window.__connectionTransfer = { blob, url }; return url; };
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__connectionTransfer.filename = this.download; return originalClick.call(this); };
    });
    await settings.getByRole('button', { name: '导出登录配置', exact: true }).click();
    const exported = await page.evaluate(async () => ({ filename: window.__connectionTransfer.filename, payload: JSON.parse(await window.__connectionTransfer.blob.text()) }));
    assert.match(exported.filename, /^ssh-log-viewer-connections-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exported.payload.sshProfiles[0].name, '迁移 SSH');
    assert.equal(exported.payload.directTelnetNodes[0].host, '192.0.2.2');
    assert.equal(exported.payload.webTelnetNodes[0].address, 'http://example.test');
    assert.equal(JSON.stringify(exported.payload).includes('secret-password'), false, 'export must not contain SSH passwords');
    const importFile = path.join(temp, 'import.json');
    await fs.writeFile(importFile, JSON.stringify({ format: 'ssh-log-viewer-connection-config', version: 1, sshProfiles: [{ name: '导入 SSH', host: '192.0.2.3', port: 22, username: 'imported', auth: 'agent', keyPath: '', rememberPassword: false }], sshJumpProfiles: [], directTelnetNodes: [{ name: '导入 Telnet', host: '192.0.2.4', port: 2323 }], webTelnetNodes: [] }));
    await settings.getByLabel('导入登录配置文件', { exact: true }).setInputFiles(importFile);
    await settings.getByRole('status').waitFor();
    const state = await page.evaluate(async () => ({ settings: await window.viewer.settings(), direct: JSON.parse(localStorage.getItem('direct-telnet-nodes')) }));
    assert.ok(state.settings.profiles.some(profile => profile.name === '导入 SSH'));
    assert.ok(state.direct.some(node => node.host === '192.0.2.4' && node.port === 2323));
    console.log('PASS: SSH/Telnet login config export/import excludes secrets and appends imported nodes');
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
