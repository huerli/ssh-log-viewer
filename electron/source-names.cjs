const path = require('node:path');
const crypto = require('node:crypto');

const clean = text => String(text).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/\s+/g, '_').replace(/[. ]+$/, '') || 'device';
function fit(text, bytes) {
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result;
}
function sourceIdentity(profile) {
  const endpoint = `${profile.username}@${profile.host}_${Number(profile.port || 22)}`;
  const via = profile.jump?.enabled ? `--via-${profile.jump.username}@${profile.jump.host}_${Number(profile.jump.port || 22)}` : '';
  const label = profile.name && profile.name !== profile.host ? `${profile.name}--` : '';
  let tag = clean(label + endpoint + via);
  if (Buffer.byteLength(tag) > 96) tag = fit(tag, 85) + '--' + crypto.createHash('sha256').update(label + endpoint + via).digest('hex').slice(0, 8);
  return { tag, label: `${label ? profile.name + ' · ' : ''}${profile.username}@${profile.host}:${Number(profile.port || 22)}${profile.jump?.enabled ? `（经 ${profile.jump.username}@${profile.jump.host}:${Number(profile.jump.port || 22)}）` : ''}` };
}
function sourceFilename(tag, originalName, suffix = '') {
  const original = clean(path.posix.basename(originalName));
  const extension = original.match(/\.tar\.gz$/i)?.[0] || path.posix.extname(original);
  // Reserve nine bytes for the no-overwrite collision suffix, including its separator.
  const budget = 255 - Buffer.byteLength(tag + '__') - 9;
  const ext = fit(extension, Math.max(0, budget - 1));
  const stem = fit(original.slice(0, original.length - extension.length), budget - Buffer.byteLength(ext)) || '_';
  return `${tag}__${suffix ? suffix + '-' : ''}${stem}${ext}`;
}
function downloadPath(root, host, remote, date = new Date(), suffix = '') {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const folder = fit(clean(path.posix.basename(path.posix.dirname(remote)) || 'root'), 240);
  const original = clean(path.posix.basename(remote));
  const extension = original.match(/\.tar\.gz$/i)?.[0] || path.posix.extname(original);
  const stem = fit(original.slice(0, original.length - extension.length), 255 - Buffer.byteLength(extension) - 9);
  const address = fit(clean(host), 240);
  return path.join(root, address === '.' || address === '..' ? 'device' : address, folder === '.' || folder === '..' ? 'root' : folder, day, `${stem}${suffix ? '-' + suffix : ''}${extension}`);
}
module.exports = { sourceIdentity, sourceFilename, downloadPath };
