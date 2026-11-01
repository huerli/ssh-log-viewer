export const businessNames = ['告警', '事件', '全程记录', '防溜动作'];
export const hex = value => `0x${value.toString(16).padStart(2, '0')}`;
export const bytesHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
export function stateName(state) {
  if (state === 255) return '未存储';
  if (state === 254) return '待确认';
  if (state === 0) return '成功回复';
  if (state <= 250) return `错误回复 (${hex(state)})`;
  return `异常状态 (${hex(state)})`;
}
export function parseReliableDb(bytes, slotSize = 128, littleEndian = true) {
  if (![128, 256].includes(slotSize)) throw new Error('槽位大小必须为 128 或 256 B');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let empty = 0;
  for (let offset = 0; offset < bytes.length; offset += slotSize) {
    const raw = bytes.slice(offset, offset + slotSize);
    if (raw.length === slotSize && raw.every(byte => byte === 255)) { empty++; continue; }
    const record = { offset, raw, issues: [] };
    records.push(record);
    if (raw.length < slotSize) record.issues.push(`截短槽位：${raw.length}/${slotSize} B`);
    if (raw.length < 8) { record.issues.push('本地头不足 8 B'); continue; }
    record.dbSeq = view.getUint32(offset, littleEndian);
    record.state = raw[4];
    record.length = view.getUint16(offset + 6, littleEndian);
    if (record.state === 255) record.issues.push('未存储槽位含非 FF 数据');
    else if (record.state > 250 && record.state !== 254) record.issues.push('状态码超出协议范围');
    if (record.length < 16 || record.length > slotSize - 8 || record.length > raw.length - 8) {
      record.issues.push(`无效上报长度：${record.length} B`); continue;
    }
    record.type = raw[8];
    record.errcode = raw[9];
    record.seq = view.getUint32(offset + 12, littleEndian);
    record.serial = view.getUint32(offset + 16, littleEndian);
    record.time = view.getUint32(offset + 20, littleEndian);
    record.uniq = bytesHex(raw.slice(12, 24));
    record.body = raw.slice(24, 8 + record.length);
    if (record.type >= businessNames.length) record.issues.push(`未知业务类型：${record.type}`);
    if (record.type === 2 && slotSize !== 256) record.issues.push('全程记录预期使用 256 B 槽位');
    if (record.type !== 2 && record.type < 4 && slotSize !== 128) record.issues.push('该业务预期使用 128 B 槽位');
  }
  return { records, empty, slots: Math.ceil(bytes.length / slotSize) };
}

export function reliableDbSlotSize(name) {
  const base = name.split(/[\\/]/).pop().replace(/\.gz$/i, '');
  if (/^(?:wholercd|wholerecd)$/i.test(base)) return 256;
  return /^(?:alarm|event|oob_action)$/i.test(base) ? 128 : undefined;
}

export function formatReliableDbTime(seconds) {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
