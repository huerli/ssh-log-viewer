'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (error, result) => error ? reject(error) : resolve(result));
});
const missing = error => error.code === 2 || error.code === 'ENOENT';
const checkAbort = signal => { if (signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' }); };

// Own the exclusive handle before starting the pipeline. Closing is part of
// stream finalization, so a successful upload includes the server's CLOSE reply.
function remoteSink(sftp, handle) {
  let position = 0, pending = Promise.resolve(), closing;
  const close = () => closing ||= pending.then(() => call(sftp, 'close', handle));
  return new Writable({
    write(chunk, encoding, callback) {
      let settled;
      pending = new Promise(resolve => { settled = resolve; });
      try {
        sftp.write(handle, chunk, 0, chunk.length, position, (error, bytes) => {
          settled();
          if (!error && bytes !== undefined && bytes !== chunk.length) error = new Error('远程文件写入不完整');
          if (!error) position += chunk.length;
          callback(error);
        });
      } catch (error) { settled(); callback(error); }
    },
    final(callback) { close().then(() => callback(), callback); },
    destroy(error, callback) { close().then(() => callback(error), closeError => callback(error || closeError)); }
  });
}

async function copyFile(sftp, local, remote, expectedSize, signal, report, overwrite = false) {
  let owned = false, existingTarget = false, handle, sink, currentBytes = 0;
  try {
    checkAbort(signal);
    try {
      await call(sftp, 'lstat', remote);
      if (!overwrite) throw new Error('远程同名文件已存在，已跳过');
      existingTarget = true;
    } catch (error) { if (!missing(error)) throw error; }
    checkAbort(signal);
    handle = await call(sftp, 'open', remote, overwrite && existingTarget ? 'w' : 'wx');
    owned = true;
    sink = remoteSink(sftp, handle);
    checkAbort(signal);
    const counter = new Transform({ transform(chunk, encoding, callback) {
      currentBytes += chunk.length;
      try { report(currentBytes); callback(null, chunk); } catch (error) { callback(error); }
    } });
    await pipeline(fs.createReadStream(local), counter, sink, ...(signal ? [{ signal }] : []));
    checkAbort(signal);
    if (currentBytes !== expectedSize) throw new Error('本地文件在上传过程中改变，请重试');
    return currentBytes;
  } catch (error) {
    if (owned) {
      // pipeline normally destroys the sink; an abort before pipeline starts
      // needs explicit destruction. Wait for its close before removing the file.
      if (sink && !sink.destroyed) sink.destroy();
      if (sink && !sink.closed) await new Promise(resolve => {
        sink.once('close', resolve);
        sink.once('error', () => {});
      });
      if (!existingTarget) try { await call(sftp, 'unlink', remote); }
      catch (cleanupError) {
        if (!missing(cleanupError)) {
          error.cleanupError = `无法清理未完成的远程文件 ${remote}: ${cleanupError.message}`;
          error.message += `（${error.cleanupError}）`;
        }
      }
    }
    throw error;
  }
}

async function uploadFiles(sftp, localFiles, remoteDirectory, signal, report = () => {}, overwrite = false) {
  const files = typeof localFiles === 'string' ? [localFiles] : localFiles;
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) throw new Error('请选择要上传的本地文件');
  if (typeof remoteDirectory !== 'string' || !remoteDirectory || remoteDirectory.includes('\0')) throw new Error('请选择远程目标目录');
  const result = { completedFiles: 0, failedFiles: 0, errors: [], paths: [], bytes: 0, size: 0, files: files.length, cancelled: false };
  if (signal?.aborted) return { ...result, cancelled: true };
  const directory = await call(sftp, 'lstat', remoteDirectory);
  if (!directory.isDirectory()) throw new Error('远程目标不是目录');
  const entries = [];
  for (const local of files) {
    if (signal?.aborted) return { ...result, cancelled: true };
    try {
      const stats = await fsp.stat(local);
      if (!stats.isFile()) throw new Error('仅支持上传普通文件，不支持目录');
      entries.push({ local, size: stats.size }); result.size += stats.size;
    } catch (error) { entries.push({ local, size: 0, error }); }
  }
  for (let index = 0; index < entries.length; index++) {
    if (signal?.aborted) break;
    const entry = entries[index], file = path.basename(entry.local);
    const remote = path.posix.join(remoteDirectory, file);
    const update = currentBytes => report({ phase: '上传', bytes: result.bytes + currentBytes, size: result.size, currentBytes, currentSize: entry.size, file, fileIndex: index + 1, files: files.length, completedFiles: result.completedFiles, failedFiles: result.failedFiles });
    try {
      update(0);
      if (entry.error) throw entry.error;
      result.bytes += await copyFile(sftp, entry.local, remote, entry.size, signal, update, overwrite);
      result.completedFiles++; result.paths.push(remote);
    } catch (error) {
      if (signal?.aborted) {
        if (error.cleanupError) result.errors.push(error.cleanupError);
        break;
      }
      result.failedFiles++; result.errors.push(`${file}: ${error.message}`);
    }
    update(0);
  }
  result.cancelled = Boolean(signal?.aborted);
  return result;
}

module.exports = { uploadFiles };
