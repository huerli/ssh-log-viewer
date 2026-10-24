const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RELEASE_API = 'https://api.github.com/repos/huerli/ssh-log-viewer/releases/latest';
const RELEASES_PAGE = 'https://github.com/huerli/ssh-log-viewer/releases';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const TARGETS = {
  linux: { name: 'linux', extension: 'deb' },
  win32: { name: 'windows', extension: 'exe' },
  darwin: { name: 'macos', extension: 'dmg' },
};

// Compare numeric identifiers as strings, so even unusually large version numbers
// cannot lose precision. Build metadata does not affect SemVer precedence.
function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = /^(?:[vV])?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(id => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  return { numbers: match.slice(1, 4), prerelease, version: value.replace(/^[vV]/, '') };
}

function compareNumber(left, right) {
  return left.length === right.length ? (left === right ? 0 : left > right ? 1 : -1) : left.length > right.length ? 1 : -1;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('版本号格式无效');
  for (let i = 0; i < 3; i++) {
    const result = compareNumber(a.numbers[i], b.numbers[i]);
    if (result) return result;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumber(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason || new Error('操作已取消'));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('操作已取消'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function consumeBody(response, signal, onChunk) {
  if (!response.body?.getReader) throw new Error('服务器未返回可读取的内容');
  const reader = response.body.getReader();
  let finished = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) { finished = true; return; }
      if (value?.byteLength) await onChunk(Buffer.from(value));
    }
  } finally {
    if (!finished) Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

async function readJson(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && Number(length) > MAX_JSON_BYTES) throw new Error('更新信息超过大小限制');
  const chunks = [];
  let size = 0;
  await consumeBody(response, signal, chunk => {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('更新信息超过大小限制');
    chunks.push(chunk);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('更新信息不是有效的 JSON'); }
}

function createUpdater(options) {
  const {
    currentVersion,
    platform = process.platform,
    arch = process.arch,
    cacheDir,
    isPackaged = false,
    fetch: fetchImpl = globalThis.fetch,
    emit = () => {},
    openInstaller = async () => { throw new Error('当前环境无法打开安装程序'); },
    openReleasePage = async () => {},
    revealInstaller = async () => {},
    quit = () => {},
    releaseApiUrl = RELEASE_API,
    allowedTestOrigins = [],
    requestTimeoutMs = 15_000,
    downloadTimeoutMs = 15 * 60_000,
    downloadIdleTimeoutMs = 60_000,
    now = Date.now,
  } = options;
  if (!path.isAbsolute(cacheDir || '')) throw new Error('更新缓存目录必须是绝对路径');
  if (typeof fetchImpl !== 'function') throw new Error('缺少更新网络请求实现');

  // Only main-process test injection can add an origin. Production always uses
  // the fixed repository and exact, version-bound GitHub release asset paths.
  const testOrigins = new Set(allowedTestOrigins.map(origin => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('更新测试地址必须是本机 HTTP(S) 地址');
    }
    return url.origin;
  }));
  const apiUrl = new URL(releaseApiUrl);
  if (apiUrl.href !== RELEASE_API && (!testOrigins.has(apiUrl.origin) || apiUrl.username || apiUrl.password)) throw new Error('更新接口必须来自官方仓库');

  let snapshot = { status: 'idle', currentVersion, supported: false, isPackaged: Boolean(isPackaged), platform, arch };
  let candidate = null;
  let verifiedPath = null;
  let checkPromise = null, downloadPromise = null, installPromise = null;
  let checkController = null, downloadController = null;
  let disposed = false;
  const state = () => ({ ...snapshot });
  const publish = (patch, notify = true) => {
    snapshot = { ...snapshot, ...patch };
    if (!disposed && notify) {
      try { emit(state()); } catch { /* A closed renderer must not interrupt a verified transfer. */ }
    }
    return state();
  };
  const clearTransfer = () => ({ installerPath: undefined, downloadedBytes: 0, progress: 0 });
  const safeMessage = error => error instanceof Error ? error.message : '更新操作失败';

  function validateAssetUrl(asset, tag) {
    let url;
    try { url = new URL(asset.browser_download_url); } catch { throw new Error('更新资源地址无效'); }
    if (url.username || url.password || url.hash || url.search) throw new Error('更新资源地址无效');
    if (testOrigins.has(url.origin)) return url.href;
    const expected = ['', 'huerli', 'ssh-log-viewer', 'releases', 'download', tag, asset.name];
    let segments;
    try { segments = url.pathname.split('/').map(segment => decodeURIComponent(segment)); }
    catch { throw new Error('更新资源地址无效'); }
    if (url.origin !== 'https://github.com' || segments.length !== expected.length || segments.some((segment, index) => segment !== expected[index])) throw new Error('更新资源必须来自官方仓库的当前版本');
    return url.href;
  }

  async function request(url, controller, json = false) {
    const original = new URL(url);
    let next = original;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await abortable(fetchImpl(next.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: json ? 'application/vnd.github+json' : 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `SSHLogViewer/${currentVersion}` },
      }), controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        const location = response.headers?.get('location');
        if (!location || redirects === 5) throw new Error('更新请求重定向次数过多或地址无效');
        let target;
        try { target = new URL(location, next); } catch { throw new Error('更新请求重定向地址无效'); }
        const testAllowed = testOrigins.has(original.origin) && testOrigins.has(target.origin);
        const sameOfficialPath = target.origin === original.origin && target.pathname === original.pathname;
        const assetCdn = original.origin === 'https://github.com' && !target.port && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname);
        if (target.username || target.password || target.hash || (!testAllowed && (target.protocol !== 'https:' || (!sameOfficialPath && !assetCdn)))) throw new Error('更新请求被重定向到了不可信的地址');
        next = target;
        continue;
      }
      if (!response.ok) {
        Promise.resolve(response.body?.cancel()).catch(() => {});
        if (response.status === 403 || response.status === 429) throw new Error('更新服务暂时限流，请稍后重试');
        throw new Error(`更新服务器返回 HTTP ${response.status}`);
      }
      // Electron net.fetch does not reliably populate Response.url. All redirect
      // destinations above are checked before any request is sent instead.
      return response;
    }
  }

  function singleAsset(assets, name) {
    const matches = assets.filter(asset => asset && asset.name === name);
    if (matches.length > 1) throw new Error('发布版本包含重复的更新资源');
    return matches[0];
  }

  function validSize(size, maximum) { return Number.isSafeInteger(size) && size > 0 && size <= maximum; }

  function check() {
    if (disposed) return Promise.resolve(state());
    if (checkPromise) return checkPromise;
    if (downloadPromise || installPromise || snapshot.status === 'ready') return Promise.resolve(state());
    const previous = state();
    const previousCandidate = candidate;
    candidate = null;
    verifiedPath = null;
    const controller = new AbortController();
    checkController = controller;
    const timer = setTimeout(() => controller.abort(new Error('检查更新超时，请稍后重试')), requestTimeoutMs);
    publish({ status: 'checking', latestVersion: undefined, name: undefined, notes: undefined, publishedAt: undefined, releaseUrl: undefined, assetName: undefined, size: undefined, checkedAt: undefined, supported: false, error: undefined, ...clearTransfer() });
    checkPromise = (async () => {
      await Promise.resolve();
      try {
        if (!parseVersion(currentVersion)) throw new Error('当前版本号格式无效，无法检查更新');
        const release = await readJson(await request(apiUrl.href, controller, true), controller.signal);
        if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('发布版本信息无效');
        if (release.draft || release.prerelease) return publish({ status: 'up-to-date', checkedAt: new Date(now()).toISOString(), supported: false });
        const version = parseVersion(release.tag_name);
        if (!version) throw new Error('发布版本号格式无效');
        if (version.prerelease.length) {
          return publish({ status: 'up-to-date', checkedAt: new Date(now()).toISOString(), supported: false });
        }
        const releaseInfo = {
          latestVersion: version.version,
          name: typeof release.name === 'string' ? release.name.slice(0, 1000) : version.version,
          notes: typeof release.body === 'string' ? release.body.slice(0, 100_000) : '',
          publishedAt: typeof release.published_at === 'string' ? release.published_at.slice(0, 100) : undefined,
          releaseUrl: `${RELEASES_PAGE}/tag/${encodeURIComponent(release.tag_name)}`,
          checkedAt: new Date(now()).toISOString(),
        };
        publish(releaseInfo, false);
        if (compareVersions(version.version, currentVersion) <= 0) return publish({ status: 'up-to-date', supported: false });
        const target = TARGETS[platform];
        if (!target || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(arch)) return publish({ status: 'available', supported: false, error: '此版本没有适用于当前平台的安装包，请前往发布页面手动下载。' });
        if (!Array.isArray(release.assets)) throw new Error('发布版本缺少资源列表');
        const metadataName = `ssh-log-viewer-${version.version}-${target.name}.update.json`;
        const metadataAsset = singleAsset(release.assets, metadataName);
        if (!metadataAsset) return publish({ status: 'available', supported: false, error: '此版本未提供自动更新元数据，请前往发布页面手动下载。' });
        if (!validSize(metadataAsset.size, MAX_JSON_BYTES)) throw new Error('更新元数据大小无效');
        const metadataUrl = validateAssetUrl(metadataAsset, release.tag_name);
        const metadata = await readJson(await request(metadataUrl, controller), controller.signal);
        if (!metadata || metadata.schemaVersion !== 1 || metadata.version !== version.version) throw new Error('更新元数据的版本或格式无效');
        if (metadata.platform !== platform || metadata.arch !== arch) return publish({ status: 'available', supported: false, error: `最新安装包不支持当前平台或架构（${platform}/${arch}），请前往发布页面查看。` });
        const installerName = `ssh-log-viewer-${version.version}-${target.name}.${target.extension}`;
        if (metadata.asset !== installerName || !validSize(metadata.size, MAX_INSTALLER_BYTES) || typeof metadata.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(metadata.sha256)) throw new Error('更新安装包的校验信息无效');
        const installerAsset = singleAsset(release.assets, installerName);
        if (!installerAsset || installerAsset.size !== metadata.size) throw new Error('发布资源与更新元数据的安装包大小不一致');
        candidate = { version: version.version, name: installerName, size: metadata.size, sha256: metadata.sha256.toLowerCase(), url: validateAssetUrl(installerAsset, release.tag_name) };
        return publish({ status: 'available', supported: true, assetName: candidate.name, size: candidate.size, error: undefined });
      } catch (error) {
        if (controller.signal.reason?.cancelled) { candidate = previousCandidate; return publish(previous); }
        if (!controller.signal.aborted) controller.abort(error);
        return publish({ status: 'error', supported: false, error: safeMessage(controller.signal.aborted ? controller.signal.reason : error), checkedAt: new Date(now()).toISOString() });
      } finally {
        clearTimeout(timer);
        checkController = null;
        checkPromise = null;
      }
    })();
    return checkPromise;
  }

  async function verifyFile(filename, expected, signal) {
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected.size) throw new Error('安装包大小校验失败，请重新下载');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      while (true) {
        if (signal?.aborted) throw signal.reason;
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (signal?.aborted) throw signal.reason;
        if (!bytesRead) break;
        total += bytesRead;
        if (total > expected.size) throw new Error('安装包大小校验失败，请重新下载');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (total !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('安装包 SHA-256 校验失败，请重新下载');
    } finally { await handle.close(); }
  }

  function download() {
    if (disposed) return Promise.resolve(state());
    if (downloadPromise) return downloadPromise;
    if (checkPromise) return checkPromise;
    if (installPromise) return installPromise;
    if (!candidate) return Promise.resolve(publish({ status: 'error', error: snapshot.error || '请先检查并选择受支持的新版本' }));
    const expected = { ...candidate };
    const controller = new AbortController();
    downloadController = controller;
    verifiedPath = null;
    let temporary = null, handle = null, idleTimer;
    const totalTimer = setTimeout(() => controller.abort(new Error('下载更新超时，请重试')), downloadTimeoutMs);
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('下载更新长时间无响应，请重试')), downloadIdleTimeoutMs);
    };
    publish({ status: 'downloading', error: undefined, ...clearTransfer() });
    downloadPromise = (async () => {
      try {
        const directory = path.join(cacheDir, expected.version, `${platform}-${arch}`);
        const destination = path.join(directory, expected.name);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        if (controller.signal.aborted) throw controller.signal.reason;
        try {
          await verifyFile(destination, expected, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          verifiedPath = destination;
          return publish({ status: 'ready', installerPath: destination, downloadedBytes: expected.size, progress: 100, error: undefined });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error.code !== 'ENOENT') await fs.rm(destination, { force: true });
        }
        temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.part`;
        handle = await fs.open(temporary, 'wx', 0o600);
        touch();
        const response = await request(expected.url, controller);
        const contentLength = response.headers?.get('content-length');
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expected.size)) throw new Error('安装包下载大小与发布信息不一致');
        const hash = crypto.createHash('sha256');
        let downloaded = 0, lastNotified = 0;
        await consumeBody(response, controller.signal, async chunk => {
          touch();
          downloaded += chunk.length;
          if (downloaded > expected.size) throw new Error('安装包下载大小超过发布信息');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            if (controller.signal.aborted) throw controller.signal.reason;
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error('无法写入更新安装包');
            offset += bytesWritten;
          }
          const timestamp = now();
          const notify = timestamp - lastNotified >= 150 || downloaded === expected.size;
          publish({ downloadedBytes: downloaded, progress: downloaded / expected.size * 100 }, notify);
          if (notify) lastNotified = timestamp;
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        if (downloaded !== expected.size) throw new Error('安装包下载不完整，请重试');
        if (hash.digest('hex') !== expected.sha256) throw new Error('安装包 SHA-256 校验失败，请重新下载');
        await handle.sync();
        await handle.close();
        handle = null;
        if (controller.signal.aborted) throw controller.signal.reason;
        await fs.rename(temporary, destination);
        temporary = null;
        if (controller.signal.aborted) throw controller.signal.reason;
        verifiedPath = destination;
        return publish({ status: 'ready', installerPath: destination, downloadedBytes: expected.size, progress: 100, error: undefined });
      } catch (error) {
        verifiedPath = null;
        if (controller.signal.reason?.cancelled) return publish({ status: 'available', supported: true, error: undefined, ...clearTransfer() });
        if (!controller.signal.aborted) controller.abort(error);
        return publish({ status: 'error', error: safeMessage(controller.signal.aborted ? controller.signal.reason : error), installerPath: undefined });
      } finally {
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        if (handle) await handle.close().catch(() => {});
        if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
        downloadController = null;
        downloadPromise = null;
      }
    })();
    return downloadPromise;
  }

  async function cancel() {
    const cancelled = Object.assign(new Error('更新操作已取消'), { cancelled: true });
    checkController?.abort(cancelled);
    downloadController?.abort(cancelled);
    await Promise.allSettled([checkPromise, downloadPromise].filter(Boolean));
    return state();
  }

  function install() {
    if (disposed) return Promise.resolve(state());
    if (installPromise) return installPromise;
    if (downloadPromise || checkPromise) return Promise.resolve(state());
    if (!candidate || !verifiedPath) return Promise.resolve(publish({ status: 'error', error: '请先下载并校验更新安装包' }));
    const filename = verifiedPath, expected = { ...candidate };
    publish({ status: 'installing', error: undefined });
    installPromise = (async () => {
      try {
        await verifyFile(filename, expected);
        if (disposed) return state();
        const error = await openInstaller(filename);
        if (typeof error === 'string' && error) throw new Error(error);
        quit();
        return state();
      } catch (error) {
        return publish({ status: 'error', error: `无法启动更新安装程序：${safeMessage(error)}` });
      } finally { installPromise = null; }
    })();
    return installPromise;
  }

  async function openRelease() {
    if (disposed) return state();
    try { await openReleasePage(snapshot.releaseUrl || RELEASES_PAGE); }
    catch (error) { publish({ error: `无法打开发布页面：${safeMessage(error)}` }); }
    return state();
  }

  async function reveal() {
    if (disposed || !verifiedPath) return state();
    try { await revealInstaller(verifiedPath); }
    catch (error) { publish({ error: `无法显示安装包：${safeMessage(error)}` }); }
    return state();
  }

  async function dispose() {
    disposed = true;
    await cancel();
  }

  return { state, check, download, cancel, install, openRelease, reveal, dispose };
}

module.exports = { createUpdater, compareVersions };
