import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const version = '1.2.3-rc.1+build.5';
const targets = { linux: ['.deb', 'linux', 'x64'], windows: ['.exe', 'win32', 'ia32'], macos: ['.dmg', 'darwin', 'arm64'] };
function run(script, args, cwd) {
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd, encoding: 'utf8' });
}
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-release-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'release'));
  fs.mkdirSync(path.join(cwd, 'assets'));
  for (const [target, [ext, platform, arch]] of Object.entries(targets)) {
    const bytes = Buffer.from(`dummy ${platform} installer\0\xff`, 'utf8');
    fs.writeFileSync(path.join(cwd, 'release', `original${ext}`), bytes);
    const result = run('collect-release.cjs', [target, version, '--arch', arch], cwd);
    assert.equal(result.status, 0, result.stderr);
    const checked = run('validate-updates.cjs', ['artifacts', version, '--target', target, '--arch', arch], cwd);
    assert.equal(checked.status, 0, checked.stderr);
    for (const name of fs.readdirSync(path.join(cwd, 'artifacts'))) fs.copyFileSync(path.join(cwd, 'artifacts', name), path.join(cwd, 'assets', name));
  }
  return { cwd, assets: path.join(cwd, 'assets'), validate: () => run('validate-updates.cjs', ['assets', version], cwd) };
}
const metadataName = `ssh-log-viewer-${version}-linux.update.json`;

test('collects exact updater schema and validates final bytes for all platforms', t => {
  const { assets, validate } = fixture(t);
  for (const [target, [ext, platform, arch]] of Object.entries(targets)) {
    const asset = `ssh-log-viewer-${version}-${target}${ext}`;
    const bytes = fs.readFileSync(path.join(assets, asset));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(assets, `ssh-log-viewer-${version}-${target}.update.json`))), {
      schemaVersion: 1, version, platform, arch, asset, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const result = validate();
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate] of Object.entries({
  missing: assets => fs.unlinkSync(path.join(assets, metadataName)),
  duplicate: assets => fs.copyFileSync(path.join(assets, metadataName), path.join(assets, 'duplicate.update.json')),
  corrupt: assets => fs.writeFileSync(path.join(assets, metadataName), '{'),
  installer: assets => fs.appendFileSync(path.join(assets, `ssh-log-viewer-${version}-linux.deb`), 'corrupt'),
  checksum: assets => fs.writeFileSync(path.join(assets, `ssh-log-viewer-${version}-linux.deb.sha256`), 'invalid'),
  empty: assets => fs.writeFileSync(path.join(assets, `ssh-log-viewer-${version}-linux.deb`), ''),
  symlink: assets => { fs.unlinkSync(path.join(assets, metadataName)); fs.symlinkSync('missing', path.join(assets, metadataName)); },
})) {
  test(`rejects ${name} release asset`, t => {
    const { assets, validate } = fixture(t);
    mutate(assets);
    assert.notEqual(validate().status, 0);
  });
}
for (const [field, value] of Object.entries({ schemaVersion: 2, version: '1.2.4', platform: 'darwin', arch: 'universal', asset: '../escape.deb', size: 1, sha256: 'a'.repeat(64), extra: true })) {
  test(`rejects mismatched metadata ${field}`, t => {
    const { assets, validate } = fixture(t);
    const file = path.join(assets, metadataName);
    const data = JSON.parse(fs.readFileSync(file));
    data[field] = value;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.notEqual(validate().status, 0);
  });
}

test('rejects unsafe or invalid versions before modifying artifacts', t => {
  const { cwd } = fixture(t);
  for (const invalid of ['../escape', '1.2', '01.2.3', '1.2.3-01', '1.2.3/path', 'v1.2.3', '1.2.3\n']) {
    const result = run('collect-release.cjs', ['linux', invalid], cwd);
    assert.notEqual(result.status, 0, invalid);
  }
  assert.notEqual(run('collect-release.cjs', ['linux', version, '--arch', 'unknown'], cwd).status, 0);
  assert.notEqual(run('collect-release.cjs', ['bogus', version], cwd).status, 0);
});

test('collector rejects empty or multiple installers', t => {
  const { cwd } = fixture(t);
  const installer = path.join(cwd, 'release', 'original.deb');
  fs.writeFileSync(installer, '');
  assert.notEqual(run('collect-release.cjs', ['linux', version], cwd).status, 0);
  fs.writeFileSync(installer, 'one');
  fs.writeFileSync(path.join(cwd, 'release', 'another.deb'), 'two');
  assert.notEqual(run('collect-release.cjs', ['linux', version], cwd).status, 0);
});

test('per-build validation binds metadata to the packaging architecture', t => {
  const { cwd } = fixture(t);
  const result = run('validate-updates.cjs', ['artifacts', version, '--target', 'macos', '--arch', 'x64'], cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /architecture mismatch/);
});
