const { app, BrowserWindow, ipcMain, dialog, safeStorage, screen, clipboard, shell, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { connectSession } = require('./ssh-session.cjs');
let sshSession, sshAttempt;
const { Worker } = require('node:worker_threads');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const zlib = require('node:zlib');
const { writeSearchExport } = require('./search-export.cjs');
const { extractArchive, extractLocalArchive } = require('./archive.cjs');
const { remoteSource } = require('./remote-source.cjs');
const { CredentialStore, credentialId } = require('./credentials.cjs');
const { sourceIdentity, downloadPath, extractionPath, archiveOwner, telnetLogTarget, terminalLogTarget } = require('./source-names.cjs');

if (process.platform === 'linux') {
  app.setDesktopName('com.teee.sshlogviewer.desktop');
  if (!app.isPackaged && !process.env.VIEWER_DATA_DIR) {
    try { require('../scripts/install-desktop.cjs'); }
    catch (error) { console.warn('无法安装桌面启动入口:', error.message); }
  }
  let suidConfigured = false;
  try {
    const helper = fs.statSync(path.join(path.dirname(process.execPath), 'chrome-sandbox'));
    suidConfigured = helper.uid === 0 && Boolean(helper.mode & 0o4000);
  } catch {}
  if (!suidConfigured) app.commandLine.appendSwitch('disable-setuid-sandbox');
}

if (process.env.VIEWER_DATA_DIR) {
  fs.mkdirSync(process.env.VIEWER_DATA_DIR, { recursive: true, mode: 0o700 });
  app.setPath('userData', process.env.VIEWER_DATA_DIR);
}

let win, config, configPath, cacheRoot, connection, sftp, connectionName, connectionHost, connectionOrigin, document, followTimer, credentials;
let followBusy = false, quitting = false;
let updater, updateTimer, updateInterval;
function updateSnapshot() { return { ...updater.state(), autoCheck: config.autoCheckUpdates !== false }; }
function scheduleUpdateChecks() {
  clearTimeout(updateTimer); clearInterval(updateInterval);
  if (config.autoCheckUpdates === false) return;
  const check = () => { void updater.check(); };
  updateTimer = setTimeout(check, 1500);
  updateInterval = setInterval(check, 6 * 60 * 60 * 1000);
  updateTimer.unref?.(); updateInterval.unref?.();
}
const tasks = new Map();
const glob = import('../shared/glob.mjs');
const logFont = import('../shared/log-font.mjs');
let batchSearch;
const extractedFiles = new Set();
const localRoots = new Set();
const core = import('./log-core.mjs');
const event = data => { if (win && !win.isDestroyed()) win.webContents.send('viewer-event', data); };
const callSftp = (method, ...args) => new Promise((resolve, reject) => {
  if (!sftp) return reject(new Error('请先连接 SSH'));
  sftp[method](...args, (error, result) => error ? reject(error) : resolve(result));
});
async function persist() {
  const temporary = `${configPath}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, configPath);
}
let saveQueue = Promise.resolve();
function save() { saveQueue = saveQueue.catch(() => {}).then(persist); return saveQueue; }
function taskWorker(kind, data, progress) {
  const worker = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: { kind, ...data } });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message.type === 'progress') progress?.(message.data);
      else if (message.type === 'result') { settled = true; resolve(message.result); }
      else { settled = true; reject(new Error(message.error)); }
    });
    worker.on('error', error => { settled = true; reject(error); });
    worker.on('exit', () => { if (!settled) reject(new Error('操作已取消')); });
  });
  return { worker, promise };
}
function stopFollow() { clearInterval(followTimer); followTimer = undefined; }
function closeDocument() {
  stopFollow();
  if (!document) return;
  const previous = document;
  previous.controller.abort();
  const stopping = [previous.indexWorker?.terminate(), previous.searchWorker?.terminate()];
  if (previous.remote || previous.gzip) {
    Promise.allSettled([previous.work, ...stopping]).then(async () => {
      await fsp.rm(previous.file, { force: true });
      await fsp.rm(path.join(cacheRoot, previous.id + '.gz'), { force: true });
    }).catch(() => {});
  }
  document = undefined;
}
let disconnectWork = Promise.resolve();
function disconnect({ releasePort = false } = {}) {
  sshTerminal.close();
  batchSearch?.controller.abort(); batchSearch?.worker?.terminate(); batchSearch = undefined;
  closeDocument();
  for (const task of tasks.values()) task.abort();
  const attempt = sshAttempt; sshAttempt = undefined;
  const previous = sshSession; const client = connection; sshSession = undefined; connection = undefined; sftp = undefined; connectionHost = undefined;
  const close = () => { attempt?.abort(); previous?.close(); if (!previous) client?.destroy(); };
  if (releasePort && previous) {
    const work = disconnectWork.then(() => previous.releaseJumpPort()).finally(close);
    disconnectWork = work.then(() => undefined, () => undefined);
    return work;
  }
  close();
  return disconnectWork;
}
async function namedJump(profile) {
  if (!profile.jumpName) return profile;
  const saved = config.jumpProfiles.find(item => item.name === profile.jumpName);
  if (!saved) { if (profile.jump?.enabled) throw new Error('已保存的跳板机不存在，请重新选择'); return profile; }
  const current = profile.jump;
  const sameEndpoint = current && current.host === saved.host && Number(current.port || 22) === saved.port && current.username === saved.username && current.auth === saved.auth;
  const enteredPassword = sameEndpoint && typeof current.password === 'string' && current.password.length ? current.password : undefined;
  return { ...profile, jump: { ...saved, enabled: Boolean(current?.enabled), password: enteredPassword ?? (saved.hasPassword ? await credentials.get(saved.credentialId) : ''), passphrase: current?.passphrase || '' } };
}
async function connect(profile) {
  await disconnect();
  profile = await namedJump(profile);
  const controller = new AbortController(); sshAttempt = controller;
  let own;
  try {
    own = await connectSession(profile, {
      signal: controller.signal,
      report: message => event({ type: 'connection-progress', message }),
      onError: error => { if (connection === own?.client) event({ type: 'connection-error', error }); },
      onClose: () => { if (own && connection === own.client) { disconnect(); event({ type: 'disconnected' }); } },
      verify: (identity, role, fingerprint, callback) => {
        const known = config.hosts[identity];
        if (known === fingerprint) { callback(!controller.signal.aborted); return; }
        const changed = Boolean(known);
        const display = hash => `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`;
        if (changed) event({ type: 'connection-progress', message: `${role}指纹冲突 · ${identity} · 等待确认清除旧指纹` });
        dialog.showMessageBox(win, { type: changed ? 'warning' : 'question', title: changed ? `${role}指纹冲突` : `首次连接：确认${role}指纹`, message: identity,
          detail: changed
            ? `已保存的旧指纹：\n${display(known)}\n\n服务器的新指纹：\n${display(fingerprint)}\n\n服务器重装或隧道目标切换可能导致指纹变化，也可能是连接到了其他服务器。请核对新指纹；确认后自动清除该连接的旧记录、保存新指纹并继续连接。`
            : `服务器指纹：\n${display(fingerprint)}\n\n请与服务器管理员提供的指纹核对。`,
          buttons: ['取消', changed ? '清除旧指纹并连接' : '信任并连接'], defaultId: 0, cancelId: 0,
        }).then(async result => {
          if (result.response !== 1 || controller.signal.aborted) return callback(false);
          config.hosts[identity] = fingerprint;
          try {
            await save();
            if (changed && !controller.signal.aborted) event({ type: 'connection-progress', message: `${role}旧指纹已清除 · 正在连接 ${identity}` });
            callback(!controller.signal.aborted);
          } catch {
            if (config.hosts[identity] === fingerprint) {
              if (known) config.hosts[identity] = known; else delete config.hosts[identity];
            }
            callback(false);
          }
        }).catch(() => callback(false));
      },
    });
    if (controller.signal.aborted) throw new Error('连接已取消');
    sshSession = own; connection = own.client; sftp = own.sftp;
    connectionName = `${profile.username}@${own.identity}`;
    connectionHost = profile.host;
    connectionOrigin = { ...sourceIdentity(profile), host: archiveOwner(profile), owner: connectionName };
    const home = await callSftp('realpath', '.');
    if (controller.signal.aborted) throw new Error('连接已取消');
    return { name: connectionName, home };
  } catch (error) { own?.close(); if (sshAttempt === controller) disconnect(); throw error; }
}

function summary(doc) {
  const copy = (config.localCopies || []).find(item => item.paths?.includes(doc.name));
  const archive = (config.localExtractions || []).find(item => item.paths?.includes(doc.name))?.source;
  const origin = doc.remote ? connectionOrigin?.label : copy?.origin || copy?.owner;
  return { id: doc.id, name: doc.name, origin, archive, remote: Boolean(doc.remote), compressed: doc.gzip, size: doc.size, ready: Boolean(doc.index), lines: doc.index?.lines || 0, bookmarkKey: doc.bookmarkKey, bookmarks: config.bookmarks[doc.bookmarkKey] || [] };
}
async function prefixHash(doc) {
  if (!doc.prefixLength) return '';
  const input = doc.remote ? remoteSource(sftp, doc.remote, 0, doc.prefixLength, doc.controller.signal)
    : fs.createReadStream(doc.file, { start: 0, end: doc.prefixLength - 1 });
  const hash = crypto.createHash('sha256');
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}
async function indexDocument(doc) {
  const job = taskWorker('index', { file: doc.file }, progress => event({ type: 'index-progress', id: doc.id, ...progress }));
  doc.indexWorker = job.worker;
  const index = await job.promise;
  if (document !== doc) return;
  doc.index = index; doc.size = index.size;
  event({ type: 'ready', ...summary(doc) });
}
async function copyStream(stream, destination, size, signal, onProgress, maxBytes = Infinity) {
  let bytes = 0, last = 0;
  await pipeline(stream, new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new Error('解压内容超过 1GB 限制'));
    if (Date.now() - last > 150) { onProgress({ bytes, size }); last = Date.now(); }
    callback(null, chunk);
  }}), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  onProgress({ bytes, size }); return bytes;
}
async function openFile(remotePath, localPath) {
  closeDocument();
  const remote = Boolean(remotePath);
  const source = remotePath || localPath;
  const attrs = remote ? await callSftp('stat', source) : await fsp.stat(source);
    if (!attrs.isFile()) throw new Error('请选择普通文件');
  const gzip = /\.gz$/i.test(source) && !/\.tar\.gz$/i.test(source);
  if (/\.(zip|tgz|tar|tar\.gz)$/i.test(source)) throw new Error('请使用“解压”按钮处理归档，然后打开其中的日志');
  const doc = {
    id: crypto.randomUUID(), name: source, remote: remotePath, gzip,
    size: attrs.size, mtime: remote ? attrs.mtime : attrs.mtimeMs,
    controller: new AbortController(), sourceSize: attrs.size,
    prefixLength: Math.min(attrs.size, 256), inode: remote ? undefined : attrs.ino,
    bookmarkKey: `${remote ? connectionName : 'local'}:${source}:${attrs.size}:${remote ? attrs.mtime : attrs.mtimeMs}`,
  };
  doc.file = remote || gzip ? path.join(cacheRoot, doc.id + '.log') : localPath;
  document = doc;
  if (!gzip) doc.prefix = await prefixHash(doc);
  let preview = [];
  if (!gzip && attrs.size) {
    const start = Math.max(0, attrs.size - 256 * 1024);
    const input = remote ? remoteSource(sftp, source, start, attrs.size, doc.controller.signal) : fs.createReadStream(source, { start, end: attrs.size - 1 });
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    let buffer = Buffer.concat(chunks);
    if (start) { const newline = buffer.indexOf(10); buffer = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1); }
    preview = buffer.toString('utf8').split('\n');
    if (preview.at(-1) === '') preview.pop();
    preview = preview.slice(-2000).map(text => text.replace(/\r$/, ''));
  }
  setImmediate(() => { doc.work = (async () => {
    try {
      if (doc.controller.signal.aborted) return;
      if (remote || gzip) {
        const rawFile = gzip ? path.join(cacheRoot, doc.id + '.gz') : doc.file;
        const input = remote ? remoteSource(sftp, source, 0, attrs.size, doc.controller.signal) : fs.createReadStream(source);
        await copyStream(input, rawFile, attrs.size, doc.controller.signal, data => event({ type: 'cache-progress', id: doc.id, ...data }));
        if (gzip) {
          const unpack = fs.createReadStream(rawFile);
          await pipeline(unpack, zlib.createGunzip(), new Transform({ transform(chunk, encoding, callback) {
            this.total = (this.total || 0) + chunk.length;
            callback(this.total > 1024 ** 3 ? new Error('解压内容超过 1GB 限制') : null, chunk);
          }}), fs.createWriteStream(doc.file, { flags: 'wx', mode: 0o600 }), { signal: doc.controller.signal });
          await fsp.rm(rawFile, { force: true });
        }
        if (remote) {
          const now = await callSftp('stat', source);
          if (now.size < attrs.size || (now.size === attrs.size && now.mtime !== attrs.mtime))
            throw new Error('缓存过程中远程文件被修改，请重新打开');
        }
      }
      await indexDocument(doc);
    } catch (error) { if (document === doc) event({ type: 'document-error', id: doc.id, error: error.message }); }
  })(); });
  return { ...summary(doc), preview };
}

function registerLocalExtraction(source, paths) {
  config.localExtractions = [...(config.localExtractions || []).filter(item => !item.paths.some(file => paths.includes(file))), { source, paths }].slice(-1000);
}
async function rememberLocal(remote, paths, owner = connectionName) {
  for (const file of paths) extractedFiles.add(file);
  if (remote) {
    config.localCopies ||= [];
    const origin = connectionOrigin?.owner === owner ? connectionOrigin.label : owner;
    config.localCopies = [...config.localCopies.filter(item => !(item.owner === owner && item.remote === remote)), { owner, origin, remote, paths }];
  }
  config.lastLocalPaths = paths; await save();
  event({ type: 'local-files-changed' });
}
async function localCopyPaths(matches) {
  const paths = [];
  for (const item of config.localCopies || []) {
    if (item.owner !== connectionName || !matches(path.posix.normalize(item.remote))) continue;
    for (const file of item.paths || []) {
      try { if ((await fsp.stat(file)).isFile()) paths.push(file); } catch {}
    }
  }
  return [...new Set(paths)];
}
async function authorizedLocalPath(file) {
  const resolved = await fsp.realpath(file);
  const root = [...localRoots].find(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  });
  if (!root) throw new Error('请先通过“打开本地文件/文件夹”选择该目录');
  return { resolved, root };
}
async function listLocalDirectory(directory) {
  const { resolved, root } = await authorizedLocalPath(directory);
  const items = await fsp.readdir(resolved, { withFileTypes: true });
  const entries = [];
  for (const item of items) {
    if (!item.isFile() && !item.isDirectory()) continue;
    try {
      const file = path.join(resolved, item.name), attrs = await fsp.stat(file);
      if (item.isFile()) extractedFiles.add(file);
      entries.push({ name: item.name, directory: item.isDirectory(), size: attrs.size, mtime: attrs.mtimeMs / 1000 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: resolved, root, entries };
}
function compressRemote(client, file, destination, signal) {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('操作已取消'));
    client.exec('umask 077; set -C; gzip -c < ' + quote(file) + ' > ' + quote(destination), (error, channel) => {
      if (error) return reject(error);
      let stderr = '';
      const abort = () => { channel.signal('TERM'); channel.close(); };
      signal.addEventListener('abort', abort, { once: true });
      channel.on('data', () => {});
      channel.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
      channel.on('error', reject);
      channel.on('close', code => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('操作已取消'));
        else if (code !== 0) reject(new Error('远程压缩失败：' + stderr));
        else resolve();
      });
      if (signal.aborted) abort();
    });
  });
}

async function downloadInto(file, folder, signal, report) {
  const downloadedAt = new Date();
  const owner = connectionName;
  const origin = connectionOrigin;
  const downloadRoot = folder;
  const attrs = await callSftp('stat', file);
  const compressedSource = /\.(?:gz|zip|tgz|tar|tar\.gz)$/i.test(file);
  const archiveSuffix = compressedSource ? '' : '.gz';
  let destination = downloadPath(downloadRoot, origin.host, file + archiveSuffix, downloadedAt);
  folder = path.dirname(destination);
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, '.part-' + crypto.randomUUID());
  const client = connection, transfer = sftp;
  const remoteArchive = compressedSource ? null : '/tmp/ssh-log-viewer-' + crypto.randomUUID() + '.gz';
  try {
    if (remoteArchive) {
      report({ phase: '远程压缩', bytes: 0 });
      await compressRemote(client, file, remoteArchive, signal);
    }
    const source = remoteArchive || file;
    const transferAttrs = await new Promise((resolve, reject) => transfer.stat(source, (error, attrs) => error ? reject(error) : resolve(attrs)));
    const bytes = await copyStream(remoteSource(transfer, source, 0, transferAttrs.size, signal), temporary, transferAttrs.size, signal, data => report({ ...data, phase: '下载' }));
    const after = await callSftp('stat', file);
    if (signal.aborted) throw new Error('操作已取消');
    if (bytes !== transferAttrs.size || after.size !== attrs.size || after.mtime !== attrs.mtime) throw new Error('远程文件在下载过程中改变，请重试');
    try { await fsp.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      destination = downloadPath(downloadRoot, origin.host, file + archiveSuffix, downloadedAt, crypto.randomUUID().slice(0, 8));
      await fsp.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
    }
    await rememberLocal(file, [destination], owner);
    return { destination, bytes: (await fsp.stat(destination)).size, origin: origin.label };
  } finally {
    await fsp.rm(temporary, { force: true });
    if (remoteArchive && !transfer.destroyed) transfer.unlink(remoteArchive, () => {});
  }
}

async function runTask(kind, work, origin) {
  if (tasks.size) throw new Error('已有下载或解压任务，请等待完成或取消');
  const id = crypto.randomUUID(), controller = new AbortController();
  tasks.set(id, controller);
  event({ type: 'task', id, kind, origin, state: 'running' });
  try {
    const result = await work(controller.signal, data => event({ type: 'task', id, kind, state: 'running', ...data }));
    event({ type: 'task', id, kind, state: controller.signal.aborted ? 'cancelled' : 'done', ...result }); return result;
  } catch (error) {
    event({ type: 'task', id, kind, state: controller.signal.aborted ? 'cancelled' : 'error', error: error.message }); throw error;
  } finally { tasks.delete(id); }
}
function prioritizeOpenFile(files, filePath, remote = false) {
  if (!document) return files;
  let current = document.name;
  if (remote && !document.remote) current = (config.localCopies || []).find(item => item.owner === connectionName && item.paths?.includes(current))?.remote;
  if (!current || (!remote && document.remote)) return files;
  const normalize = remote ? path.posix.normalize : path.resolve;
  const index = files.findIndex(file => normalize(filePath(file)) === normalize(current));
  if (index > 0) files.unshift(...files.splice(index, 1));
  return files;
}
function searchReporter(result, requestId, metadata, file) {
  return progress => {
    const { matches = [], ...stats } = progress;
    const delta = matches.slice(0, Math.max(0, 10000 - result.matches.length)).map(match => ({ ...match, file, ...(metadata.source ? { source: metadata.source } : {}) }));
    result.matches.push(...delta);
    event({ type: 'batch-search-progress', requestId, ...metadata, ...stats, result: {
      matches: delta, count: result.count + (stats.count || 0), capped: result.count + (stats.count || 0) > result.matches.length,
      truncatedLines: result.truncatedLines + (stats.truncatedLines || 0), files: result.files,
      searchedFiles: result.searchedFiles, ...(metadata.source ? { source: metadata.source } : {})
    } });
  };
}
function addExportPath(result, file) {
  if (!result?.matches?.length) return result;
  return { ...result, matches: result.matches.map(match => ({ ...match, exportPath: file })) };
}
async function createSearchExportReader(data) {
  const temporary = await fsp.mkdtemp(path.join(cacheRoot, 'search-export-'));
  const sources = new Map();
  async function materialize(match) {
    if (typeof match.exportPath === 'string' && match.exportPath) return match.exportPath;
    if (typeof match.file !== 'string' || !match.file) throw new Error(`无法定位第 ${match.line} 行的原始日志`);
    const source = match.file;
    const remote = match.source !== 'local' && data.source !== 'local';
    const compressed = /\.gz$/i.test(source);
    if (!remote && !compressed) return source;
    const destination = path.join(temporary, crypto.randomUUID() + '.log');
    if (remote) {
      if (!sftp) throw new Error('SSH 连接已断开，无法导出完整原始日志');
      const attrs = await callSftp('stat', source);
      if (compressed) {
        await pipeline(remoteSource(sftp, source, 0, attrs.size), zlib.createGunzip(), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      } else {
        await copyStream(remoteSource(sftp, source, 0, attrs.size), destination, attrs.size, undefined, () => {});
      }
      const after = await callSftp('stat', source);
      if (after.size !== attrs.size || after.mtime !== attrs.mtime) throw new Error('原始日志在导出过程中发生变化，请重新搜索后再导出');
    } else {
      await pipeline(fs.createReadStream(source), zlib.createGunzip(), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    }
    return destination;
  }
  async function sourceFor(match) {
    const key = match.exportPath ? `cache:${match.exportPath}` : `${match.source === 'local' || data.source === 'local' ? 'local' : 'remote'}:${match.file}`;
    if (!sources.has(key)) sources.set(key, materialize(match));
    return sources.get(key);
  }
  const logCore = await core;
  return {
    async *read(match) {
      if (!Number.isSafeInteger(match.offset) || match.offset < 0) throw new Error(`无法定位第 ${match.line} 行的原始日志`);
      yield* logCore.readFullLine(await sourceFor(match), match.offset);
    },
    cleanup: () => fsp.rm(temporary, { recursive: true, force: true }),
  };
}
async function follow() {
  const doc = document;
  if (!doc?.index || doc.gzip) throw new Error('请等待缓存完成；压缩日志不支持实时跟随');
  if (followBusy) return;
  followBusy = true;
  try {
    const attrs = doc.remote ? await callSftp('stat', doc.remote) : await fsp.stat(doc.file);
    const mtime = doc.remote ? attrs.mtime : attrs.mtimeMs;
    if (attrs.size < doc.sourceSize || (!doc.remote && attrs.ino !== doc.inode) || (attrs.size === doc.sourceSize && mtime !== doc.mtime) || await prefixHash(doc) !== doc.prefix) {
      stopFollow(); event({ type: 'rotated', id: doc.id }); return;
    }
    if (attrs.size === doc.sourceSize) return;
    if (doc.remote) {
      await pipeline(remoteSource(sftp, doc.remote, doc.sourceSize, attrs.size, doc.controller.signal), fs.createWriteStream(doc.file, { flags: 'a' }), { signal: doc.controller.signal });
    }
    doc.sourceSize = attrs.size; doc.mtime = mtime;
    await indexDocument(doc);
  } catch (error) { if (document === doc) { stopFollow(); event({ type: 'document-error', id: doc.id, error: error.message }); } }
  finally { followBusy = false; }
}

let telnetOutputFile, telnetOutputHost = '', telnetOutputQueue = Promise.resolve();
let telnetConnectionLogQueue = Promise.resolve();
let telnetConnectionContext = '';
const telnetSetups = new Set();
async function startTelnetOutput(target, token) {
  await telnetOutputQueue;
  terminalModes.check(token);
  telnetOutputFile = undefined;
  const setup = require('./telnet-log.cjs').createTelnetLog(config.directories.download, target);
  telnetSetups.add(setup);
  let file;
  try { file = await setup; } finally { telnetSetups.delete(setup); }
  extractedFiles.add(file);
  event({ type: 'local-files-changed' });
  terminalModes.check(token);
  telnetOutputHost = terminalLogTarget(target);
  telnetOutputFile = file;
}
function logTelnetConnection(message) {
  const line = `${new Date().toISOString()} ${telnetConnectionContext ? `[${telnetConnectionContext}] ` : ''}${message}\n`;
  try {
    const directory = app.getPath('logs');
    telnetConnectionLogQueue = telnetConnectionLogQueue
      .then(() => fsp.mkdir(directory, { recursive: true, mode: 0o700 }))
      .then(() => fsp.appendFile(path.join(directory, 'telnet-connection.log'), line, { mode: 0o600 }))
      .catch(() => {});
  } catch {}
}
const telnetEmit = data => {
  if (data.type === 'telnet-status') logTelnetConnection(data.message || '状态未知');
  if (data.type === 'telnet-connection-log') logTelnetConnection(data.message || '连接诊断信息未知');
  if (data.type === 'telnet-data' && telnetOutputFile && config.telnetLogMode !== 'none') {
    const file = telnetOutputFile;
    let text = data.message;
    if ((config.telnetLogMode || 'printable') === 'printable') text = require('node:util').stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    telnetOutputQueue = telnetOutputQueue.then(() => fsp.appendFile(file, text, { mode: 0o600 })).catch(error => event({ type: 'telnet-status', message: '日志写入失败：' + error.message }));
  }
  event(data);
};
const telnet = require('./telnet.cjs').createTelnet(telnetEmit);
const webTelnet = require('./web-telnet.cjs').createWebTelnet(telnetEmit);
let webTelnetActive = false, webLoginSession;
const sshTerminal = require('./ssh-terminal.cjs').createSshTerminal({
  getClient: () => connection,
  getTarget: () => connectionOrigin?.tag || connectionHost || connectionName,
  getRoot: () => config.directories.download,
  getLogMode: () => config.sshLogMode || 'printable',
  emit: event,
  onLogFile: file => { extractedFiles.add(file); event({ type: 'local-files-changed' }); },
});
const terminalModes = require('./terminal-mode.cjs').createTerminalMode({
  closeSsh: () => sshTerminal.close(),
});
const webPasswordId = (address, username) => 'web-telnet-' + crypto.createHash('sha256').update(JSON.stringify([require('./web-telnet.cjs').normalizeWebAddress(address), username.trim()])).digest('hex');
const handlers = {
  updateState: () => updateSnapshot(),
  checkForUpdates: async () => { await updater.check(); return updateSnapshot(); },
  downloadUpdate: async () => { await updater.download(); return updateSnapshot(); },
  cancelUpdate: async () => { await updater.cancel(); return updateSnapshot(); },
  installUpdate: async () => { await updater.install(); return updateSnapshot(); },
  openUpdateRelease: async () => { await updater.openRelease(); return updateSnapshot(); },
  revealUpdateInstaller: async () => { await updater.reveal(); return updateSnapshot(); },
  saveUpdatePreferences: async enabled => {
    if (typeof enabled !== 'boolean') throw new Error('自动更新检查选项无效');
    config.autoCheckUpdates = enabled;
    await save(); scheduleUpdateChecks();
    const update = updateSnapshot(); event({ type: 'update-state', update });
    return update;
  },
  terminalMode: mode => terminalModes.select(mode),
  sshTerminalOpen: (cols, rows) => { terminalModes.select('ssh'); return sshTerminal.open(cols, rows); },
  sshTerminalWrite: text => sshTerminal.write(text),
  sshTerminalResize: (cols, rows) => sshTerminal.resize(cols, rows),
  sshTerminalClose: () => sshTerminal.close(),
  sshTerminalRecording: async (mode, append) => {
    if (!['none', 'printable', 'all'].includes(mode)) throw new Error('日志类型无效');
    config.sshLogMode = mode;
    const overwrite = mode !== 'none' && !append ? sshTerminal.overwrite() : Promise.resolve();
    await Promise.all([save(), overwrite]);
    event({ type: 'local-files-changed' });
    return mode === 'none' ? null : sshTerminal.outputFile || null;
  },
  sshTerminalSaveOutput: async () => {
    const file = sshTerminal.outputFile;
    if (!file) throw new Error('尚无 SSH 命令终端会话输出');
    const host = terminalLogTarget(sshTerminal.outputTarget);
    const chosen = await dialog.showSaveDialog(win, { title: '保存 SSH 终端输出', defaultPath: path.join(app.getPath('downloads'), 'ssh-' + host + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt'), filters: [{ name: '文本日志', extensions: ['txt', 'log'] }] });
    if (chosen.canceled || !chosen.filePath) return null;
    await sshTerminal.copyOutput(chosen.filePath, file);
    return chosen.filePath;
  },
  webTelnetSearchDevices: async (address, keyword) => {
    address = require('./web-telnet.cjs').normalizeWebAddress(address);
    if (!webLoginSession || webLoginSession.address !== address) throw new Error('请先登录当前 Web 服务');
    return require('./web-telnet.cjs').searchDevices(address, webLoginSession, keyword);
  },
  webTelnetPassword: async (address, username, password, remember) => {
    const id = webPasswordId(address, username);
    if (!remember) await credentials.set(id, null);
    else if (password) await credentials.set(id, password);
    return Boolean(await credentials.get(id));
  },
  webTelnetLogin: async (address, username, password) => {
    address = require('./web-telnet.cjs').normalizeWebAddress(address);
    if (!password && webLoginSession?.address === address && webLoginSession.username === username.trim()) return { tenantId: webLoginSession.tenantId };
    if (!password) password = await credentials.get(webPasswordId(address, username));
    webLoginSession = undefined;
    const login = await require('./web-telnet.cjs').webLogin(address, username, password);
    webLoginSession = { address: address.replace(/\/$/, ''), username: username.trim(), ...login };
    return { tenantId: login.tenantId };
  },
  webTelnetConnect: async (address, device, token, identity = {}) => {
    terminalModes.cancel();
    const attempt = terminalModes.token();
    address = require('./web-telnet.cjs').normalizeWebAddress(address);
    telnetConnectionContext = `web ${address} device=${String(device).replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    logTelnetConnection('开始连接');
    telnet.close(); webTelnet.close(); webTelnetActive = true;
    await startTelnetOutput(telnetLogTarget({ device, address, name: identity.name, deviceName: identity.deviceName }), attempt);
    if (!token) {
      if (!webLoginSession || webLoginSession.address !== address.replace(/\/$/, '')) throw new Error('请先登录当前 Web 服务');
      token = await require('./web-telnet.cjs').getTelnetToken(address, webLoginSession);
    }
    terminalModes.check(attempt);
    try { return await webTelnet.connect(address, device, token); }
    catch (error) { logTelnetConnection('连接失败：' + error.message); throw error; }
  },
  telnetConnect: async (host, port, name = '') => {
    terminalModes.cancel();
    const attempt = terminalModes.token();
    telnetConnectionContext = `direct ${String(host).replace(/[^a-zA-Z0-9.-]/g, '_')}:${port}`;
    logTelnetConnection('开始连接');
    webTelnet.close(); webTelnetActive = false;
    telnet.close();
    await startTelnetOutput(telnetLogTarget({ host, port, name }), attempt);
    try {
      terminalModes.check(attempt);
      await telnet.connect(host, port);
      terminalModes.check(attempt);
      return true;
    } catch (error) {
      logTelnetConnection('连接失败：' + error.message);
      throw error;
    }
  },
  telnetSaveOutput: async () => {
    if (!telnetOutputFile) throw new Error('尚无 Telnet 会话输出');
    const file = telnetOutputFile;
    const chosen = await dialog.showSaveDialog(win, { title: '保存 Telnet 输出', defaultPath: path.join(app.getPath('downloads'), 'telnet-' + telnetOutputHost + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt'), filters: [{ name: '文本日志', extensions: ['txt', 'log'] }] });
    if (chosen.canceled || !chosen.filePath) return null;
    await telnetOutputQueue;
    await fsp.copyFile(file, chosen.filePath);
    return chosen.filePath;
  },
  telnetRecording: async (mode, append) => {
    if (!['none', 'printable', 'all'].includes(mode)) throw new Error('日志类型无效');
    await telnetOutputQueue;
    config.telnetLogMode = mode;
    await save();
    if (mode === 'none') return null;
    // Applying overwrite only clears the current session, never older sessions.
    if (telnetOutputFile && !append) await fsp.writeFile(telnetOutputFile, '', { mode: 0o600 });
    event({ type: 'local-files-changed' });
    return telnetOutputFile || null;
  },
  telnetWrite: text => webTelnetActive ? webTelnet.write(text) : telnet.write(text),
  telnetClose: () => { terminalModes.cancel(); telnet.close(); webTelnet.close(); event({ type: 'telnet-status', message: '已断开' }); },
  downloadedFiles: async () => {
    const recorded = new Set([...(config.localCopies || []).flatMap(item => item.paths || []), ...(config.lastLocalPaths || []), ...(config.localExtractions || []).flatMap(item => item.paths || [])]);
    const folders = [config.directories.download, config.directories.extract];
    const visited = new Set();
    while (folders.length) {
      const folder = folders.pop();
      if (visited.has(folder)) continue;
      visited.add(folder);
      let entries;
      try { entries = await fsp.readdir(folder, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.part-') || entry.name.includes('.part-')) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) folders.push(file);
        else if (entry.isFile()) recorded.add(file);
      }
    }
    const paths = [...recorded];
    const existing = [];
    for (const file of paths) {
      try { if ((await fsp.stat(file)).isFile()) { existing.push(file); extractedFiles.add(file); } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return existing.sort((a, b) => a.localeCompare(b));
  },
  settings: () => ({ sshLogMode: config.sshLogMode || 'printable', telnetLogMode: config.telnetLogMode || 'printable', sshEnabled: config.sshEnabled !== false, telnetEnabled: config.telnetEnabled !== false, searchHistory: config.searchHistory, profiles: config.profiles, bookmarks: config.bookmarks, theme: config.theme, logFont: config.logFont, version: app.getVersion(), selectedProfile: config.lastProfileName, directories: config.directories, jumpProfiles: config.jumpProfiles, selectedJump: config.lastJumpName, localPaths: config.lastLocalPaths || [] }),
  saveFeatureEnabled: async (feature, enabled) => {
    if (feature !== 'ssh' && feature !== 'telnet') throw new Error('未知功能');
    config[feature + 'Enabled'] = Boolean(enabled);
    await save();
    return config[feature + 'Enabled'];
  },
  loadProfile: async name => {
    const profile = config.profiles.find(p => p.name === name);
    if (!profile) throw new Error('连接配置不存在');
    config.lastProfileName = name; await save();
    return { ...await namedJump(profile), password: profile.hasPassword ? await credentials.get(profile.credentialId || credentialId(profile)) : '', ...(!profile.jumpName && profile.jump ? { jump: { ...profile.jump, password: profile.jump.hasPassword ? await credentials.get(profile.jump.credentialId) : '' } } : {}) };
  },
  importServerAsJump: async name => {
    const saved = config.profiles.find(item => item.name === name);
    if (!saved) throw new Error('服务器配置不存在');
    return { name: saved.name, host: saved.host, port: saved.port, username: saved.username,
      auth: saved.auth, keyPath: saved.keyPath || '', enabled: true,
      rememberPassword: Boolean(saved.rememberPassword), hasPassword: Boolean(saved.hasPassword),
      password: saved.hasPassword ? await credentials.get(saved.credentialId || credentialId(saved)) : '' };
  },
  loadJumpProfile: async name => {
    const saved = config.jumpProfiles.find(item => item.name === name);
    if (!saved) throw new Error('跳板机配置不存在');
    config.lastJumpName = name; await save();
    return { ...saved, password: saved.hasPassword ? await credentials.get(saved.credentialId) : '' };
  },
  saveJumpProfile: async value => {
    const name = String(value.name || '').trim();
    if (!name || !value.host || !value.username) throw new Error('跳板机名称、主机和用户名不能为空');
    const port = Number(value.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('跳板机端口无效');
    const saved = { name, host: String(value.host), port, username: String(value.username), auth: value.auth || 'password', keyPath: String(value.keyPath || ''), enabled: true, rememberPassword: Boolean(value.rememberPassword), hasPassword: false };
    const previous = config.jumpProfiles.find(item => item.name === name);
    const id = credentialId({ ...saved, name: `saved-jump:${name}` });
    if (previous?.credentialId && previous.credentialId !== id) await credentials.set(previous.credentialId, null);
    if (saved.auth === 'password' && saved.rememberPassword) {
      if (value.password) await credentials.set(id, String(value.password));
      saved.hasPassword = Boolean(value.password) || Boolean(previous?.hasPassword && previous.credentialId === id);
    } else await credentials.set(id, null);
    config.jumpProfiles = [...config.jumpProfiles.filter(item => item.name !== name), { ...saved, credentialId: id }];
    config.lastJumpName = name; await save(); return config.jumpProfiles;
  },
  deleteProfile: async name => {
    const saved = config.profiles.find(item => item.name === name);
    if (!saved) throw new Error('连接配置不存在');
    const { response } = await dialog.showMessageBox(win, { type: 'question', title: '删除连接配置', message: `删除连接“${name}”？`, detail: '同时删除该连接保存的密码，当前已建立的连接不受影响。', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return null;
    await credentials.set(saved.credentialId || credentialId(saved), null);
    if (!saved.jumpName && saved.jump?.credentialId) await credentials.set(saved.jump.credentialId, null);
    config.profiles = config.profiles.filter(item => item.name !== name);
    if (config.lastProfileName === name) config.lastProfileName = '';
    await save(); return config.profiles;
  },
  deleteJumpProfile: async name => {
    const saved = config.jumpProfiles.find(item => item.name === name);
    if (!saved) throw new Error('跳板机配置不存在');
    const affected = config.profiles.filter(item => item.jumpName === name);
    const { response } = await dialog.showMessageBox(win, { type: 'question', title: '删除跳板机配置', message: `删除跳板机“${name}”？`, detail: `同时删除该跳板机保存的密码。${affected.length ? `关联的 ${affected.length} 个连接需重新配置跳板机后才能通过跳板机连接。` : ''}当前已建立的连接不受影响。`, buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return null;
    if (saved.credentialId) await credentials.set(saved.credentialId, null);
    config.jumpProfiles = config.jumpProfiles.filter(item => item.name !== name);
    config.profiles = config.profiles.map(item => {
      if (item.jumpName !== name) return item;
      const { jumpName, ...remaining } = item;
      return { ...remaining, jump: { enabled: Boolean(item.jump?.enabled), host: '', port: 22, username: '', auth: 'password', keyPath: '', rememberPassword: true, hasPassword: false } };
    });
    if (config.lastJumpName === name) config.lastJumpName = '';
    await save(); return { profiles: config.profiles, jumpProfiles: config.jumpProfiles };
  },
  openFolder: async folder => {
    const resolved = await fsp.realpath(String(folder));
    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
  },
  exportSearchResults: async data => {
    const chosen = await dialog.showSaveDialog(win, {
      title: '导出搜索结果', defaultPath: path.join(app.getPath('downloads'), '搜索结果.txt'),
      filters: [{ name: '文本日志', extensions: ['txt'] }, { name: 'CSV 表格', extensions: ['csv'] }, { name: 'JSON 数据', extensions: ['json'] }],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    const reader = await createSearchExportReader(data);
    try {
      await writeSearchExport(data, chosen.filePath, reader.read);
      return { path: chosen.filePath, count: data.matches.length };
    } finally { await reader.cleanup(); }
  },
  copyText: text => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('复制内容无效或过长');
    clipboard.writeText(text);
  },
  saveSearchHistory: async history => {
    if (!Array.isArray(history)) throw new Error('搜索历史格式无效');
    config.searchHistory = [...new Set(history.filter(item => typeof item === 'string' && item.trim() && item.length <= 2048))].slice(0, 30);
    await save();
    return config.searchHistory;
  },
  saveTheme: async theme => {
    if (!['midnight', 'light', 'forest', 'violet', 'graphite', 'amber'].includes(theme)) throw new Error('未知颜色主题');
    config.theme = theme;
    await save();
    return theme;
  },
  saveLogFont: async value => {
    config.logFont = (await logFont).validateLogFont(value);
    await save();
    return config.logFont;
  },
  saveProfile: async profile => {
    profile = await namedJump(profile);
    const saved = { name: String(profile.name || profile.host), host: String(profile.host), port: Number(profile.port || 22), username: String(profile.username), auth: profile.auth, keyPath: String(profile.keyPath || ''), rememberPassword: Boolean(profile.rememberPassword), hasPassword: false };
    if (profile.jump) saved.jump = { name: String(profile.jump.name || ''), enabled: Boolean(profile.jump.enabled), host: String(profile.jump.host || ''), port: Number(profile.jump.port || 22), username: String(profile.jump.username || ''), auth: profile.jump.auth || 'password', keyPath: String(profile.jump.keyPath || ''), rememberPassword: Boolean(profile.jump.rememberPassword), hasPassword: false };
    if (profile.jumpName) saved.jumpName = String(profile.jumpName);
    const id = credentialId(saved), previous = config.profiles.find(p => p.name === saved.name);
    if (previous?.credentialId && previous.credentialId !== id) await credentials.set(previous.credentialId, null);
    if (saved.auth === 'password' && saved.rememberPassword) {
      if (profile.password) await credentials.set(id, String(profile.password));
      saved.hasPassword = Boolean(profile.password) || Boolean(previous?.hasPassword && previous.credentialId === id);
    } else await credentials.set(id, null);
    const jumpId = saved.jump ? credentialId({ ...saved.jump, name: `${saved.name}::jump` }) : null;
    if (!previous?.jumpName && previous?.jump?.credentialId && previous.jump.credentialId !== jumpId) await credentials.set(previous.jump.credentialId, null);
    if (saved.jump && !saved.jumpName) {
      saved.jump.credentialId = jumpId;
      if (saved.jump.enabled && saved.jump.auth === 'password' && saved.jump.rememberPassword) {
        if (profile.jump.password) await credentials.set(jumpId, String(profile.jump.password));
        saved.jump.hasPassword = Boolean(profile.jump.password) || Boolean(previous?.jump?.hasPassword && previous.jump.credentialId === jumpId);
      } else await credentials.set(jumpId, null);
    }
    config.profiles = [...config.profiles.filter(p => p.name !== saved.name), { ...saved, credentialId: id }];
    config.lastProfileName = saved.name; await save(); return config.profiles;
  },
  chooseDirectory: async kind => {
    if (!['download', 'extract'].includes(kind)) throw new Error('未知目录类型');
    const chosen = await dialog.showOpenDialog(win, { title: kind === 'download' ? '选择默认下载目录' : '选择默认解压目录', defaultPath: config.directories[kind], properties: ['openDirectory', 'createDirectory'] });
    if (!chosen.canceled) { config.directories[kind] = chosen.filePaths[0]; await save(); }
    return config.directories;
  },
  openExtracted: file => { if (!extractedFiles.has(file)) throw new Error('请选择本次解压得到的文件'); return openFile(null, file); },
  chooseKey: async () => (await dialog.showOpenDialog(win, { title: '选择 SSH 私钥', properties: ['openFile'] })).filePaths[0],
  connect,
  disconnect: async () => {
    try {
      const result = await disconnect({ releasePort: true });
      event({ type: 'disconnected', message: result?.message || 'SSH 连接已断开' });
      return result || null;
    } catch (error) {
      event({ type: 'disconnected', message: 'SSH 连接已断开；远端清理失败：' + error.message });
      throw new Error('SSH 连接已断开；远端清理失败：' + error.message);
    }
  },
  list: async directory => {
    const resolved = await callSftp('realpath', directory || '.');
    const entries = await callSftp('readdir', resolved);
    return { path: resolved, entries: entries.filter(e => e.filename !== '.' && e.filename !== '..').map(e => ({ name: e.filename, directory: e.attrs.isDirectory(), size: e.attrs.size, mtime: e.attrs.mtime })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
  },
  browseLocalSelection: async directory => {
    const resolved = await fsp.realpath(directory || app.getPath('home'));
    const items = await fsp.readdir(resolved, { withFileTypes: true });
    const entries = [];
    for (const item of items) {
      if (!item.isFile() && !item.isDirectory()) continue;
      try {
        const attrs = await fsp.stat(path.join(resolved, item.name));
        entries.push({ name: item.name, directory: item.isDirectory(), size: attrs.size, mtime: attrs.mtimeMs / 1000 });
      } catch {}
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: resolved, root: path.parse(resolved).root, entries };
  },
  selectLocalPath: async file => {
    const resolved = await fsp.realpath(file);
    const attrs = await fsp.stat(resolved);
    if (attrs.isDirectory()) {
      localRoots.add(resolved);
      return { kind: 'folder', listing: await listLocalDirectory(resolved) };
    }
    if (!attrs.isFile()) throw new Error('请选择文件或文件夹');
    localRoots.add(path.dirname(resolved));
    return { kind: 'file', path: resolved, listing: await listLocalDirectory(path.dirname(resolved)) };
  },
  chooseLocalFolder: async () => {
    const chosen = await dialog.showOpenDialog(win, { title: '打开本地日志文件夹', properties: ['openDirectory'] });
    if (chosen.canceled) return null;
    const root = await fsp.realpath(chosen.filePaths[0]);
    localRoots.add(root);
    return listLocalDirectory(root);
  },
  listLocal: directory => listLocalDirectory(directory),
  openLocalFile: async file => openFile(null, (await authorizedLocalPath(file)).resolved),
  searchLocalFiles: async (directory, pattern, query, options, requestId) => {
    if (!query || query.length > 2048) throw new Error('搜索内容不能为空且不得超过 2048 字符');
    if (options.regex) new RegExp(query, options.caseSensitive ? '' : 'i');
    const matcher = (await glob).filenamePattern(pattern || '*');
    const listing = await listLocalDirectory(directory);
    const files = listing.entries.filter(entry => !entry.directory && matcher.test(entry.name)).map(entry => path.join(listing.path, entry.name));
    if (!files.length) return { matches: [], count: 0, capped: false, truncatedLines: 0, files: 0, searchedFiles: 0, errors: [], source: 'local', paths: [] };
    return handlers.searchExtracted(files, query, options, requestId);
  },
  openRemote: file => openFile(file),
  openLocal: async () => {
    const chosen = await dialog.showOpenDialog(win, { title: '打开本地日志', properties: ['openFile'] });
    return chosen.canceled ? null : openFile(null, chosen.filePaths[0]);
  },
  page: async (id, start, count, filterToken) => {
    if (document?.id !== id || !document.index) throw new Error('文件尚未就绪');
    const doc = document;
    if (filterToken) {
      if (doc.filter?.token !== filterToken) throw new Error('筛选已失效，请重新筛选');
      return (await core).readFilteredPage(doc.file, doc.filter.positions, Number(start) || 0, Number(count) || 300);
    }
    return (await core).readPage(doc.file, doc.index, Number(start) || 0, Number(count) || 300);
  },
  filter: async (id, query, caseSensitive, requestId) => {
    batchSearch?.controller.abort(); batchSearch?.worker?.terminate(); batchSearch = undefined;
    if (document?.id !== id || !document.index) throw new Error('请等待全文缓存完成');
    stopFollow();
    const doc = document;
    doc.searchWorker?.terminate();
    const job = taskWorker('search', { file: doc.file, query, options: { caseSensitive: Boolean(caseSensitive), collectPositions: true } }, data => event({ type: 'filter-progress', id, requestId, ...data }));
    doc.searchWorker = job.worker;
    try {
      const result = await job.promise;
      if (document !== doc || doc.searchWorker !== job.worker) throw new Error('筛选已取消');
      const token = crypto.randomUUID();
      doc.filter = { token, positions: result.positions };
      return { token, count: result.positions.length / 2, total: result.count, capped: result.count > result.positions.length / 2, query };
    } finally { if (doc.searchWorker === job.worker) doc.searchWorker = undefined; }
  },
  searchExtracted: async (paths, query, options, requestId) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 20000 || paths.some(file => !extractedFiles.has(file))) throw new Error('请选择本次已下载解压的文件');
    if (!query || query.length > 2048) throw new Error('搜索内容不能为空且不得超过 2048 字符');
    if (options.regex) new RegExp(query, options.caseSensitive ? '' : 'i');
    document?.searchWorker?.terminate(); batchSearch?.controller.abort(); batchSearch?.worker?.terminate();
    const context = { controller: new AbortController(), worker: undefined }; batchSearch = context;
    const files = prioritizeOpenFile([...new Set(paths)], file => file);
    const result = { matches: [], count: 0, capped: false, truncatedLines: 0, files: files.length, searchedFiles: 0, errors: [] };
    try {
      for (let index = 0; index < files.length; index++) {
        if (context.controller.signal.aborted) throw new Error('搜索已取消');
        const file = files[index];
        const temporary = path.join(cacheRoot, crypto.randomUUID() + '-local-search.log');
        const matchStart = result.matches.length;
        try {
          let searchable = file;
          if (/\.(zip|tar|tar\.gz|tgz)$/i.test(file)) throw new Error('请先解压本地归档再搜索');
          if (/\.gz$/i.test(file)) {
            let bytes = 0;
            await pipeline(fs.createReadStream(file), zlib.createGunzip(), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > 1024 ** 3 ? new Error('解压内容超过 1GB 限制') : null, chunk); } }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: context.controller.signal });
            searchable = temporary;
          }
          const report = searchReporter(result, requestId, { source: 'local', file: path.basename(file), fileIndex: index + 1, files: files.length }, file);
          const job = taskWorker('search', { file: searchable, query, options }, report);
          context.worker = job.worker;
          const timeout = setTimeout(() => job.worker.terminate(), 30000);
          let found; try { found = await job.promise; } finally { clearTimeout(timeout); context.worker = undefined; }
          if (context.controller.signal.aborted) throw new Error('搜索已取消');
          result.count += found.count; result.truncatedLines += found.truncatedLines; result.searchedFiles++;
          result.capped = result.count > result.matches.length;
          event({ type: 'batch-search-progress', requestId, source: 'local', file: path.basename(file), fileIndex: index + 1, files: files.length, result: { ...result, matches: [], source: 'local' } });
        } catch (error) { if (context.controller.signal.aborted) throw error; result.matches.length = matchStart; result.errors.push(`${path.basename(file)}: ${error.message}`); }
        finally { await fsp.rm(temporary, { force: true }); }
      }
      result.capped = result.count > result.matches.length; return { ...result, source: 'local', paths: files };
    } finally { if (batchSearch === context) batchSearch = undefined; }
  },
  searchFiles: async (directory, pattern, query, options, requestId) => {
    const matcher = (await glob).filenamePattern(pattern);
    if (!pattern || !query || query.length > 2048) throw new Error('请填写文件名模式和搜索内容（最多 2048 字符）');
    if (options.regex) new RegExp(query, options.caseSensitive ? '' : 'i');
    const folderPath = path.posix.normalize(directory).replace(/\/$/, '') || '/';
    const paths = await localCopyPaths(remote => path.posix.dirname(remote) === folderPath && matcher.test(path.posix.basename(remote)));
    if (paths.length) return handlers.searchExtracted(paths, query, options, requestId);

    document?.searchWorker?.terminate();
    batchSearch?.controller.abort(); batchSearch?.worker?.terminate();
    const context = { controller: new AbortController(), worker: undefined };
    batchSearch = context;
    const signal = context.controller.signal;
    let folder, files;
    const result = { matches: [], count: 0, capped: false, truncatedLines: 0, files: 0, searchedFiles: 0, errors: [] };
    try {
    folder = await callSftp('realpath', directory);
    files = (await callSftp('readdir', folder)).filter(entry => entry.attrs.isFile() && matcher.test(entry.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
    prioritizeOpenFile(files, entry => path.posix.join(folder, entry.filename), true);
    result.files = files.length;
      for (const entry of files) {
        if (signal.aborted) throw new Error('搜索已取消');
        const remote = path.posix.join(folder, entry.filename);
        const raw = path.join(cacheRoot, crypto.randomUUID() + '-batch');
        const unpacked = raw + '.log';
        const matchStart = result.matches.length;
        const report = searchReporter(result, requestId, { file: entry.filename, fileIndex: result.searchedFiles + result.errors.length + 1, files: files.length }, remote);
        try {
          if (/\.(zip|tar|tar\.gz|tgz)$/i.test(remote)) throw new Error('请先解压归档；批量搜索支持普通日志和 .gz');
          const attrs = await callSftp('stat', remote);
          await copyStream(remoteSource(sftp, remote, 0, attrs.size, signal), raw, attrs.size, signal, report);
          const after = await callSftp('stat', remote);
          if (after.size !== attrs.size || after.mtime !== attrs.mtime) throw new Error('下载时文件发生变化');
          let file = raw;
          if (/\.gz$/i.test(remote)) {
            let decompressed = 0;
            await pipeline(fs.createReadStream(raw), zlib.createGunzip(), new Transform({ transform(chunk, encoding, callback) { decompressed += chunk.length; callback(decompressed > 1024 ** 3 ? new Error('解压内容超过 1GB 限制') : null, chunk); } }), fs.createWriteStream(unpacked, { flags: 'wx', mode: 0o600 }), { signal });
            file = unpacked;
          }
          const job = taskWorker('search', { file, query, options }, report); context.worker = job.worker;
          const timeout = setTimeout(() => job.worker.terminate(), 30000);
          let found; try { found = await job.promise; } finally { clearTimeout(timeout); context.worker = undefined; }
          if (signal.aborted) throw new Error('搜索已取消');
          result.count += found.count; result.truncatedLines += found.truncatedLines; result.searchedFiles++;
          result.capped = result.count > result.matches.length;
          event({ type: 'batch-search-progress', requestId, file: entry.filename, files: files.length, result: { ...result, matches: [] } });
        } catch (error) { if (signal.aborted) throw error; result.matches.length = matchStart; result.errors.push(`${entry.filename}: ${error.message}`); }
        finally { await Promise.allSettled([fsp.rm(raw, { force: true }), fsp.rm(unpacked, { force: true })]); }
      }
      result.capped = result.count > result.matches.length;
      return result;
    } finally { if (batchSearch === context) batchSearch = undefined; }
  },
  clearFilter: id => { if (document?.id === id) document.filter = undefined; },
  search: async (id, query, options, requestId) => {
    batchSearch?.controller.abort(); batchSearch?.worker?.terminate(); batchSearch = undefined;
    if (document?.id !== id || !document.index) throw new Error('请等待全文缓存完成');
    const doc = document;
    doc.searchWorker?.terminate();
    const job = taskWorker('search', { file: doc.file, query, options }, data => event({ type: 'search-progress', id, requestId, ...data, result: { matches: (data.matches || []).map(match => ({ ...match, exportPath: doc.file })), count: data.count, capped: data.capped || false, truncatedLines: data.truncatedLines || 0 } }));
    doc.searchWorker = job.worker;
    const timeout = setTimeout(() => job.worker.terminate(), 30000);
    try { return addExportPath(await job.promise, doc.file); } finally { clearTimeout(timeout); if (doc.searchWorker === job.worker) doc.searchWorker = undefined; }
  },
  cancelSearch: () => { batchSearch?.controller.abort(); batchSearch?.worker?.terminate(); batchSearch = undefined; const worker = document?.searchWorker; if (document) document.searchWorker = undefined; worker?.terminate(); },
  follow: enabled => {
    stopFollow();
    if (enabled) {
      if (!document?.index || document.gzip) throw new Error('文件尚未就绪或是压缩文件');
      if (document.filter) throw new Error('请先取消筛选再开启实时跟随');
      followTimer = setInterval(() => void follow(), 1500);
    }
    return Boolean(enabled);
  },
  saveBookmarks: async (key, bookmarks) => {
    config.bookmarks[key] = bookmarks.slice(0, 1000).map(b => ({ line: Math.max(0, Math.floor(b.line)), note: String(b.note).slice(0, 500), color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#f59e0b' }));
    await save();
  },
  cancelTask: id => { tasks.get(id)?.abort(); },
  download: file => runTask('下载', (signal, report) => downloadInto(file, config.directories.download, signal, report), connectionOrigin?.label),
  batchTransfer: async (directory, pattern, unpack) => {
    const matcher = (await glob).filenamePattern(pattern);
    if (!pattern) throw new Error('请先填写文件名匹配模式');
    const folder = await callSftp('realpath', directory);
    const files = (await callSftp('readdir', folder)).filter(entry => entry.attrs.isFile() && matcher.test(entry.filename)).sort((a, b) => a.filename.localeCompare(b.filename));
    if (!files.length) throw new Error('当前目录没有匹配的文件');
    const downloadFolder = config.directories.download, extractFolder = config.directories.extract, owner = connectionName, origin = connectionOrigin;
    return runTask(unpack ? '批量下载解压' : '批量下载', async (signal, report) => {
      const result = { destination: downloadFolder, origin: origin.label, bytes: 0, files: files.length, completedFiles: 0, downloadedFiles: 0, failedFiles: 0, errors: [], paths: [] };
      const totalSize = files.reduce((sum, entry) => sum + entry.attrs.size, 0);
      for (let index = 0; index < files.length; index++) {
        if (signal.aborted) break;
        const entry = files[index];
        const update = (phase, data = {}) => report({ ...data, bytes: result.bytes, size: totalSize, file: entry.filename, fileIndex: index + 1, files: files.length, completedFiles: result.completedFiles, failedFiles: result.failedFiles, phase });
        let downloaded;
        try {
          downloaded = await downloadInto(path.posix.join(folder, entry.filename), downloadFolder, signal, progress => update('下载', { currentBytes: progress.bytes, currentSize: progress.size }));
          result.bytes += downloaded.bytes; result.downloadedFiles++;
          if (unpack && /\.(gz|zip|tgz|tar)$/i.test(entry.filename)) {
            const destination = extractionPath(extractFolder, origin.host, path.posix.join(folder, entry.filename));
            await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            const extracted = await extractArchive(downloaded.destination, destination, signal, progress => update('解压', { currentBytes: progress.bytes }), entry.filename, true);
            await rememberLocal(path.posix.join(folder, entry.filename), extracted.paths, owner);
            result.paths.push(...extracted.paths);
            for (const file of extracted.paths) extractedFiles.add(file);
          } else {
            result.paths.push(downloaded.destination); extractedFiles.add(downloaded.destination);
          }
          result.completedFiles++;
        } catch (error) {
          if (signal.aborted) {
            if (downloaded && !result.paths.includes(downloaded.destination)) {
              result.paths.push(downloaded.destination); extractedFiles.add(downloaded.destination);
            }
            break;
          }
          result.failedFiles++; result.errors.push(`${entry.filename}: ${error.message}`);
        }
        update('已处理');
      }
      result.paths.sort((a, b) => Number(/\.(log|txt)$/i.test(b)) - Number(/\.(log|txt)$/i.test(a)) || a.localeCompare(b));
      config.lastLocalPaths = result.paths; await save();
      return { ...result, cancelled: signal.aborted, error: result.errors.join('；'), openPath: result.paths[0] };
    }, origin.label);
  },
  extractLocalMatches: async (directory, pattern) => {
    const matcher = (await glob).filenamePattern(pattern || '*');
    const listing = await listLocalDirectory(directory);
    const files = listing.entries.filter(entry => !entry.directory && /\.(gz|zip|tgz|tar)$/i.test(entry.name) && matcher.test(entry.name));
    if (!files.length) throw new Error('当前匹配结果中没有可解压的文件（支持 .gz、.zip、.tar、.tar.gz、.tgz）');
    const extractFolder = config.directories.extract;
    await fsp.mkdir(extractFolder, { recursive: true, mode: 0o700 });
    return runTask('本地批量解压', async (signal, report) => {
      const result = { destination: extractFolder, files: files.length, completedFiles: 0, failedFiles: 0, errors: [], paths: [], bytes: 0 };
      for (let index = 0; index < files.length; index++) {
        if (signal.aborted) break;
        const entry = files[index];
        const update = data => report({ ...data, file: entry.name, fileIndex: index + 1, files: files.length, completedFiles: result.completedFiles, failedFiles: result.failedFiles, bytes: result.bytes, phase: '解压' });
        try {
          const source = (await authorizedLocalPath(path.join(listing.path, entry.name))).resolved;
          if (!(await fsp.stat(source)).isFile()) throw new Error('请选择压缩文件');
          update({ currentBytes: 0 });
          const extracted = await extractLocalArchive(source, extractFolder, signal, progress => update({ currentBytes: progress.bytes }));
          result.destination = extracted.destination;
          registerLocalExtraction(source, extracted.paths);
          result.paths.push(...extracted.paths); result.bytes += extracted.bytes; result.completedFiles++;
        } catch (error) {
          if (signal.aborted) break;
          result.failedFiles++; result.errors.push(`${entry.name}: ${error.message}`);
        }
        update({});
      }
      await rememberLocal(undefined, result.paths);
      return { ...result, cancelled: signal.aborted, error: result.errors.join('；'), openPath: result.paths[0] };
    });
  },
  extract: async (remoteFile, local = false) => {
    let localSource;
    if (local && remoteFile) { localSource = (await authorizedLocalPath(remoteFile)).resolved; remoteFile = undefined; }
    let source = localSource || remoteFile;
    if (!source) {
      const chosen = await dialog.showOpenDialog(win, { title: '选择本地压缩日志', properties: ['openFile'] });
      if (chosen.canceled) return null;
      source = chosen.filePaths[0];
    }
    await fsp.mkdir(config.directories.extract, { recursive: true, mode: 0o700 });
    const owner = connectionName;
    const origin = connectionOrigin;
    return runTask('解压', async (signal, report) => {
      let archive = source;
      if (remoteFile) {
        archive = path.join(cacheRoot, crypto.randomUUID() + '-' + path.basename(source));
        const attrs = await callSftp('stat', source);
        try {
          const bytes = await copyStream(remoteSource(sftp, source, 0, attrs.size, signal), archive, attrs.size, signal, report);
          const after = await callSftp('stat', source);
          if (bytes !== attrs.size || after.size !== attrs.size || after.mtime !== attrs.mtime) throw new Error('远程归档在下载过程中改变，请重试');
        } catch (error) { await fsp.rm(archive, { force: true }); throw error; }
      }
      const destination = remoteFile ? extractionPath(config.directories.extract, origin.host, source) : undefined;
      try {
        if (remoteFile) await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const result = remoteFile ? await extractArchive(archive, destination, signal, report, path.basename(source), true) : await extractLocalArchive(source, config.directories.extract, signal, report);
        result.paths.sort((a, b) => Number(/\.(log|txt)$/i.test(b)) - Number(/\.(log|txt)$/i.test(a)) || a.localeCompare(b));
        if (!remoteFile) registerLocalExtraction(source, result.paths);
        await rememberLocal(remoteFile, result.paths, owner);
        return { ...result, origin: remoteFile ? origin.label : undefined, openPath: result.paths[0] };
      }
      finally { if (remoteFile) await fsp.rm(archive, { force: true }); }
    }, remoteFile ? origin.label : undefined);
  },
};

app.whenReady().then(async () => {
  configPath = path.join(app.getPath('userData'), 'settings.json');
  try { config = JSON.parse(await fsp.readFile(configPath, 'utf8')); } catch { config = {}; }
  config = { profiles: [], hosts: {}, bookmarks: {}, theme: 'midnight', sshLogMode: 'printable', sshEnabled: false, telnetEnabled: true, ...config };
  const fontSettings = await logFont;
  try { config.logFont = fontSettings.validateLogFont(config.logFont); }
  catch { config.logFont = { ...fontSettings.defaultLogFont }; }
  config.directories = { download: path.join(app.getPath('downloads'), 'SSH Log Viewer', 'downloads'), extract: path.join(app.getPath('downloads'), 'SSH Log Viewer', 'extracted'), ...config.directories };
  credentials = new CredentialStore(app.getPath('userData'), safeStorage);
  config.localCopies ||= [];
  for (const item of config.localCopies) for (const file of item.paths || []) extractedFiles.add(file);
  for (const item of config.localExtractions || []) for (const file of item.paths || []) extractedFiles.add(file);
  config.lastLocalPaths = (config.lastLocalPaths || []).filter(file => fs.existsSync(file));
  for (const file of config.lastLocalPaths) extractedFiles.add(file);
  config.jumpProfiles ||= [];
  let migratedJump = false;
  for (const profile of config.profiles) {
    if (profile.jump?.host && !profile.jumpName) {
      const base = `${profile.name} 跳板机`; let name = base, suffix = 2;
      while (config.jumpProfiles.some(item => item.name === name)) name = `${base} ${suffix++}`;
      config.jumpProfiles.push({ ...profile.jump, name, enabled: true }); profile.jumpName = name; migratedJump = true;
    }
  }
  if (migratedJump) await save();
  cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-log-viewer-'));
  const updateOptions = {};
  if (!app.isPackaged && process.env.VIEWER_DATA_DIR && process.env.VIEWER_UPDATE_TEST_URL) {
    const endpoint = new URL(process.env.VIEWER_UPDATE_TEST_URL);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('更新测试服务必须监听本机回环地址');
    updateOptions.releaseApiUrl = endpoint.href;
    updateOptions.allowedTestOrigins = [endpoint.origin];
  }
  updater = require('./updater.cjs').createUpdater({
    currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
    cacheDir: path.join(app.getPath('userData'), 'updates'), isPackaged: app.isPackaged,
    fetch: require('./updater-fetch.cjs').createUpdateFetch(net),
    emit: update => event({ type: 'update-state', update: { ...update, autoCheck: config.autoCheckUpdates !== false } }),
    openInstaller: require('./update-installer.cjs').createInstaller({ platform: process.platform, appPath: app.isPackaged ? path.resolve(process.resourcesPath, '..', '..') : undefined, openPath: file => shell.openPath(file) }),
    openReleasePage: url => shell.openExternal(url),
    revealInstaller: file => shell.showItemInFolder(file), quit: () => app.quit(),
    ...updateOptions,
  });
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, '../assets/icon.png'));
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1440, workArea.width), height = Math.min(940, workArea.height);
  win = new BrowserWindow({ x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + (workArea.height - height) / 2), width, height, minWidth: Math.min(1000, width), minHeight: Math.min(680, height), backgroundColor: '#101721', icon: path.join(__dirname, '../assets/icon.png'), title: `SSH Log Viewer v${app.getVersion()}`, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, (e, ...args) => {
    if (e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw new Error('非法请求');
    return handler(...args);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (process.env.VIEWER_DEV_URL === 'http://127.0.0.1:5173') await win.loadURL(process.env.VIEWER_DEV_URL);
  else await win.loadFile(path.join(__dirname, '../dist/index.html'));
  scheduleUpdateChecks();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', e => {
  terminalModes.cancel();
  sshTerminal.close();
  webTelnet.close();
  telnet.close();
  if (quitting) return;
  e.preventDefault(); quitting = true;
  clearTimeout(updateTimer); clearInterval(updateInterval);
  const releasing = disconnect({ releasePort: true }).catch(error => console.error('退出时 SSH 远端清理失败：', error.message));
  Promise.allSettled([updater?.dispose(), releasing, saveQueue, credentials?.queue, telnetOutputQueue, telnetConnectionLogQueue, ...telnetSetups, sshTerminal.drain()]).then(() => saveQueue).finally(() => fsp.rm(cacheRoot, { recursive: true, force: true })).finally(() => app.quit());
});
