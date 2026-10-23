const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function prepareSearchExport(data) {
  if (!data || !Array.isArray(data.matches) || !data.matches.length || data.matches.length > 10000) throw new Error('没有可导出的搜索结果');
  const matches = data.matches.map(match => {
    if (!match || typeof match.text !== 'string' || !Number.isSafeInteger(match.line) || match.line < 0) throw new Error('搜索结果格式无效');
    return { ...match, line: match.line + 1, text: match.text };
  }).sort((a, b) => String(a.file || data.file || '').localeCompare(String(b.file || data.file || ''), undefined, { numeric: true }) || a.line - b.line);
  const metadata = { query: String(data.query || ''), regex: Boolean(data.regex), caseSensitive: Boolean(data.caseSensitive), totalMatches: Number(data.count) || matches.length, exportedMatches: matches.length, partial: Boolean(data.partial), capped: Boolean(data.capped), note: '日志内容从原始文件重新读取为完整单行；不限制单行长度。' };
  return { matches, metadata };
}

function formatSearchExport(data, filename) {
  const { matches, metadata } = prepareSearchExport(data);
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.json') return JSON.stringify({ ...metadata, matches: matches.map(({ line, text }) => ({ line, text })) }, null, 2) + '\n';
  if (extension === '.csv') {
    const cell = value => '"' + String(value).replace(/"/g, '""') + '"';
    return '\uFEFF' + [['行号', '日志内容'], ...matches.map(match => [match.line, match.text])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  return [`搜索内容：${metadata.query}`, `导出 ${matches.length} 条 / 已匹配 ${metadata.totalMatches} 条${metadata.partial ? '（搜索尚未完成或已取消）' : ''}${metadata.capped ? '（仅导出展示范围内的结果）' : ''}`, metadata.note, '', ...matches.map(match => `[${match.line}] ${match.text}`)].join('\n') + '\n';
}

async function* exportChunks(data, filename, readText) {
  const { matches, metadata } = prepareSearchExport(data);
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.json') {
    yield '{\n';
    for (const [key, value] of Object.entries(metadata)) yield `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`;
    yield '  "matches": [';
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      yield `${index ? ',' : ''}\n    {\n      "line": ${match.line},\n      "text": "`;
      for await (const chunk of readText(match)) yield JSON.stringify(chunk).slice(1, -1);
      yield '"\n    }';
    }
    yield '\n  ]\n}\n';
    return;
  }
  if (extension === '.csv') {
    yield '\uFEFF';
    const cell = value => '"' + String(value).replace(/"/g, '""') + '"';
    yield `${cell('行号')},${cell('日志内容')}\r\n`;
    for (const match of matches) {
      yield `${cell(match.line)},"`;
      for await (const chunk of readText(match)) yield chunk.replace(/"/g, '""');
      yield '"\r\n';
    }
    return;
  }
  yield `搜索内容：${metadata.query}\n`;
  yield `导出 ${matches.length} 条 / 已匹配 ${metadata.totalMatches} 条${metadata.partial ? '（搜索尚未完成或已取消）' : ''}${metadata.capped ? '（仅导出展示范围内的结果）' : ''}\n`;
  yield `${metadata.note}\n\n`;
  for (const match of matches) {
    yield `[${match.line}] `;
    for await (const chunk of readText(match)) yield chunk;
    yield '\n';
  }
}

async function writeSearchExport(data, filename, readText) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.part`);
  try {
    await pipeline(
      Readable.from(exportChunks(data, filename, readText), { objectMode: false }),
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

module.exports = { formatSearchExport, writeSearchExport };
