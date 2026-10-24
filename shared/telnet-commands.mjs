// Imported IDs are regenerated to avoid collisions with existing local buttons.
export function parseCommandGroups(text, newId) {
  const data = JSON.parse(text);
  const groups = Array.isArray(data) ? data : data?.groups;
  if (!Array.isArray(groups) || !groups.length || groups.length > 200) throw new Error('文件须包含 1–200 个命令分组');
  return groups.map(group => {
    if (!group || typeof group.name !== 'string' || !group.name.trim() || !Array.isArray(group.commands) || group.commands.length > 1000) throw new Error('分组格式无效：需要名称和命令列表');
    return { id: newId(), name: group.name.trim(), commands: group.commands.map(command => {
      if (!command || typeof command.name !== 'string' || !command.name.trim() || typeof command.text !== 'string' || !command.text.trim()) throw new Error('命令格式无效：需要名称和命令内容');
      if (command.color != null && (typeof command.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(command.color))) throw new Error('按钮颜色须为 #RRGGBB 格式');
      return { id: newId(), name: command.name.trim(), text: command.text, ...(command.color ? { color: command.color } : {}) };
    }) };
  });
}

export function commandVariables(text) {
  return [...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1].trim()))];
}
export function renderCommand(text, values) {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, label) => {
    const value = values[label.trim()];
    if (typeof value !== 'string' || !value.trim()) throw new Error('请填写变量：' + label.trim());
    if (/[\r\n\x00]/.test(value)) throw new Error('变量不能包含换行或空字符');
    return value;
  });
}

// Sample uniformly from the available RGB colors, excluding saved/current colors.
export function randomCommandColor(usedColors = []) {
  const blocked = [...new Set(usedColors
    .filter(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    .map(color => parseInt(color.slice(1), 16)))].sort((a, b) => a - b);
  const available = 0x1000000 - blocked.length;
  if (!available) throw new Error('没有可用的按钮颜色');
  let value = Math.floor(Math.random() * available);
  // Map the random index onto the RGB range while skipping excluded colors.
  for (const excluded of blocked) {
    if (excluded > value) break;
    value++;
  }
  return '#' + value.toString(16).padStart(6, '0');
}
