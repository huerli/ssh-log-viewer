const fs = require('node:fs');
const path = require('node:path');
const { targets, releaseVariants, releaseStem, validateVersion, validateArch, sha256 } = require('./collect-release.cjs');

function validateUpdates(directory, version, targetOnly, expectedArch) {
  validateVersion(version);
  if (targetOnly) validateArch(targetOnly, expectedArch);
  const selected = targetOnly ? [{ target: targetOnly, arch: expectedArch }] : releaseVariants;
  const expected = [];
  for (const { target, arch } of selected) {
    const { extension, platform } = targets[target];
    const stem = releaseStem(target, version, arch);
    const asset = `${stem}${extension}`;
    const metadataName = `${stem}.update.json`;
    expected.push(asset, `${asset}.sha256`, metadataName);
    for (const name of [asset, `${asset}.sha256`, metadataName]) {
      if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`expected regular file: ${name}`);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, metadataName), 'utf8'));
    const keys = ['schemaVersion', 'version', 'platform', 'arch', 'asset', 'size', 'sha256'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        Object.keys(metadata).length !== keys.length || !keys.every(key => Object.hasOwn(metadata, key))) {
      throw new Error(`invalid metadata schema: ${metadataName}`);
    }
    if (metadata.schemaVersion !== 1 || metadata.version !== version || metadata.platform !== platform || metadata.asset !== asset) {
      throw new Error(`metadata does not match release: ${metadataName}`);
    }
    validateArch(target, metadata.arch);
    if (metadata.arch !== arch) throw new Error(`metadata architecture mismatch: ${metadataName}`);
    const bytes = fs.readFileSync(path.join(directory, asset));
    const hash = sha256(bytes);
    if (!bytes.length || !Number.isSafeInteger(metadata.size) || metadata.size !== bytes.length || metadata.sha256 !== hash) {
      throw new Error(`installer size or hash mismatch: ${asset}`);
    }
    const checksum = fs.readFileSync(path.join(directory, `${asset}.sha256`), 'utf8');
    if (checksum !== `${hash}  ${asset}\n`) throw new Error(`checksum mismatch: ${asset}`);
  }
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw new Error('expected exactly the required installers, checksums, and update metadata files');
  console.log(`Validated ${selected.length} update metadata files and final installers for ${version}`);
}

if (require.main === module) {
  const [directory, version, targetOption, target, archOption, arch, ...extra] = process.argv.slice(2);
  if (!directory || !version || extra.length || (targetOption && (targetOption !== '--target' || !target || archOption !== '--arch' || !arch))) {
    throw new Error('usage: node scripts/validate-updates.cjs <asset-directory> <version> [--target <target> --arch <architecture>]');
  }
  validateUpdates(path.resolve(directory), version, target, arch);
}

module.exports = { validateUpdates };
