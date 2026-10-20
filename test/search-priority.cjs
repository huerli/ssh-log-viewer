const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('./ssh-fixture.cjs');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-priority-'));
  let app, server;
  try {
    const logs = path.join(temp, 'remote/system/log');
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, 'a.log'), 'marker first\n');
    await fs.writeFile(path.join(logs, 'b.log'), 'marker current\n');
    server = await createServer(path.join(temp, 'remote'));
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: path.join(temp, 'config') } });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const page = await app.firstWindow();
    await page.evaluate(port => window.viewer.connect({ name: 'priority', host: '127.0.0.1', port, username: 'tester', password: 'fixture-password', auth: 'password', keyPath: '' }), server.port);
    await page.evaluate(() => window.viewer.openRemote('/system/log/b.log'));
    const all = await page.evaluate(() => window.viewer.searchFiles('/system/log', '*.log', 'marker*', { regex: false, caseSensitive: false }, 'priority-remote'));
    assert.deepEqual(all.matches.map(match => match.file), ['/system/log/b.log', '/system/log/a.log']);
    assert.equal(all.count, 2);
    const scoped = await page.evaluate(() => window.viewer.searchFiles('/system/log', 'a.log', 'marker*', { regex: false, caseSensitive: false }, 'priority-remote-scope'));
    assert.equal(scoped.files, 1);
    assert.deepEqual(scoped.matches.map(match => match.file), ['/system/log/a.log']);
    console.log('Remote search priority passed: current file first, wildcard content, unchanged filename scope and no duplicates.');
  } finally { if (app) await app.close(); if (server) await server.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
