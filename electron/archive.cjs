const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const tar = require('tar-stream');
const yauzl = require('yauzl');

const MAX_BYTES = 1024 * 1024 * 1024;
function safePath(root, name) {
  if (!name || name.includes('\\') || /^[a-z]:/i.test(name) || path.posix.isAbsolute(name) || name.split('/').includes('..'))
    throw new Error(`归档路径不安全: ${name}`);
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`归档路径不安全: ${name}`);
  return target;
}
async function extractArchive(source, destination, signal, progress = () => {}, originalName = path.basename(source)) {
  // A new directory avoids following pre-existing symbolic links or overwriting files.
  await fsp.mkdir(destination, { recursive: false, mode: 0o700 });
  let bytes = 0, files = 0;
  const paths = [];
  const limit = () => new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) callback(new Error('解压内容超过 1GB 限制'));
    else { progress({ bytes, files }); callback(null, chunk); }
  }});
  const copy = async (stream, name) => {
    if (++files > 20000) throw new Error('归档文件数超过 20000');
    const target = safePath(destination, name);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await pipeline(...(Array.isArray(stream) ? stream : [stream]), limit(), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    paths.push(target);
  };
  try {
    if (/\.zip$/i.test(source)) {
      const zip = await new Promise((resolve, reject) => yauzl.open(source, { lazyEntries: true }, (e, z) => e ? reject(e) : resolve(z)));
      await new Promise((resolve, reject) => {
        const abort = () => { zip.close(); reject(new Error('操作已取消')); };
        signal.addEventListener('abort', abort, { once: true });
        const fail = error => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', () => { signal.removeEventListener('abort', abort); resolve(); });
        zip.on('entry', async entry => {
          try {
            if (signal.aborted) throw new Error('操作已取消');
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (mode === 0xa000) throw new Error('不允许解压符号链接');
            safePath(destination, entry.fileName);
            if (entry.fileName.endsWith('/')) {
              await fsp.mkdir(safePath(destination, entry.fileName), { recursive: true, mode: 0o700 });
            } else {
              const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
              await copy(stream, entry.fileName);
            }
            zip.readEntry();
          } catch (error) { fail(error); }
        });
        if (signal.aborted) abort(); else zip.readEntry();
      });
    } else if (/\.(tar\.gz|tgz|tar)$/i.test(source)) {
      const extractor = tar.extract();
      extractor.on('entry', (header, stream, next) => {
        (async () => {
          const name = header.name.replace(/^\.\//, '');
          if ((name === '.' || name === '') && header.type === 'directory') { stream.resume(); return; }
          const target = safePath(destination, name);
          if (header.type === 'directory') {
            await fsp.mkdir(target, { recursive: true, mode: 0o700 }); stream.resume();
          } else if (header.type === 'file') await copy(stream, header.name.replace(/^\.\//, ''));
          else throw new Error(`不支持的归档条目: ${header.type}`);
        })().then(() => next(), e => extractor.destroy(e));
      });
      const streams = [fs.createReadStream(source)];
      if (!/\.tar$/i.test(source)) streams.push(zlib.createGunzip());
      await pipeline(...streams, extractor, { signal });
    } else if (/\.gz$/i.test(source)) {
      await copy([fs.createReadStream(source), zlib.createGunzip()], path.basename(originalName).slice(0, -3));
    } else throw new Error('支持 .gz、.zip、.tar、.tar.gz、.tgz');
    return { destination, files, bytes, paths };
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
async function extractLocalArchive(source, root, signal, progress = () => {}) {
  const group = path.basename(path.dirname(path.resolve(source))) || 'local';
  const destination = path.join(root, group);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  async function directory(target) {
    try { await fsp.mkdir(target, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const attrs = await fsp.lstat(target);
    if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw new Error(`解压目标不是普通目录: ${target}`);
  }
  await directory(destination);
  const staging = await fsp.mkdtemp(path.join(root, '.local-extract-'));
  const published = [];
  try {
    const unpacked = path.join(staging, 'content');
    const result = await extractArchive(source, unpacked, signal, progress);
    for (const file of result.paths) {
      if (signal.aborted) throw new Error('操作已取消');
      const relative = path.relative(unpacked, file);
      let parent = destination;
      for (const part of relative.split(path.sep).slice(0, -1)) {
        parent = path.join(parent, part); await directory(parent);
      }
      const original = path.basename(file), parsed = path.parse(original);
      let stem = parsed.name;
      while (Buffer.byteLength(stem + parsed.ext) > 240) stem = [...stem].slice(0, -1).join('');
      let target;
      for (let index = 1; index <= 10000; index++) {
        if (signal.aborted) throw new Error('操作已取消');
        target = path.join(parent, index === 1 ? original : `${stem} (${index})${parsed.ext}`);
        try { await fsp.link(file, target); published.push(target); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; target = undefined; }
      }
      if (!target) throw new Error('同名文件过多，请更换解压目录');
    }
    return { ...result, destination, paths: published };
  } catch (error) {
    await Promise.allSettled(published.map(file => fsp.unlink(file)));
    throw error;
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
module.exports = { safePath, extractArchive, extractLocalArchive };
