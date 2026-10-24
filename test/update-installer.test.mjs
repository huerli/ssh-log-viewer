import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstaller } from '../electron/update-installer.cjs';

test('Linux installer waits for authorized APT completion and passes the path without a shell', async () => {
  let complete;
  let finished = false;
  const install = createInstaller({ platform: 'linux', execute: (command, args, options, callback) => {
    assert.equal(command, '/usr/bin/pkexec');
    assert.deepEqual(args, ['--disable-internal-agent', '/usr/bin/apt-get', 'install', '--yes', '/tmp/update space;literal.deb']);
    assert.equal(options.shell, undefined);
    complete = callback;
  } });
  const pending = install('/tmp/update space;literal.deb').then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  complete(null, '', '');
  await pending;
  assert.equal(finished, true);
});

test('Linux install cancellation, missing authorization and package errors remain retryable', async () => {
  for (const [code, message] of [[126, /取消/], [127, /授权/], ['ENOENT', /polkit/], [100, /package is broken/]]) {
    const install = createInstaller({ platform: 'linux', execute: (_command, _args, _options, callback) => callback({ code }, '', 'package is broken') });
    await assert.rejects(install('/tmp/update.deb'), message);
  }
});

test('Linux rejects invalid paths; other platforms retain their default installer', async () => {
  const install = createInstaller({ platform: 'linux', execute: () => assert.fail('must not execute') });
  await assert.rejects(install('relative.deb'), /路径/);
  await assert.rejects(install('/tmp/file.exe'), /路径/);
  let opened;
  await createInstaller({ platform: 'win32', openPath: async file => { opened = file; return ''; } })('C:\\update.exe');
  assert.equal(opened, 'C:\\update.exe');
});
