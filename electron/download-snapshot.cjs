const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function snapshotCommand(file, destination, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('无效远程文件大小');
  const raw = quote(destination + '.raw');
  // Stage exactly the initial length before compression; avoid a pipeline hiding
  // a failed read, and clean up the raw snapshot on cancellation or failure.
  return `umask 077; set -C; trap ${quote('rm -f -- ' + raw)} EXIT; head -c ${size} < ${quote(file)} > ${raw} && test "$(wc -c < ${raw})" -eq ${size} && gzip -c < ${raw} > ${quote(destination)}`;
}

function sourceChanged(before, after, allowAppend) {
  return allowAppend
    ? after.size < before.size || (after.size === before.size && after.mtime !== before.mtime)
    : after.size !== before.size || after.mtime !== before.mtime;
}

module.exports = { snapshotCommand, sourceChanged };
