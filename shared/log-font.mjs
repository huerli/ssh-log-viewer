export const defaultLogFont = { family: 'Cascadia Code', size: 12 };

export function validateLogFont(value) {
  const family = typeof value?.family === 'string' ? value.family.trim() : '';
  if (!family || family.length > 100 || /[\u0000-\u001f\u007f]/.test(family)) throw new Error('请输入 1–100 字符的字体名称');
  if (!Number.isInteger(value?.size) || value.size < 10 || value.size > 32) throw new Error('字号须为 10–32 的整数');
  return { family, size: value.size };
}

export const logLineHeight = size => Math.max(25, Math.ceil(size * 1.8));
export const resultLineHeight = size => Math.max(28, Math.ceil(size * 1.8));
// Use CJK numeral glyphs for Unicode Roman numerals: Western monospace
// fonts can squeeze multi-stroke numerals such as Ⅲ and Ⅷ into one narrow cell.
export const logFontFamily = family => `"Log Roman Numerals", ${JSON.stringify(family)}, "DejaVu Sans Mono", "Noto Sans CJK SC", monospace`;
