export function filenamePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256 || /[\/\\\r\n]/.test(pattern)) throw new Error('请输入不含路径、最多 256 字符的文件名匹配模式');
  // A date or keyword fragment should also match the extension after it.
  // Keep complete filenames and explicit suffix wildcards anchored.
  if (pattern && !/[*?]$/.test(pattern) && !/\.[a-z][a-z0-9_-]*$/i.test(pattern)) pattern = `*${pattern}*`;
  return new RegExp('^' + [...pattern].map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
}
