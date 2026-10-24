const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const targets = {
  linux: { extension: '.deb', platform: 'linux', arches: ['x64', 'arm64', 'armv7l', 'ia32'] },
  windows: { extension: '.exe', platform: 'win32', arches: ['x64', 'arm64', 'ia32'] },
  macos: { extension: '.dmg', platform: 'darwin', arches: ['x64', 'arm64'] },
};

function validateVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version || '');
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('invalid release version');
  }
}

function validateArch(target, arch) {
  if (!targets[target]?.arches.includes(arch)) throw new Error(`unsupported architecture for ${target}: ${arch}`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function collect(target, version, arch = process.arch) {
  validateVersion(version);
  validateArch(target, arch);
  const { extension, platform } = targets[target];
  const releaseDir = path.resolve('release');
  const artifactDir = path.resolve('artifacts');
  const files = fs.readdirSync(releaseDir)
    .filter(name => name.toLowerCase().endsWith(extension))
    .map(name => path.join(releaseDir, name));
  if (files.length !== 1 || !fs.lstatSync(files[0]).isFile() || !fs.statSync(files[0]).size) {
    throw new Error(`expected one non-empty ${extension} in release/`);
  }
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const asset = `ssh-log-viewer-${version}-${target}${extension}`;
  const output = path.join(artifactDir, asset);
  fs.copyFileSync(files[0], output);
  const bytes = fs.readFileSync(output);
  const hash = sha256(bytes);
  fs.writeFileSync(`${output}.sha256`, `${hash}  ${asset}\n`);
  const metadata = { schemaVersion: 1, version, platform, arch, asset, size: bytes.length, sha256: hash };
  fs.writeFileSync(path.join(artifactDir, `ssh-log-viewer-${version}-${target}.update.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Collected ${output} (${arch}) with update metadata`);
}

if (require.main === module) {
  const [target, version, option, arch, ...extra] = process.argv.slice(2);
  if (!target || !version || (option && (option !== '--arch' || !arch)) || extra.length) {
    throw new Error('usage: node scripts/collect-release.cjs <target> <version> [--arch <architecture>]');
  }
  collect(target, version, arch);
}

module.exports = { targets, validateVersion, validateArch, sha256 };
