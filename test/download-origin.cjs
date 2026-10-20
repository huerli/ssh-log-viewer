const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createServer } = require('./ssh-fixture.cjs');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-download-origin-'));
  const servers = []; let app;
  try {
    const downloads = path.join(temp, 'downloads'), config = path.join(temp, 'config'), legacy = path.join(temp, 'legacy.log');
    await fs.mkdir(config); await fs.writeFile(legacy, 'legacy log');
    await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ directories: { download: downloads }, localCopies: [{ owner: 'root@old-device:2220', remote: '/legacy.log', paths: [legacy] }] }));
    for (let index = 0; index < 2; index++) {
      const remote = path.join(temp, 'device-' + index);
      await fs.mkdir(remote); await fs.writeFile(path.join(remote, 'same.log'), `device ${index}`);
      servers.push(await createServer(remote));
    }
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: config } });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const page = await app.firstWindow();
    const oldDoc = await page.evaluate(file => window.viewer.openExtracted(file), legacy);
    assert.equal(oldDoc.origin, 'root@old-device:2220');
    const results = [];
    for (let index = 0; index < servers.length; index++) {
      const profile = { name: `设备${index}`, host: '127.0.0.1', port: servers[index].port, username: 'tester', auth: 'password', password: 'fixture-password' };
      await page.evaluate(profile => window.viewer.connect(profile), profile);
      const downloaded = await page.evaluate(() => window.viewer.download('/same.log'));
      assert.match(path.relative(downloads, downloaded.destination), /^127\.0\.0\.1[/\\]root[/\\]\d{4}-\d{2}-\d{2}[/\\]same(?:-[a-f0-9]{8})?\.log$/);
      if (index === 0) assert.equal(path.basename(downloaded.destination), 'same.log');
      assert.equal(await fs.readFile(downloaded.destination, 'utf8'), `device ${index}`);
      assert.ok(downloaded.origin.includes(`tester@127.0.0.1:${profile.port}`));
      const doc = await page.evaluate(() => window.viewer.openRemote('/same.log'));
      assert.equal(doc.remote, false); assert.equal(doc.origin, downloaded.origin);
      results.push(downloaded);
      await page.evaluate(() => window.viewer.disconnect());
    }
    assert.notEqual(results[0].destination, results[1].destination);
    await app.close();
    app = await _electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: config } });
    const restarted = await app.firstWindow();
    const restored = await restarted.evaluate(file => window.viewer.openExtracted(file), results[0].destination);
    assert.equal(restored.origin, results[0].origin);
    assert.equal(await fs.readFile(legacy, 'utf8'), 'legacy log');
    console.log('Download origin passed: two devices with the same filename remain identifiable, stored origin survives restart, and legacy file source is displayed without renaming.');
  } finally { if (app) await app.close(); for (const server of servers) await server.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
