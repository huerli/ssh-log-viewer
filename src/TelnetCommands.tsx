import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { parseCommandGroups, commandVariables, renderCommand } from '../shared/telnet-commands.mjs';
type Command = { id: string; name: string; text: string; color?: string };
type Group = { id: string; name: string; commands: Command[] };
const key = 'telnet-command-groups';
const mapHistoryKey = 'telnet-map-filename-history';
const isMapFilename = (label: string) => /map|地图/i.test(label) && /文件名/.test(label);
function buttonStyle(color?: string): React.CSSProperties | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  const channels = [1, 3, 5].map(i => {
    const value = parseInt(color.slice(i, i + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return { background: color, borderColor: color, color: luminance > 0.179 ? '#000000' : '#ffffff' };
}
export function TelnetCommands({ onSend, settingsSlot }: { onSend(text: string): void; settingsSlot: HTMLElement | null }) {
  const [groups, setGroups] = useState<Group[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(saved) && saved.every(g => typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.commands) && g.commands.every((c: Command) => typeof c.id === 'string' && typeof c.name === 'string' && typeof c.text === 'string'))) return saved;
    } catch {}
    return [{ id: 'default', name: '常用', commands: [{ id: 'info', name: '设备信息', text: 'dev-get-info' }] }];
  });
  const [mapHistory, setMapHistory] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(mapHistoryKey) || '[]'); return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, 20) : []; } catch { return []; }
  });
  const [pendingCommand, setPendingCommand] = useState<Command | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [variableError, setVariableError] = useState('');
  function sendCommand(command: Command) {
    if (!commandVariables(command.text).length) { onSend(command.text); return; }
    setVariableValues(Object.fromEntries(commandVariables(command.text).map(label => [label, isMapFilename(label) ? mapHistory[0] || '' : '']))); setVariableError(''); setPendingCommand(command);
  }
  const [active, setActive] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [color, setColor] = useState('');
  const [groupName, setGroupName] = useState('');
  const [transferMessage, setTransferMessage] = useState('');
  const importInput = React.useRef<HTMLInputElement>(null);
  const group = groups.find(g => g.id === active) || groups[0];
  function save(next: Group[]) { localStorage.setItem(key, JSON.stringify(next)); setGroups(next); }
  function reset() { setEditing(null); setName(''); setText(''); setColor(''); }
  function exportGroups(selected: Group[]) {
    const blob = new Blob([JSON.stringify({ format: 'ssh-log-viewer-telnet-commands', version: 1, groups: selected }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'telnet-commands-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    setTransferMessage('已导出 ' + selected.length + ' 个分组');
  }
  async function importGroups(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5MB');
      const imported = parseCommandGroups(await file.text(), () => crypto.randomUUID());
      save([...groups, ...imported]); setActive(imported[0].id); reset();
      setTransferMessage('已追加导入 ' + imported.length + ' 个分组，保留原有配置');
    } catch (error) { setTransferMessage('导入失败：' + (error instanceof Error ? error.message : String(error))); }
  }
  const commandForm = <form className="command-edit-form" onSubmit={e => { e.preventDefault(); if (!name.trim() || !text.trim()) return; const command = { id: editing || crypto.randomUUID(), name: name.trim(), text, ...(color ? { color } : {}) }; save(groups.map(g => g.id !== group.id ? g : { ...g, commands: editing ? g.commands.map(c => c.id === editing ? command : c) : [...g.commands, command] })); reset(); }}><label className="command-name-field">按钮名称<input aria-label="命令名称" placeholder="按钮名称" value={name} onChange={e => setName(e.target.value)} required /></label><label className="command-text-field">命令内容<textarea aria-label="命令内容" placeholder="命令内容" value={text} onChange={e => setText(e.target.value)} required rows={2} /></label><label className="command-color-picker">颜色<input type="color" aria-label="命令按钮颜色" value={color || '#2563eb'} onChange={e => setColor(e.target.value)} /></label><button type="button" disabled={!color} onClick={() => setColor('')}>默认颜色</button><button>{editing ? '保存修改' : '新增命令'}</button>{editing && <button type="button" onClick={reset}>取消编辑</button>}</form>;
  return <div className="telnet-commands">
    <div className="command-button-bar" onContextMenu={e => { e.preventDefault(); reset(); setManage(true); }}>

      <select aria-label="按钮组" value={group?.id || ''} onChange={e => { if (e.target.value === '__add__') { setGroupName(''); setAddingGroup(true); } else { setActive(e.target.value); reset(); } }}><option value="" disabled>选择按钮组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__add__">＋ 新增分组…</option></select>
      <div className="command-buttons" onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); setManage(true); reset(); } }}>
        {group?.commands.map(command => <button key={command.id} className={commandVariables(command.text).length ? 'variable-command-button' : undefined} style={{ ...buttonStyle(command.color), ...(commandVariables(command.text).length ? { borderColor: 'currentColor' } : {}) }} title={(commandVariables(command.text).length ? '可变命令 · 点击填写参数后发送\n' : '') + command.text + '\n右键编辑按钮'} onClick={() => sendCommand(command)} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ id: command.id, x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 130) }); }}>{commandVariables(command.text).length > 0 && <span className="variable-command-badge" aria-hidden="true"><b>{'{ }'}</b>参数</span>}<span>{command.name}</span>{commandVariables(command.text).length > 0 && <span className="variable-command-indicator" aria-hidden="true">…</span>}</button>)}
        {!group?.commands.length && <small>右键按钮栏配置命令</small>}
      </div>

    </div>
    {settingsSlot && createPortal(<button type="button" onClick={() => { reset(); setManage(true); }}>命令按钮 / 分组导入导出…</button>, settingsSlot)}
    {menu && <div className="command-menu-shade" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }}><div className="text-context-menu" role="menu" aria-label="命令按钮操作" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}><button role="menuitem" onClick={() => { const command = group?.commands.find(c => c.id === menu.id); if (command) { setEditing(command.id); setName(command.name); setText(command.text); setColor(command.color || ''); setManage(true); } setMenu(null); }}>编辑按钮…</button><button role="menuitem" onClick={() => { reset(); setManage(true); setMenu(null); }}>新增按钮…</button><button role="menuitem" onClick={() => { save(groups.map(g => g.id === group?.id ? { ...g, commands: g.commands.filter(c => c.id !== menu.id) } : g)); reset(); setMenu(null); }}>删除按钮</button></div></div>}
    {manage && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => setManage(false)}><section className="directory-settings command-config-dialog" role="dialog" aria-label="按钮栏配置" onClick={e => e.stopPropagation()}><div className="panel-title"><strong>按钮栏配置 · {group?.name || '新建按钮组'}</strong><button aria-label="关闭按钮栏配置" onClick={() => setManage(false)}>×</button></div><div className="command-config-list">{group?.commands.map(c => <div className="command-config-item" key={c.id}><div className="inline"><strong className="command-color-preview" style={buttonStyle(c.color)}>{commandVariables(c.text).length > 0 && <span className="variable-command-badge"><b>{'{ }'}</b>参数</span>}{c.name}</strong><code style={{ flex: 1 }}>{c.text}</code><button onClick={() => { setEditing(c.id); setName(c.name); setText(c.text); setColor(c.color || ''); }}>编辑</button><button onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, commands: g.commands.filter(item => item.id !== c.id) } : g)); reset(); }}>删除</button></div></div>)}</div>
      <form className="inline" onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setGroupName(''); reset(); }}><input aria-label="分组名称" placeholder="分组名称" value={groupName} onChange={e => setGroupName(e.target.value)} /><button>新增分组</button>{group && <><button type="button" disabled={!groupName.trim()} onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, name: groupName.trim() } : g)); setGroupName(''); }}>重命名当前分组</button><button type="button" onClick={() => { save(groups.filter(g => g.id !== group.id)); setActive(''); reset(); }}>删除当前分组</button></>}</form>
      {group && <div className="command-inline-editor"><strong>{editing ? '编辑命令按钮' : '新增命令按钮'}</strong>{commandForm}<small>可变命令使用 {'{{变量名}}'}，例如 {'find / -name "{{map文件名}}"'}。点击按钮时填写变量。</small></div>}
      <div className="inline"><button type="button" onClick={() => importInput.current?.click()}>导入分组与命令…</button><button type="button" disabled={!group} onClick={() => group && exportGroups([group])}>导出当前分组</button><button type="button" disabled={!groups.length} onClick={() => exportGroups(groups)}>导出全部分组</button></div>
      <small>JSON 文件包含分组及命令按钮；导入时追加分组，不覆盖已有配置。</small>
      <input ref={importInput} type="file" accept=".json,application/json" aria-label="导入命令配置文件" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importGroups(file); }} />
      {transferMessage && <p role="status">{transferMessage}</p>}
    </section></div>}
    {pendingCommand && <div className="settings-backdrop" style={{ zIndex: 140 }} onClick={() => setPendingCommand(null)}><form className="directory-settings variable-command-dialog" role="dialog" aria-label="填写命令变量" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); try { const command = renderCommand(pendingCommand.text, variableValues); const filenames = commandVariables(pendingCommand.text).filter(isMapFilename).map(label => variableValues[label]).filter(Boolean);
      if (filenames.length) { const next = [...new Set([...filenames, ...mapHistory])].slice(0, 20); localStorage.setItem(mapHistoryKey, JSON.stringify(next)); setMapHistory(next); }
      setPendingCommand(null); onSend(command); } catch (error) { setVariableError(error instanceof Error ? error.message : String(error)); } }}>
      <div className="panel-title">{pendingCommand.name}<button type="button" aria-label="关闭命令变量" onClick={() => setPendingCommand(null)}>×</button></div>
      {commandVariables(pendingCommand.text).map((variable, index) => <label key={variable}>{variable}<div className="variable-input-field"><input autoFocus={index === 0} required aria-label={variable} list={isMapFilename(variable) ? `map-history-${index}` : undefined} autoComplete="off" value={variableValues[variable] || ''} onChange={e => setVariableValues(previous => ({ ...previous, [variable]: e.target.value }))} />{isMapFilename(variable) && <button className="clear-variable-history" type="button" title="清除地图文件名历史记录" aria-label="清除地图文件名历史记录" disabled={!mapHistory.length} onClick={() => { localStorage.removeItem(mapHistoryKey); setMapHistory([]); }}>清除历史</button>}</div>{isMapFilename(variable) && <datalist id={`map-history-${index}`}>{mapHistory.map(value => <option key={value} value={value} />)}</datalist>}</label>)}
      <p className="hint">填写后确认发送，每次点击均可输入不同内容。</p><pre className="variable-command-preview">{pendingCommand.text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, label) => variableValues[label.trim()] || match)}</pre>
      {variableError && <p role="alert">{variableError}</p>}<div className="inline"><button type="button" onClick={() => setPendingCommand(null)}>取消</button><button className="primary">发送命令</button></div>
    </form></div>}
    {addingGroup && <div className="settings-backdrop" style={{ zIndex: 130 }} onClick={() => setAddingGroup(false)}><form className="directory-settings" role="dialog" aria-label="新增按钮组" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setAddingGroup(false); setGroupName(''); reset(); }}><div className="panel-title">新增按钮组</div><input autoFocus required aria-label="新分组名称" placeholder="分组名称" value={groupName} onChange={e => setGroupName(e.target.value)} /><div className="inline"><button>创建</button><button type="button" onClick={() => setAddingGroup(false)}>取消</button></div></form></div>}
  </div>;
}
