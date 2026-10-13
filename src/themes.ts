export const themes = [
  { id: 'midnight', name: '午夜蓝' },
  { id: 'light', name: '晴空白' },
  { id: 'forest', name: '森林绿' },
  { id: 'violet', name: '暮光紫' },
  { id: 'graphite', name: '石墨灰' },
  { id: 'amber', name: '暖砂金' },
] as const;

export type ThemeId = typeof themes[number]['id'];
export function resolveTheme(value: unknown): ThemeId {
  return themes.find(theme => theme.id === value)?.id || 'midnight';
}
