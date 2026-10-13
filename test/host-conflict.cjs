const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createServer } = require('./ssh-fixture.cjs');
const { createJump } = require('./jump-fixture.cjs');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-host-conflict-'));
  let app, target, jump;
  const data = path.join(temp, 'config');
  const launch = () => _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: data } });
  try {
    const remote = path.join(temp, 'remote');
    await fs.mkdir(path.join(remote, 'system/log'), { recursive: true });
    await fs.mkdir(data);
    target = await createServer(remote); jump = await createJump([target.port]);
    const direct = `127.0.0.1:${target.port}`, hop = `127.0.0.1:${jump.port}`;
    const via = `via jumper@${hop} → ${direct}`;
    const old = 'a'.repeat(64), unrelated = 'b'.repeat(64);
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ hosts: { [direct]: old, [hop]: old, [via]: old, unrelated } }));
    const profile = { host: '127.0.0.1', port: target.port, username: 'tester', auth: 'password', password: 'fixture-password' };
    app = await launch(); let page = await app.firstWindow();
    await app.evaluate(({ dialog }) => {
      global.hostDialogs = [];
      dialog.showMessageBox = async (_win, options) => { global.hostDialogs.push(options); return { response: 0 }; };
    });
    await assert.rejects(page.evaluate(profile => window.viewer.connect(profile), profile), /连接失败/);
    let hosts = JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).hosts;
    assert.equal(hosts[direct], old);
    const prompt = (await app.evaluate(() => global.hostDialogs))[0];
    assert.equal(prompt.title, '目标机器指纹冲突');
    assert.equal(prompt.type, 'warning');
    assert.equal(prompt.defaultId, 0); assert.equal(prompt.cancelId, 0);
    assert.ok(prompt.buttons.includes('清除旧指纹并连接'));
    assert.ok(prompt.detail.includes('已保存的旧指纹') && prompt.detail.includes('服务器的新指纹') && prompt.detail.includes('SHA256:'));
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (_win, options) => {
        global.hostDialogs.push(options);
        return new Promise(resolve => { global.resolveHostConflict = resolve; });
      };
    });
    const initialDialogs = await app.evaluate(() => global.hostDialogs.length);
    const cancelled = page.evaluate(profile => window.viewer.connect(profile).then(() => false, () => true), profile);
    for (let attempts = 0; attempts < 100; attempts++) {
      if (await app.evaluate(() => Boolean(global.resolveHostConflict))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await app.evaluate(() => typeof global.resolveHostConflict), 'function');
    await page.evaluate(() => window.viewer.disconnect());
    await app.evaluate(() => global.resolveHostConflict({ response: 1 }));
    assert.equal(await cancelled, true);
    assert.equal(await app.evaluate(() => global.hostDialogs.length), initialDialogs + 1);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_win, options) => { global.hostDialogs.push(options); return { response: 1 }; }; });
    await page.evaluate(profile => window.viewer.connect(profile), profile);
    assert.equal((await page.evaluate(() => window.viewer.list('/system/log'))).path, '/system/log');
    await page.evaluate(() => window.viewer.disconnect());
    hosts = JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).hosts;
    assert.notEqual(hosts[direct], old); assert.match(hosts[direct], /^[a-f0-9]{64}$/);
    assert.equal(hosts.unrelated, unrelated); assert.equal(hosts[hop], old); assert.equal(hosts[via], old);
    const count = await app.evaluate(() => global.hostDialogs.length);
    await page.evaluate(profile => window.viewer.connect(profile), profile);
    assert.equal(await app.evaluate(() => global.hostDialogs.length), count);
    await page.evaluate(() => window.viewer.disconnect());
    const hopped = { ...profile, jump: { enabled: true, host: '127.0.0.1', port: jump.port, username: 'jumper', auth: 'password', password: 'jump-password' } };
    await page.evaluate(profile => window.viewer.connect(profile), hopped);
    const dialogs = (await app.evaluate(() => global.hostDialogs)).slice(count);
    assert.deepEqual(dialogs.map(prompt => prompt.title), ['跳板机指纹冲突', '目标机器指纹冲突']);
    await page.evaluate(() => window.viewer.disconnect());
    await app.close(); app = await launch(); page = await app.firstWindow();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => { throw new Error('Saved matching fingerprints should not prompt again'); }; });
    await page.evaluate(profile => window.viewer.connect(profile), hopped);
    await page.evaluate(() => window.viewer.disconnect());
    hosts = JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).hosts;
    assert.equal(hosts.unrelated, unrelated);
    assert.notEqual(hosts[hop], old); assert.notEqual(hosts[via], old);
    console.log('Host conflict passed: cancel preserves old fingerprint, aborted confirmation is ignored, confirmation replaces only the conflicting identity, jump/target handling, reconnect and restart persistence.');
  } finally { if (app) await app.close(); if (jump) await jump.close(); if (target) await target.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
