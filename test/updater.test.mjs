import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import updaterModule from '../electron/updater.cjs';

const { createUpdater, compareVersions } = updaterModule;
const API = 'https://64.81.112.231:9443/ssh-log-viewer/latest.json';
const SERVER = 'https://64.81.112.231:9443/ssh-log-viewer/releases';
const GITHUB = 'https://github.com/huerli/ssh-log-viewer/releases';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'viewer-updater-'));
  const installer = Buffer.from('fixture installer; never execute this file');
  const metadata = { schemaVersion: 1, version: '0.0.6', platform: 'linux', arch: 'x64', asset: 'ssh-log-viewer-0.0.6-linux.deb', size: installer.length, sha256: sha256(installer) };
  const asset = name => ({ name, size: name.endsWith('.json') ? Buffer.byteLength(JSON.stringify(metadata)) : installer.length, browser_download_url: `${SERVER}/v0.0.6/${name}` });
  const release = { tag_name: 'v0.0.6', draft: false, prerelease: false, name: 'Version 0.0.6', body: 'Release notes', published_at: '2026-10-24T00:00:00Z', html_url: 'https://untrusted.invalid', assets: [asset('ssh-log-viewer-0.0.6-linux.update.json'), asset(metadata.asset)] };
  const calls = [], emitted = [], opened = [], revealed = [], pages = [];
  const data = { cacheDir, metadata, release, installer, calls, emitted, opened, revealed, pages, quitCount: 0, handler: null };
  const config = {
    currentVersion: '0.0.5', platform: 'linux', arch: 'x64', cacheDir, isPackaged: true,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (data.handler) {
        const response = await data.handler(url, init);
        if (response !== undefined) return response;
      }
      if (url === API) return json(release);
      if (url === release.assets[0]?.browser_download_url) return json(metadata);
      if (url === release.assets[1]?.browser_download_url) return new Response(data.installer);
      throw new Error(`Unexpected request: ${url}`);
    },
    emit: value => { emitted.push(value); data.onState?.(value); },
    openInstaller: async filename => { opened.push(filename); return ''; },
    openReleasePage: async url => { pages.push(url); },
    revealInstaller: async filename => { revealed.push(filename); },
    quit: () => { data.quitCount++; },
    ...options,
  };
  data.updater = createUpdater(config);
  data.reopen = overrides => createUpdater({ ...config, ...overrides });
  t.after(async () => { await data.updater.dispose(); await rm(cacheDir, { recursive: true, force: true }); });
  return data;
}

async function files(directory) {
  return readdir(directory, { recursive: true });
}

test('SemVer compares stable, prerelease and build versions without numeric precision loss', () => {
  for (const [newer, older] of [
    ['0.0.10', '0.0.9'], ['V1.0.0', 'v0.99.99'], ['1.0.0', '1.0.0-rc.9'],
    ['1.0.0-beta.11', '1.0.0-beta.2'], ['1.0.0-beta.a', '1.0.0-beta.99'],
    ['1.0.0-beta.1', '1.0.0-beta'], ['99999999999999999999.0.0', '99999999999999999998.0.0'],
  ]) {
    assert.equal(compareVersions(newer, older), 1);
    assert.equal(compareVersions(older, newer), -1);
  }
  assert.equal(compareVersions('1.0.0+build.2', 'v1.0.0+build.1'), 0);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.2+build'), 0);
  for (const invalid of ['1.2', '01.2.3', '1.2.3-01', '1.2.3-', '../../1.2.3', '1.2.3\n']) assert.throws(() => compareVersions(invalid, '1.2.3'));
});

test('check only reads release and exact metadata, emits detached state, and pins release page', async t => {
  const f = await fixture(t, { isPackaged: false, now: () => 1_000 });
  const result = await f.updater.check();
  assert.equal(result.status, 'available');
  assert.equal(result.supported, true);
  assert.equal(result.isPackaged, false);
  assert.equal(result.latestVersion, '0.0.6');
  assert.equal(result.checkedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(result.releaseUrl, `${GITHUB}/tag/v0.0.6`);
  assert.deepEqual(f.calls.map(call => call.url), [API, f.release.assets[0].browser_download_url]);
  assert.equal(f.opened.length, 0);
  result.status = 'forged';
  f.emitted[0].status = 'forged';
  assert.equal(f.updater.state().status, 'available');
  await f.updater.openRelease('https://untrusted.invalid');
  assert.deepEqual(f.pages, [`${GITHUB}/tag/v0.0.6`]);
});

test('equal/newer current versions never download or downgrade; stable supersedes same-version prerelease', async t => {
  for (const currentVersion of ['0.0.6', '0.0.6+build.8', '0.0.7', '1.0.0-beta.1']) {
    const f = await fixture(t, { currentVersion });
    assert.equal((await f.updater.check()).status, 'up-to-date');
    assert.equal(f.calls.length, 1);
    assert.equal((await f.updater.download()).status, 'error');
    assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t, { currentVersion: '0.0.6-rc.1' });
  assert.equal((await f.updater.check()).status, 'available');
});

test('drafts and prereleases are ignored, including prerelease tags with incorrect stable flags', async t => {
  for (const change of [{ draft: true, tag_name: 'invalid' }, { prerelease: true }, { tag_name: '1.0.0-beta.1' }]) {
    const f = await fixture(t);
    Object.assign(f.release, change);
    assert.equal((await f.updater.check()).status, 'up-to-date');
    assert.equal(f.calls.length, 1);
  }
});

test('upper-case V tags and literal plus signs in version-bound GitHub paths are supported', async t => {
  const f = await fixture(t);
  f.release.tag_name = 'V0.0.6+build.9';
  f.metadata.version = '0.0.6+build.9';
  f.metadata.asset = 'ssh-log-viewer-0.0.6+build.9-linux.deb';
  f.release.assets[0].name = 'ssh-log-viewer-0.0.6+build.9-linux.update.json';
  f.release.assets[1].name = f.metadata.asset;
  for (const asset of f.release.assets) asset.browser_download_url = `${SERVER}/${f.release.tag_name}/${asset.name}`;
  assert.equal((await f.updater.check()).status, 'available');
  assert.equal((await f.updater.download()).status, 'ready');
});

test('legacy public release V0.0.5 without metadata reports current version correctly', async t => {
  const f = await fixture(t);
  f.release.tag_name = 'V0.0.5';
  f.release.assets = ['deb', 'exe', 'dmg'].flatMap(extension => [{ name: `ssh-log-viewer-0.0.5.${extension}` }, { name: `ssh-log-viewer-0.0.5.${extension}.sha256` }]);
  assert.equal((await f.updater.check()).status, 'up-to-date');
  assert.equal(f.calls.length, 1);
});

test('Windows and macOS require their exact platform installer and matching architecture', async t => {
  for (const [platform, target, extension, arch] of [['win32', 'windows', 'exe', 'x64'], ['darwin', 'macos', 'dmg', 'arm64']]) {
    const f = await fixture(t, { platform, arch });
    Object.assign(f.metadata, { platform, arch, asset: `ssh-log-viewer-0.0.6-${target}.${extension}` });
    f.release.assets[0].name = `ssh-log-viewer-0.0.6-${target}.update.json`;
    f.release.assets[1].name = f.metadata.asset;
    for (const asset of f.release.assets) asset.browser_download_url = `${SERVER}/v0.0.6/${asset.name}`;
    assert.equal((await f.updater.check()).supported, true);
    const downloaded = await f.updater.download();
    assert.equal(downloaded.status, 'ready');
    assert.equal(path.extname(downloaded.installerPath), `.${extension}`);
  }
});

test('old releases without metadata and incompatible architectures offer manual release page', async t => {
  const missing = await fixture(t);
  missing.release.assets.shift();
  let state = await missing.updater.check();
  assert.equal(state.status, 'available');
  assert.equal(state.supported, false);
  assert.match(state.error, /元数据/);
  assert.equal(missing.calls.length, 1);
  assert.equal((await missing.updater.download()).status, 'error');
  assert.equal(missing.calls.length, 1);

  const mismatch = await fixture(t, { arch: 'arm64' });
  state = await mismatch.updater.check();
  assert.equal(state.status, 'available');
  assert.equal(state.supported, false);
  assert.match(state.error, /架构/);
  assert.equal(mismatch.calls.length, 2);

  const unsupported = await fixture(t, { platform: 'freebsd' });
  assert.equal((await unsupported.updater.check()).supported, false);
  assert.equal(unsupported.calls.length, 1);
});

async function macFixture(t, arch, legacyArch = 'arm64', includeX64 = true) {
  const f = await fixture(t, { platform: 'darwin', arch });
  const metadata = new Map();
  const installers = new Map();
  f.release.assets = [];
  for (const [target, targetArch] of [['macos', legacyArch], ...(includeX64 ? [['macos-x64', 'x64']] : [])]) {
    const name = `ssh-log-viewer-0.0.6-${target}`;
    const installer = Buffer.from(`macOS ${targetArch} installer`);
    const info = { ...f.metadata, platform: 'darwin', arch: targetArch, asset: `${name}.dmg`, size: installer.length, sha256: sha256(installer) };
    metadata.set(`${name}.update.json`, info);
    installers.set(info.asset, installer);
    for (const [assetName, size] of [[`${name}.update.json`, Buffer.byteLength(JSON.stringify(info))], [info.asset, installer.length]]) {
      f.release.assets.push({ name: assetName, size, browser_download_url: `${SERVER}/v0.0.6/${assetName}` });
    }
  }
  f.handler = url => {
    const asset = f.release.assets.find(asset => asset.browser_download_url === url);
    if (asset) return metadata.has(asset.name) ? json(metadata.get(asset.name)) : new Response(installers.get(asset.name));
  };
  return { ...f, macMetadata: metadata, macInstallers: installers };
}

test('coexisting macOS installers select x64 metadata for Intel and legacy arm64 metadata for Apple Silicon', async t => {
  for (const [arch, target] of [['x64', 'macos-x64'], ['arm64', 'macos']]) {
    const f = await macFixture(t, arch);
    const name = `ssh-log-viewer-0.0.6-${target}`;
    const state = await f.updater.check();
    assert.equal(state.supported, true);
    assert.equal(state.platform, 'darwin');
    assert.equal(state.arch, arch);
    assert.equal(state.assetName, `${name}.dmg`);
    assert.deepEqual(f.calls.map(call => call.url), [API, `${SERVER}/v0.0.6/${name}.update.json`]);
    const downloaded = await f.updater.download();
    assert.equal(downloaded.status, 'ready');
    assert.equal(path.basename(downloaded.installerPath), `${name}.dmg`);
    assert.deepEqual(await readFile(downloaded.installerPath), f.macInstallers.get(`${name}.dmg`));
  }
});

test('Intel macOS falls back to legacy metadata only when its architecture matches', async t => {
  for (const legacyArch of ['x64', 'arm64']) {
    const f = await macFixture(t, 'x64', legacyArch, false);
    const state = await f.updater.check();
    assert.equal(state.status, 'available');
    assert.equal(state.supported, legacyArch === 'x64');
    if (state.supported) {
      assert.equal(state.assetName, 'ssh-log-viewer-0.0.6-macos.dmg');
      assert.equal((await f.updater.download()).status, 'ready');
    } else {
      assert.match(state.error, /架构/);
      assert.equal((await f.updater.download()).status, 'error');
      assert.equal(f.calls.length, 2);
    }
  }
});

test('invalid exact macOS x64 metadata never falls back to a compatible legacy installer', async t => {
  for (const change of [{ platform: 'linux' }, { arch: 'arm64' }, { schemaVersion: 2 }, { asset: 'ssh-log-viewer-0.0.6-macos.dmg' }, { sha256: 'invalid' }]) {
    const f = await macFixture(t, 'x64', 'x64');
    Object.assign(f.macMetadata.get('ssh-log-viewer-0.0.6-macos-x64.update.json'), change);
    const state = await f.updater.check();
    assert.equal(state.supported, false, JSON.stringify(change));
    assert.equal(state.status, change.platform || change.arch ? 'available' : 'error');
    assert.deepEqual(f.calls.map(call => call.url), [API, `${SERVER}/v0.0.6/ssh-log-viewer-0.0.6-macos-x64.update.json`]);
    assert.equal((await f.updater.download()).status, 'error');
    assert.equal(f.calls.length, 2);
  }
});

test('macOS x64 exact resources retain duplicate, official URL and installer presence validation', async t => {
  for (const mode of ['duplicate', 'external', 'missing-installer']) {
    const f = await macFixture(t, 'x64', 'x64');
    const metadataAsset = f.release.assets.find(asset => asset.name.endsWith('-macos-x64.update.json'));
    if (mode === 'duplicate') f.release.assets.push({ ...metadataAsset });
    if (mode === 'external') metadataAsset.browser_download_url = 'https://untrusted.invalid/metadata.json';
    if (mode === 'missing-installer') f.release.assets = f.release.assets.filter(asset => !asset.name.endsWith('-macos-x64.dmg'));
    const state = await f.updater.check();
    assert.equal(state.status, 'error', mode);
    assert.equal(state.supported, false);
    assert.equal(f.calls.length, mode === 'missing-installer' ? 2 : 1);
    assert.equal((await f.updater.download()).status, 'error');
  }
});

test('metadata must bind exact version, platform, architecture, installer name, size and digest', async t => {
  const invalidMetadata = [
    { schemaVersion: 2 }, { version: '0.0.7' }, { asset: '../../installer.deb' },
    { asset: 'ssh-log-viewer-0.0.5-linux.deb' }, { size: 0 }, { size: 2 * 1024 * 1024 * 1024 + 1 },
    { sha256: '0'.repeat(63) }, { sha256: 'z'.repeat(64) },
  ];
  for (const change of invalidMetadata) {
    const f = await fixture(t);
    Object.assign(f.metadata, change);
    const state = await f.updater.check();
    assert.equal(state.status, 'error', JSON.stringify(change));
    assert.equal(state.supported, false);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.updater.install()).status, 'error');
    assert.equal(f.opened.length, 0);
  }
  const f = await fixture(t);
  f.release.assets[1].size++;
  assert.match((await f.updater.check()).error, /大小不一致/);
});

test('metadata and installer URL validation rejects external hosts, wrong repos, tags and encoded path separators', async t => {
  for (const url of [
    'https://untrusted.invalid/setup.deb',
    `${SERVER}/v0.0.5/ssh-log-viewer-0.0.6-linux.deb`,
    'https://github.com/other/ssh-log-viewer/releases/download/v0.0.6/ssh-log-viewer-0.0.6-linux.deb',
    `${SERVER}/v0.0.6%2fssh-log-viewer-0.0.6-linux.deb`,
    `${SERVER}/v0.0.6/ssh-log-viewer-0.0.6-linux.deb?other=1`,
    `${SERVER}/v0.0.6/ssh-log-viewer-0.0.6-linux.deb#fragment`,
    'http://github.com/huerli/ssh-log-viewer/releases/download/v0.0.6/ssh-log-viewer-0.0.6-linux.deb',
  ]) {
    const f = await fixture(t);
    f.release.assets[1].browser_download_url = url;
    assert.equal((await f.updater.check()).status, 'error', url);
    assert.equal(f.calls.length, 2);
  }
  const f = await fixture(t);
  f.release.assets[0].browser_download_url = 'https://untrusted.invalid/metadata.json';
  assert.equal((await f.updater.check()).status, 'error');
  assert.equal(f.calls.length, 1);
});

test('bounded JSON, malformed JSON and ambiguous release assets are rejected', async t => {
  for (const response of [
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response('{invalid'),
    () => json([]),
  ]) {
    const f = await fixture(t);
    f.handler = url => url === API ? response() : undefined;
    assert.equal((await f.updater.check()).status, 'error');
  }
  const f = await fixture(t);
  f.release.assets.push({ ...f.release.assets[0] });
  assert.match((await f.updater.check()).error, /重复/);
});

test('network errors, rate limits and timeout checks are recoverable and deduplicate concurrent requests', async t => {
  const f = await fixture(t);
  f.handler = url => url === API ? new Response('Unavailable', { status: 503 }) : undefined;
  assert.match((await f.updater.check()).error, /503/);
  f.handler = url => url === API ? new Response('Rate limited', { status: 403 }) : undefined;
  assert.match((await f.updater.check()).error, /限流/);
  f.handler = null;
  const checking = f.updater.check();
  assert.equal(f.updater.check(), checking);
  assert.equal((await checking).status, 'available');
  const stalled = await fixture(t, { requestTimeoutMs: 10 });
  stalled.handler = () => new Promise(() => {});
  assert.match((await stalled.updater.check()).error, /超时/);
  stalled.handler = null;
  assert.equal((await stalled.updater.check()).status, 'available');
});

test('streamed download verifies content, reports percent, reuses verified cache, and never auto-installs', async t => {
  const f = await fixture(t);
  await f.updater.check();
  const downloading = f.updater.download();
  assert.equal(f.updater.download(), downloading);
  assert.equal((await f.updater.check()).status, 'downloading');
  const state = await downloading;
  assert.equal(state.status, 'ready');
  assert.equal(state.progress, 100);
  assert.equal(state.downloadedBytes, f.installer.length);
  assert.deepEqual(await readFile(state.installerPath), f.installer);
  assert.equal(f.opened.length, 0);
  assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
  const calls = f.calls.length;
  assert.equal((await f.updater.check()).status, 'ready');
  assert.equal(f.calls.length, calls);

  const reopened = f.reopen();
  t.after(() => reopened.dispose());
  await reopened.check();
  const beforeDownload = f.calls.length;
  assert.equal((await reopened.download()).status, 'ready');
  assert.equal(f.calls.length, beforeDownload);
});

test('bad hashes are never ready or installable; retry uses the known candidate and clears partials', async t => {
  const f = await fixture(t);
  await f.updater.check();
  const original = f.installer;
  f.installer = Buffer.alloc(original.length, 1);
  const failed = await f.updater.download();
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /SHA-256/);
  assert.equal(failed.installerPath, undefined);
  assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
  await f.updater.install();
  assert.equal(f.opened.length, 0);
  f.installer = original;
  assert.equal((await f.updater.download()).status, 'ready');
});

test('truncated, oversized and conflicting Content-Length installers are rejected', async t => {
  for (const mode of ['truncated', 'oversized', 'header']) {
    const f = await fixture(t);
    await f.updater.check();
    f.handler = url => {
      if (url !== f.release.assets[1].browser_download_url) return;
      if (mode === 'truncated') return new Response(f.installer.subarray(0, -1));
      if (mode === 'oversized') return new Response(Buffer.concat([f.installer, Buffer.from('x')]));
      return new Response(f.installer, { headers: { 'content-length': String(f.installer.length + 1) } });
    };
    assert.equal((await f.updater.download()).status, 'error', mode);
    assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
  }
});

function stalledResponse(bytes, onStart) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 8)); onStart?.(); },
  }));
}

test('cancel interrupts a stalled body, removes partials, preserves available update and permits retry', async t => {
  const f = await fixture(t);
  await f.updater.check();
  const firstProgress = new Promise(resolve => { f.onState = value => { if (value.progress > 0) resolve(); }; });
  f.handler = url => url === f.release.assets[1].browser_download_url ? stalledResponse(f.installer) : undefined;
  const task = f.updater.download();
  await firstProgress;
  assert.ok(f.updater.state().progress > 0);
  assert.equal((await f.updater.cancel()).status, 'available');
  assert.equal((await task).supported, true);
  assert.equal(f.updater.state().progress, 0);
  assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
  f.handler = null;
  assert.equal((await f.updater.download()).status, 'ready');
});

test('download idle and overall timeouts abort hung bodies and allow retry', async t => {
  for (const settings of [{ downloadIdleTimeoutMs: 100 }, { downloadTimeoutMs: 100, downloadIdleTimeoutMs: 1_000 }]) {
    const f = await fixture(t, settings);
    await f.updater.check();
    f.handler = url => url === f.release.assets[1].browser_download_url ? stalledResponse(f.installer) : undefined;
    assert.equal((await f.updater.download()).status, 'error');
    assert.match(f.updater.state().error, /无响应|超时/);
    assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
    f.handler = null;
    assert.equal((await f.updater.download()).status, 'ready');
  }
});

test('cache tampering is revalidated on reuse and immediately before installation', async t => {
  const f = await fixture(t);
  await f.updater.check();
  const ready = await f.updater.download();
  await writeFile(ready.installerPath, Buffer.alloc(f.installer.length, 3));
  assert.equal((await f.updater.install()).status, 'error');
  assert.equal(f.opened.length, 0);
  assert.equal(f.quitCount, 0);

  const reopened = f.reopen();
  t.after(() => reopened.dispose());
  await reopened.check();
  const calls = f.calls.length;
  const replacement = await reopened.download();
  assert.equal(replacement.status, 'ready');
  assert.equal(f.calls.length, calls + 1);
  assert.deepEqual(await readFile(replacement.installerPath), f.installer);
});

test('install launches only private verified path, returns shell errors for retry and quits after success', async t => {
  const opened = [];
  let shellError = 'System installer unavailable';
  const f = await fixture(t, { openInstaller: async filename => { opened.push(filename); return shellError; } });
  await f.updater.check();
  const ready = await f.updater.download();
  const failed = await f.updater.install('/untrusted/renderer.exe');
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /System installer unavailable/);
  assert.equal(failed.installerPath, ready.installerPath);
  assert.equal(f.quitCount, 0);
  shellError = '';
  await f.updater.install('/untrusted/renderer.exe');
  assert.deepEqual(opened, [ready.installerPath, ready.installerPath]);
  assert.equal(f.quitCount, 1);
  await f.updater.reveal('/untrusted/renderer.exe');
  assert.deepEqual(f.revealed, [ready.installerPath]);
});

test('manual redirects validate destinations before fetching and do not trust Electron Response.url', async t => {
  const f = await fixture(t);
  const metadataUrl = f.release.assets[0].browser_download_url;
  const cdn = metadataUrl;
  let redirected = false;
  f.handler = (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url === metadataUrl && !redirected) { redirected = true; return new Response(null, { status: 302, headers: { location: cdn } }); }
    if (url === cdn) {
      const response = json(f.metadata);
      Object.defineProperty(response, 'url', { value: 'https://incorrect-electron-response.invalid/' });
      return response;
    }
  };
  assert.equal((await f.updater.check()).status, 'available');
  assert.ok(f.calls.some(call => call.url === cdn));

  for (const location of ['https://evil.invalid/update.json', 'http://release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com:8443/file', 'https://github.com/other/repo/releases/download/v1/asset']) {
    const rejected = await fixture(t);
    rejected.handler = url => url === rejected.release.assets[0].browser_download_url ? new Response(null, { status: 302, headers: { location } }) : undefined;
    assert.equal((await rejected.updater.check()).status, 'error');
    assert.equal(rejected.calls.length, 2);
  }
});

test('test URL overrides require explicit loopback origins; ordinary runtime cannot change repository', async t => {
  const f = await fixture(t);
  assert.throws(() => f.reopen({ releaseApiUrl: 'https://evil.invalid/latest' }), /官方仓库/);
  assert.throws(() => f.reopen({ releaseApiUrl: 'https://evil.invalid/latest', allowedTestOrigins: ['https://evil.invalid'] }), /本机/);
  const origin = 'http://127.0.0.1:51234';
  const local = f.reopen({ releaseApiUrl: `${origin}/latest`, allowedTestOrigins: [origin], fetch: async url => {
    if (url.endsWith('/latest')) return json({ ...f.release, assets: f.release.assets.map(asset => ({ ...asset, browser_download_url: `${origin}/${asset.name}` })) });
    if (url.endsWith('.json')) return json(f.metadata);
    return new Response(f.installer);
  } });
  t.after(() => local.dispose());
  assert.equal((await local.check()).supported, true);
  assert.equal((await local.download()).status, 'ready');
  await local.openRelease();
  assert.equal(f.pages.at(-1), `${GITHUB}/tag/v0.0.6`);
});

test('dispose waits transfer cleanup without awaiting installation or emitting after closure', async t => {
  const f = await fixture(t);
  await f.updater.check();
  let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  f.handler = url => url === f.release.assets[1].browser_download_url ? stalledResponse(f.installer, started) : undefined;
  const downloading = f.updater.download();
  await bodyStarted;
  const notifications = f.emitted.length;
  await f.updater.dispose();
  await downloading;
  assert.equal(f.emitted.length, notifications);
  assert.equal((await files(f.cacheDir)).some(name => name.endsWith('.part')), false);
  const requests = f.calls.length;
  await f.updater.download();
  await f.updater.check();
  assert.equal(f.calls.length, requests);

  const installed = await fixture(t);
  await installed.updater.check();
  await installed.updater.download();
  const reentrant = installed.reopen({ quit: () => { void reentrant.dispose(); } });
  t.after(() => reentrant.dispose());
  await reentrant.check();
  await reentrant.download();
  assert.equal((await reentrant.install()).status, 'installing');
});
