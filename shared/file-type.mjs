// GET_FILETYPE(fileid) in file_handler.h; EN_FILETYPE in payload_def.h.
export const fileTypes = {
  0x00: ['FILETYPE_OLD_USE', '旧版文件'], 0x01: ['FILETYPE_SYS_EXE', '系统执行文件'],
  0x02: ['FILETYPE_JAR', 'JAR 程序'], 0x03: ['FILETYPE_MAP', '地图'],
  0x04: ['FILETYPE_CONFIG', '配置文件'], 0x05: ['FILETYPE_SCRIPT', '脚本'],
  0x60: ['FILETYPE_AUDIO', '语音'], 0x61: ['FILETYPE_PICTURE', '图片'],
  0x62: ['FILETYPE_FIRMWARE', '固件'], 0x63: ['FILETYPE_MONITOR', 'MONITOR'],
  0x64: ['FILETYPE_SAFE', 'SAFE 版本'], 0xff: ['FILETYPE_COMMON', '通用文件'],
};
export function fileTypeDescription(fileid) {
  if (fileid === null || fileid === undefined || !/^(?:\d+|0x[\da-f]+)$/i.test(String(fileid))) return '—';
  const value = BigInt(fileid);
  if (value < 0n || value > 0xffffffffn) return '—';
  const type = Number((value >> 16n) & 255n);
  const code = `0x${type.toString(16).padStart(2, '0')}`;
  const entry = fileTypes[type];
  return entry ? `${entry[1]} · ${entry[0]} (${code})` : `未知类型 (${code})`;
}
