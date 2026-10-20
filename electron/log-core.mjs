import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export const STRIDE = 512;
export const MAX_LINE_BYTES = 1024 * 1024;

// Byte offsets remain valid for UTF-8, CRLF and split multibyte characters.
export async function buildIndex(file, progress = () => {}) {
  const size = (await stat(file)).size;
  const checkpoints = [0];
  let offset = 0, lines = 0, lastNewline = true, lastProgress = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) {
      lines++;
      if (lines % STRIDE === 0) checkpoints.push(offset + at + 1);
    }
    offset += chunk.length;
    lastNewline = chunk[chunk.length - 1] === 10;
    if (Date.now() - lastProgress > 150) { progress({ bytes: offset, size }); lastProgress = Date.now(); }
  }
  if (size && !lastNewline) lines++;
  return { size, lines, checkpoints, stride: STRIDE };
}

export async function* readLines(file, start = 0, end, literal) {
  let parts = [], length = 0, total = 0, offset = start;
  const query = literal ? (literal.caseSensitive ? literal.query : literal.query.toLocaleLowerCase()) : '';
  const needles = literal?.wildcard ? query.split('*').filter(Boolean) : [query];
  let needleIndex = 0;
  let decoder = new StringDecoder('utf8'), carry = '', matched = Boolean(literal && !needles.length);
  function match(text) {
    if (!literal || matched) return;
    const segment = carry + (literal.caseSensitive ? text : text.toLocaleLowerCase());
    let from = 0;
    while (needleIndex < needles.length) {
      const needle = needles[needleIndex];
      const at = segment.indexOf(needle, from);
      if (at < 0) {
        const keep = needle.length - 1;
        carry = keep > 0 ? segment.slice(from).slice(-keep) : '';
        return;
      }
      from = at + needle.length; needleIndex++;
    }
    matched = true; carry = '';
  }
  const stream = createReadStream(file, { start, ...(end === undefined ? {} : { end }), highWaterMark: 256 * 1024 });
  function collect(part) {
    total += part.length;
    if (literal) match(decoder.write(part));
    if (length < MAX_LINE_BYTES) {
      const keep = part.subarray(0, MAX_LINE_BYTES - length);
      parts.push(keep); length += keep.length;
    }
  }
  function emit() {
    if (literal) match(decoder.end());
    const text = Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '');
    const row = { text, offset, truncated: total > MAX_LINE_BYTES, matched };
    offset += total + 1; parts = []; length = 0; total = 0;
    decoder = new StringDecoder('utf8'); carry = ''; needleIndex = 0; matched = Boolean(literal && !needles.length);
    return row;
  }
  for await (const chunk of stream) {
    let from = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) {
      collect(chunk.subarray(from, at)); yield emit(); from = at + 1;
    }
    collect(chunk.subarray(from));
  }
  if (total) yield emit();
}

export async function* readFullLine(file, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('日志行偏移无效');
  const handle = await open(file, 'r');
  const buffer = Buffer.alloc(256 * 1024);
  const decoder = new StringDecoder('utf8');
  let position = offset, pendingCR = false, ended = false;
  try {
    while (!ended) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let part = buffer.subarray(0, bytesRead);
      if (pendingCR) {
        if (part[0] === 10) { yield decoder.end(); return; }
        const text = decoder.write(Buffer.from('\r'));
        if (text) yield text;
        pendingCR = false;
      }
      const newline = part.indexOf(10);
      if (newline >= 0) {
        part = part.subarray(0, newline);
        if (part.at(-1) === 13) part = part.subarray(0, -1);
        ended = true;
      } else if (part.at(-1) === 13) {
        part = part.subarray(0, -1);
        pendingCR = true;
      }
      const text = decoder.write(part);
      if (text) yield text;
    }
    const text = decoder.end();
    if (text) yield text;
  } finally {
    await handle.close();
  }
}

export async function readPage(file, index, start, count = 300) {
  start = Math.max(0, Math.min(Math.floor(start), Math.max(0, index.lines - 1)));
  count = Math.max(1, Math.min(500, Math.floor(count)));
  const block = Math.floor(start / index.stride);
  let line = block * index.stride;
  const rows = [];
  for await (const row of readLines(file, index.checkpoints[block])) {
    if (line >= start) rows.push({ ...row, line, text: row.text.slice(0, 12000), displayTruncated: row.text.length > 12000 });
    line++;
    if (rows.length >= count) break;
  }
  return rows;
}

export async function searchFile(file, query, options = {}, progress = () => {}) {
  if (!query || query.length > 2048) throw new Error('搜索内容不能为空且不得超过 2048 个字符');
  const regex = options.regex ? new RegExp(query, options.caseSensitive ? '' : 'i') : null;
  const matches = []; let line = 0, count = 0, truncatedLines = 0, lastProgress = 0;
  let positions = options.collectPositions ? new Float64Array(2048) : null;
  let positionCount = 0, sentMatches = 0;
  let lastBytes = 0;
  const report = bytes => {
    const delta = matches.slice(sentMatches); sentMatches = matches.length;
    progress({ bytes, size, count, truncatedLines, capped: count > matches.length, ...(!options.collectPositions ? { matches: delta } : {}) });
    lastProgress = Date.now();
  };
  const size = (await stat(file)).size;
  for await (const row of readLines(file, 0, undefined, regex ? undefined : { query, caseSensitive: options.caseSensitive, wildcard: !options.collectPositions && query.includes('*') })) {
    if (row.truncated && regex) truncatedLines++;
    const matched = regex ? regex.test(row.text) : row.matched;
    if (matched) {
      count++;
      if (positions && positionCount < 1000000) {
        if (positionCount * 2 === positions.length) {
          const grown = new Float64Array(Math.min(2000000, positions.length * 2));
          grown.set(positions); positions = grown;
        }
        positions[positionCount * 2] = line; positions[positionCount * 2 + 1] = row.offset;
        positionCount++;
      }
      if (matches.length < 10000) matches.push({ line, text: row.text.slice(0, 800), offset: row.offset });
    }
    line++; lastBytes = row.offset;
    if ((matches.length === 1 && sentMatches === 0 && !options.collectPositions) || Date.now() - lastProgress > 100) report(row.offset);
  }
  if (!options.collectPositions && sentMatches < matches.length) report(size);
  else if (lastBytes < size) report(size);
  return { matches, count, capped: count > matches.length, truncatedLines, ...(positions ? { positions: positions.slice(0, positionCount * 2) } : {}) };
}

export async function readFilteredPage(file, positions, start, count = 300) {
  const total = positions.length / 2;
  start = Math.max(0, Math.min(Math.floor(start), Math.max(0, total - 1)));
  count = Math.max(1, Math.min(500, Math.floor(count)));
  const handle = await open(file, 'r');
  const buffer = Buffer.alloc(48000), rows = [];
  try {
    for (let position = start; position < Math.min(total, start + count); position++) {
      const line = positions[position * 2], offset = positions[position * 2 + 1];
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const chunk = buffer.subarray(0, bytesRead), newline = chunk.indexOf(10);
      const text = (newline < 0 ? chunk : chunk.subarray(0, newline)).toString('utf8').replace(/\r$/, '');
      rows.push({ line, offset, position, text: text.slice(0, 12000), displayTruncated: text.length > 12000 || (newline < 0 && bytesRead === buffer.length) });
    }
    return rows;
  } finally { await handle.close(); }
}
