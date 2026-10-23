const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [target, version] = process.argv.slice(2);
if (!target || !version) throw new Error('usage: node scripts/collect-release.cjs <target> <version>');
const extension = { linux: '.AppImage', windows: '.exe', macos: '.dmg' }[target];
if (!extension) throw new Error(`unsupported target: ${target}`);
const releaseDir = path.resolve('release');
const artifactDir = path.resolve('artifacts');
fs.rmSync(artifactDir, { recursive: true, force: true });
fs.mkdirSync(artifactDir, { recursive: true });
const files = fs.readdirSync(releaseDir)
  .filter(name => name.toLowerCase().endsWith(extension.toLowerCase()))
  .map(name => path.join(releaseDir, name));
if (files.length !== 1 || !fs.statSync(files[0]).size) throw new Error(`expected one non-empty ${extension} in release/`);
const output = path.join(artifactDir, `ssh-log-viewer-${version}-${target}${extension}`);
fs.copyFileSync(files[0], output);
const hash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
fs.writeFileSync(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`);
console.log(`Collected ${output}`);
