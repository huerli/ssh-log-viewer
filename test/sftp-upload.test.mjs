import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { uploadFiles } = createRequire(import.meta.url)('../electron/sftp-upload.cjs');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote');
  await mkdir(local); await mkdir(remote); await mkdir(path.join(remote, 'logs'));
  const calls = [], handles = new Set();
  const sftp = {
    resolve(file) { assert.equal(this, sftp); return path.join(remote, file); },
    lstat(file, callback) { calls.push(['lstat', file]); fs.lstat(this.resolve(file), callback); },
    open(file, flags, callback) {
      calls.push(['open', file, flags]);
      fs.open(this.resolve(file), flags, (error, fd) => {
        if (error) return callback(error);
        const handle = Buffer.alloc(4); handle.writeUInt32BE(fd); handles.add(fd); callback(null, handle);
      });
    },
    write(handle, buffer, offset, length, position, callback) {
      assert.equal(this, sftp); calls.push(['write', length]);
      fs.write(handle.readUInt32BE(), buffer, offset, length, position, callback);
    },
    close(handle, callback) {
      assert.equal(this, sftp); calls.push(['close']);
      const fd = handle.readUInt32BE(); handles.delete(fd); fs.close(fd, callback);
    },
    unlink(file, callback) { calls.push(['unlink', file]); fs.unlink(this.resolve(file), callback); }
  };
  t.after(() => { for (const fd of handles) fs.closeSync(fd); });
  return { local, remote, sftp, calls, handles };
}

async function localFile(local, name, content = '中文日志\n') {
  const file = path.join(local, name); await writeFile(file, content); return file;
}

test('uploads multiple files including empty files with bound SFTP methods and progress', async t => {
  const { local, remote, sftp, calls, handles } = await fixture(t);
  const source = await localFile(local, '中文.log'), empty = await localFile(local, 'empty.txt', '');
  const updates = [];
  const result = await uploadFiles(sftp, [source, empty], '/logs', new AbortController().signal, update => updates.push(update));
  assert.equal(result.completedFiles, 2); assert.equal(result.failedFiles, 0); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.paths, ['/logs/中文.log', '/logs/empty.txt']);
  assert.equal(await readFile(path.join(remote, 'logs', '中文.log'), 'utf8'), '中文日志\n');
  assert.equal(await readFile(path.join(remote, 'logs', 'empty.txt'), 'utf8'), '');
  assert.equal(result.bytes, Buffer.byteLength('中文日志\n')); assert.equal(result.size, result.bytes);
  assert.equal(handles.size, 0);
  assert.ok(calls.filter(call => call[0] === 'open').every(call => call[2] === 'wx'));
  assert.ok(updates.every(update => update.phase === '上传' && update.files === 2 && update.size === result.size));
  assert.equal(updates.at(-1).completedFiles, 2); assert.equal(updates.at(-1).fileIndex, 2);
  assert.ok(updates.some(update => update.currentBytes > 0 && update.currentSize === result.size));
});

test('skips existing files, directories, symlinks and repeated names without removing them', async t => {
  const { local, remote, sftp, calls } = await fixture(t);
  const existing = await localFile(local, 'existing.log', 'replacement');
  await writeFile(path.join(remote, 'logs', 'existing.log'), 'keep');
  const directory = await localFile(local, 'directory'); await mkdir(path.join(remote, 'logs', 'directory'));
  const linked = await localFile(local, 'linked.log');
  await fs.promises.symlink('existing.log', path.join(remote, 'logs', 'linked.log'));
  const fresh = await localFile(local, 'fresh.log');
  const result = await uploadFiles(sftp, [existing, directory, linked, fresh, fresh], '/logs');
  assert.equal(result.completedFiles, 1); assert.equal(result.failedFiles, 4);
  assert.equal(await readFile(path.join(remote, 'logs', 'existing.log'), 'utf8'), 'keep');
  assert.equal((await fs.promises.lstat(path.join(remote, 'logs', 'linked.log'))).isSymbolicLink(), true);
  assert.equal(calls.some(call => call[0] === 'unlink'), false);
  const overwrite = await uploadFiles(sftp, [existing], '/logs', new AbortController().signal, () => {}, true);
  assert.equal(overwrite.completedFiles, 1); assert.equal(overwrite.failedFiles, 0);
  assert.equal(await readFile(path.join(remote, 'logs', 'existing.log'), 'utf8'), 'replacement');
});

test('rejects local directories and missing sources while continuing valid files', async t => {
  const { local, remote, sftp, calls } = await fixture(t);
  const source = await localFile(local, 'valid.log');
  const result = await uploadFiles(sftp, [local, path.join(local, 'missing'), source], '/logs');
  assert.equal(result.failedFiles, 2); assert.equal(result.completedFiles, 1);
  assert.match(result.errors[0], /不支持目录/);
  assert.equal(calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(await readFile(path.join(remote, 'logs', 'valid.log'), 'utf8'), '中文日志\n');
});

test('exclusive open prevents races after existence checks and never unlinks failed creates', async t => {
  const { local, remote, sftp, calls } = await fixture(t);
  const source = await localFile(local, 'raced.log');
  const open = sftp.open;
  sftp.open = function(file, flags, callback) {
    fs.writeFile(this.resolve(file), 'created by another client', error => error ? callback(error) : open.call(this, file, flags, callback));
  };
  const result = await uploadFiles(sftp, [source], '/logs');
  assert.equal(result.failedFiles, 1); assert.equal(result.completedFiles, 0);
  assert.equal(await readFile(path.join(remote, 'logs', 'raced.log'), 'utf8'), 'created by another client');
  assert.equal(calls.some(call => call[0] === 'unlink'), false);
});

test('write errors close handles, remove partial output, and continue the next file', async t => {
  const { local, remote, sftp, calls, handles } = await fixture(t);
  const broken = await localFile(local, 'broken.log', Buffer.alloc(200000)), good = await localFile(local, 'good.log');
  const write = sftp.write; let attempts = 0;
  sftp.write = function(...args) {
    if (++attempts === 2) return setImmediate(() => args.at(-1)(new Error('write failed')));
    write.apply(this, args);
  };
  const result = await uploadFiles(sftp, [broken, good], '/logs');
  assert.equal(result.failedFiles, 1); assert.equal(result.completedFiles, 1);
  assert.match(result.errors[0], /write failed/); await assert.rejects(access(path.join(remote, 'logs', 'broken.log')));
  assert.equal(handles.size, 0);
  const removal = calls.findIndex(call => call[0] === 'unlink');
  assert.ok(calls.slice(0, removal).some(call => call[0] === 'close'));
});

test('cancellation during a write waits for it to finish before close and removes partial output', async t => {
  const { local, remote, sftp, handles } = await fixture(t);
  const source = await localFile(local, 'cancel.log', Buffer.alloc(200000)), later = await localFile(local, 'later.log');
  const controller = new AbortController(), write = sftp.write, close = sftp.close; let wrote = false, writeFinished = false;
  sftp.write = function(...args) {
    wrote = true; controller.abort();
    const callback = args.at(-1);
    args[args.length - 1] = (...result) => { writeFinished = true; callback(...result); };
    setTimeout(() => write.apply(this, args), 10);
  };
  sftp.close = function(...args) { assert.equal(writeFinished, true); close.apply(this, args); };
  const result = await uploadFiles(sftp, [source, later], '/logs', controller.signal);
  assert.equal(wrote, true); assert.equal(result.cancelled, true); assert.equal(result.completedFiles, 0); assert.equal(result.failedFiles, 0);
  assert.equal(handles.size, 0);
  await assert.rejects(access(path.join(remote, 'logs', 'cancel.log')));
  await assert.rejects(access(path.join(remote, 'logs', 'later.log')));
});

test('cancellation while opening cleans the newly acquired exclusive handle', async t => {
  const { local, remote, sftp, handles } = await fixture(t);
  const source = await localFile(local, 'cancel-open.log'), controller = new AbortController(), open = sftp.open;
  sftp.open = function(file, flags, callback) { open.call(this, file, flags, (error, handle) => { controller.abort(); callback(error, handle); }); };
  const result = await uploadFiles(sftp, source, '/logs', controller.signal);
  assert.equal(result.cancelled, true); assert.equal(result.failedFiles, 0); assert.equal(handles.size, 0);
  await assert.rejects(access(path.join(remote, 'logs', 'cancel-open.log')));
});

test('server close failures are upload failures and trigger removal', async t => {
  const { local, remote, sftp } = await fixture(t);
  const source = await localFile(local, 'close.log'), close = sftp.close;
  sftp.close = function(handle, callback) { close.call(this, handle, error => callback(error || new Error('close failed'))); };
  const result = await uploadFiles(sftp, [source], '/logs');
  assert.equal(result.completedFiles, 0); assert.equal(result.failedFiles, 1); assert.match(result.errors[0], /close failed/);
  await assert.rejects(access(path.join(remote, 'logs', 'close.log')));
});

test('cleanup failures retain the failed path in the actionable error', async t => {
  const { local, remote, sftp } = await fixture(t);
  const source = await localFile(local, 'unclean.log');
  sftp.write = function(...args) { setImmediate(() => args.at(-1)(new Error('write failed'))); };
  sftp.unlink = function(file, callback) { setImmediate(() => callback(new Error('permission denied'))); };
  const result = await uploadFiles(sftp, [source], '/logs');
  assert.equal(result.failedFiles, 1); assert.equal(result.completedFiles, 0);
  assert.match(result.errors[0], /无法清理.*\/logs\/unclean.log.*permission denied/);
  await access(path.join(remote, 'logs', 'unclean.log'));
});

test('pre-cancelled uploads make no remote calls and invalid target directories reject', async t => {
  const { local, sftp, calls } = await fixture(t);
  const source = await localFile(local, 'source.log'), controller = new AbortController(); controller.abort();
  const result = await uploadFiles(sftp, [source], '/logs', controller.signal);
  assert.equal(result.cancelled, true); assert.equal(calls.length, 0);
  await assert.rejects(uploadFiles(sftp, [source], '/missing'), /ENOENT/);
  await assert.rejects(uploadFiles(sftp, [], '/logs'), /请选择/);
});
