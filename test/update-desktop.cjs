const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// All update traffic stays on this fixture. The downloaded bytes are deliberately
// not an installer, and every native shell operation is intercepted before use.
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-update-ui-'));
  const data = path.join(temp, 'config');
  const installer = Buffer.concat([Buffer.from('INERT UPDATE TEST FIXTURE\n'), crypto.randomBytes(2 * 1024 * 1024)]);
  const digest = crypto.createHash('sha256').update(installer).digest('hex');
  const [major, minor, patch] = require('../package.json').version.split('.').map(Number);
  const nextVersion = [major, minor, patch + 1].join('.');
  const target = process.platform === 'win32' ? 'windows.exe' : process.platform === 'darwin' ? 'macos.dmg' : 'linux.deb';
  const installerName = `ssh-log-viewer-${nextVersion}-${target}`;
  const metadataName = `ssh-log-viewer-${nextVersion}-${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}.update.json`;
  let releaseVersion = nextVersion;
  let app, origin, failCheck = false, corruptHash = false, slow = false;
  const requests = { latest: 0, metadata: 0, installer: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/installer') { res.writeHead(302, { location: `${origin}/payload` }); res.end(); return; }
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    if (req.url === '/latest') {
      requests.latest++;
      if (failCheck) { res.writeHead(503); res.end('fixture unavailable'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: `v${releaseVersion}`, draft: false, prerelease: false,
        html_url: `https://github.com/huerli/ssh-log-viewer/releases/tag/v${nextVersion}`,
        name: 'Updater integration fixture', body: 'Local fixture release notes', published_at: '2026-10-24T00:00:00Z',
        assets: [{ name: metadataName, size: 512, browser_download_url: `${origin}/metadata` }, { name: installerName, size: installer.length, browser_download_url: `${origin}/installer` }],
      }));
    } else if (req.url === '/metadata') {
      requests.metadata++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ schemaVersion: 1, version: nextVersion, platform: process.platform, arch: process.arch,
        asset: installerName, size: installer.length, sha256: corruptHash ? '0'.repeat(64) : digest }));
    } else if (req.url === '/payload') {
      requests.installer++;
      res.setHeader('content-length', installer.length);
      if (!slow) { res.end(installer); return; }
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= installer.length) { clearInterval(timer); res.end(); return; }
        res.write(installer.subarray(offset, offset + 16384)); offset += 16384;
      }, 35);
      res.once('close', () => clearInterval(timer));
    } else { res.writeHead(404); res.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const launch = async () => {
    const electron = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, VIEWER_DATA_DIR: data, VIEWER_UPDATE_TEST_URL: `${origin}/latest` } });
    await electron.evaluate(({ shell }) => {
      global.__updateShellCalls = [];
      shell.openPath = async file => { global.__updateShellCalls.push(['openPath', file]); return ''; };
      shell.openExternal = async url => { global.__updateShellCalls.push(['openExternal', url]); };
      shell.showItemInFolder = file => { global.__updateShellCalls.push(['showItemInFolder', file]); };
    });
    return electron;
  };
  const state = page => page.evaluate(() => window.viewer.updateState());
  const waitState = async (page, predicate, description) => {
    const start = Date.now(); let value;
    while (Date.now() - start < 15000) {
      value = await state(page);
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
  };
  const shellCalls = () => app.evaluate(() => global.__updateShellCalls);
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    async function openUpdateFromSettings() {
      assert.equal(await page.locator('.header-actions').getByRole('button', { name: '检查更新', exact: true }).count(), 0, 'update entry must exist only in settings');
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      if (!await settings.isVisible()) await page.locator('.header-actions').getByRole('button', { name: '设置', exact: true }).click();
      await settings.getByRole('button', { name: '检查更新…', exact: true }).click();
    }
    const available = await waitState(page, value => value.latestVersion === nextVersion, 'automatic update discovery');
    assert.equal(available.autoCheck, true);
    assert.equal(available.isPackaged, false);
    assert.equal(requests.latest, 1, 'one startup check');
    assert.equal(requests.installer, 0, 'automatic checks never download installers');
    await openUpdateFromSettings();
    let dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
    await dialog.waitFor();
    await dialog.getByText('Local fixture release notes', { exact: false }).waitFor();
    assert.match(await dialog.innerText(), /源码|开发|安装版|打包/);
    await dialog.getByRole('button', { name: '查看发布说明', exact: true }).click();
    assert.equal((await shellCalls()).filter(call => call[0] === 'openExternal').length, 1);

    failCheck = true;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => Boolean(value.error), 'check error');
    failCheck = false;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => !value.error && value.latestVersion === nextVersion, 'check retry');

    releaseVersion = require('../package.json').version;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => value.latestVersion === value.currentVersion && value.status !== 'checking', 'current release');
    assert.equal(requests.installer, 0);
    releaseVersion = nextVersion;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => value.latestVersion === nextVersion && value.status !== 'checking', 'available release restored');

    slow = true;
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click();
    await waitState(page, value => value.status === 'downloading' && Number(value.progress?.received ?? value.progress?.receivedBytes ?? value.progress) > 0, 'download progress');
    await dialog.getByRole('button', { name: '取消下载', exact: true }).click();
    await waitState(page, value => value.status !== 'downloading', 'download cancellation');
    assert.equal((await shellCalls()).filter(call => call[0] === 'openPath').length, 0);

    slow = false; corruptHash = true;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => !value.error && value.latestVersion === nextVersion && value.status !== 'checking', 'release with invalid checksum');
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click();
    const invalid = await waitState(page, value => Boolean(value.error), 'checksum rejection');
    assert.match(invalid.error, /SHA|校验|哈希|hash/i);
    assert.ok(!invalid.installerPath, 'invalid downloads must never become installable');
    await page.evaluate(async () => { try { await window.viewer.installUpdate(); } catch {} });
    assert.equal((await shellCalls()).filter(call => call[0] === 'openPath').length, 0, 'rejected installer never opens');

    corruptHash = false;
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => !value.error && value.latestVersion === nextVersion, 'fresh valid release');
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click();
    const ready = await waitState(page, value => Boolean(value.installerPath), 'verified installer');
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(ready.installerPath)).digest('hex'), digest);
    await dialog.getByRole('button', { name: '显示安装包', exact: true }).click();
    assert.ok((await shellCalls()).some(call => call[0] === 'showItemInFolder' && call[1] === ready.installerPath));
    await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, '../artifacts/update-ready.png') });

    // Exercise preferences through the actual settings card and its portal entry.
    await dialog.getByRole('button', { name: /关闭/ }).click();
    if (!await page.getByRole('dialog', { name: '设置', exact: true }).isVisible()) await page.locator('.header-actions').getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('自动检查更新', { exact: true }).uncheck();
    await waitState(page, value => value.autoCheck === false, 'saved preference');
    await settings.getByRole('button', { name: '检查更新…', exact: true }).click();
    await dialog.waitFor();
    await app.close(); app = undefined;
    const countBeforeRestart = requests.latest;
    app = await launch(); page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.viewer));
    assert.equal((await state(page)).autoCheck, false);
    await page.waitForTimeout(2000);
    assert.equal(requests.latest, countBeforeRestart, 'disabled automatic checks persist after restart');
    await openUpdateFromSettings();
    dialog = page.getByRole('dialog', { name: '软件更新', exact: true });
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await waitState(page, value => value.latestVersion === nextVersion && value.status !== 'checking', 'manual check after restart');
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click();
    const finalReady = await waitState(page, value => Boolean(value.installerPath), 'verified installer after restart');
    // An OS launch failure must leave the application open and explain the error.
    await app.evaluate(({ shell }) => {
      shell.openPath = async file => { global.__updateShellCalls.push(['openPathFailure', file]); return 'fixture installer launch denied'; };
    });
    await dialog.getByRole('button', { name: '退出并安装', exact: true }).click();
    await waitState(page, value => Boolean(value.error), 'installer launch failure');
    assert.ok((await shellCalls()).some(call => call[0] === 'openPathFailure' && call[1] === finalReady.installerPath));
    await app.evaluate(({ shell }) => {
      shell.openPath = async file => { global.__updateShellCalls.push(['openPath', file]); return ''; };
    });
    assert.deepEqual(errors, []);
    await Promise.all([app.waitForEvent('close'), dialog.getByRole('button', { name: '退出并安装', exact: true }).click()]);
    app = undefined;
    console.log('PASS: automatic discovery without downloads, manual checks and current version, release notes, error/retry, download progress/cancel, checksum rejection, verified download/reveal, preference persistence, failed installer launch recovery and successful install exit (native shell fully mocked).');
  } finally {
    if (app) await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
