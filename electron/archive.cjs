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
module.exports = { safePath, extractArchive };
