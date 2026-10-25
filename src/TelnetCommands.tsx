import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseCommandGroups, commandVariables, renderCommand, randomCommandColor } from '../shared/telnet-commands.mjs';
type Command = { id: string; name: string; text: string; color?: string };
type Group = { id: string; name: string; commands: Command[] };
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
export function TelnetCommands({ onSend, settingsSlot, protocol = 'telnet', visible = true }: { onSend(text: string): void; settingsSlot: HTMLElement | null; protocol?: 'ssh' | 'telnet'; visible?: boolean }) {
  const key = protocol + '-command-groups';
  const mapHistoryKey = protocol + '-map-filename-history';
  const [groups, setGroups] = useState<Group[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(saved) && saved.every(g => typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.commands) && g.commands.every((c: Command) => typeof c.id === 'string' && typeof c.name === 'string' && typeof c.text === 'string'))) return saved;
    } catch {}
    const used: string[] = [];
    const commands = (protocol === 'ssh' ? [{ id: 'pwd', name: '当前目录', text: 'pwd' }, { id: 'ls', name: '列出文件', text: 'ls -lah' }] : [{ id: 'info', name: '设备信息', text: 'dev-get-info' }]).map(command => {
      const color = randomCommandColor(used); used.push(color); return { ...command, color };
    });
    const defaults = [{ id: 'default', name: '常用', commands }];
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(defaults));
    return defaults;
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
  const [menu, setMenu] = useState<{ id?: string; x: number; y: number } | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [manage, setManage] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [singleEdit, setSingleEdit] = useState(false);
  const [adjustGroups, setAdjustGroups] = useState(false);
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [color, setColor] = useState(() => randomCommandColor());
  const [groupName, setGroupName] = useState('');
  const [transferMessage, setTransferMessage] = useState('');
  const draggedCommand = React.useRef<{ groupId: string; commandId: string } | null>(null);
  const suppressCommandClickUntil = React.useRef(0);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  function endCommandDrag() {
    draggedCommand.current = null;
    setDropTarget(null);
    suppressCommandClickUntil.current = Date.now() + 250;
  }
  function dropCommand(event: React.DragEvent<HTMLButtonElement>, targetId: string) {
    const source = draggedCommand.current;
    if (!source || source.groupId !== group?.id) return;
    event.preventDefault();
    event.stopPropagation();
    if (source.commandId !== targetId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const after = event.clientX >= bounds.left + bounds.width / 2;
      save(groups.map(item => {
        if (item.id !== source.groupId) return item;
        const moved = item.commands.find(command => command.id === source.commandId);
        if (!moved) return item;
        const commands = item.commands.filter(command => command.id !== source.commandId);
        const targetIndex = commands.findIndex(command => command.id === targetId);
        if (targetIndex < 0) return item;
        commands.splice(targetIndex + (after ? 1 : 0), 0, moved);
        return { ...item, commands };
      }));
    }
    endCommandDrag();
  }
  const importInput = React.useRef<HTMLInputElement>(null);
  const group = groups.find(g => g.id === active) || groups[0];
  function save(next: Group[]) { localStorage.setItem(key, JSON.stringify(next)); setGroups(next); }
  function reset(exclude: string[] = []) { setEditing(null); setName(''); setText(''); setColor(randomCommandColor([...groups.flatMap(item => item.commands.map(command => command.color || '')), ...exclude])); }
  function addButton() {
    if (!groups.length) { const id = crypto.randomUUID(); save([{ id, name: '常用', commands: [] }]); setActive(id); }
    reset(); setMenu(null); setManage(false); setQuickAdd(true);
  }
  function openGroups() {
    setGroupDrafts(Object.fromEntries(groups.map(item => [item.id, item.name])));
    setGroupName(''); setMenu(null); setAdjustGroups(true);
  }
  function moveGroup(id: string, direction: number) {
    const index = groups.findIndex(item => item.id === id), target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups]; [next[index], next[target]] = [next[target], next[index]];
    setActive(group?.id || ''); save(next);
  }
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [menu]);
  function exportGroups(selected: Group[]) {
    const blob = new Blob([JSON.stringify({ format: 'ssh-log-viewer-' + protocol + '-commands', version: 1, groups: selected }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = protocol + '-commands-' + new Date().toISOString().slice(0, 10) + '.json';
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
  const commandForm = <form id={quickAdd || singleEdit ? protocol + '-command-form' : undefined} className="command-edit-form" onSubmit={e => { e.preventDefault(); if (!group || !name.trim() || !text.trim()) return; const command = { id: editing || crypto.randomUUID(), name: name.trim(), text, ...(color ? { color } : {}) }; save(groups.map(g => g.id !== group.id ? g : { ...g, commands: editing ? g.commands.map(c => c.id === editing ? command : c) : [...g.commands, command] })); reset([color]); setQuickAdd(false); setSingleEdit(false); }}><label className="command-name-field">按钮名称<input aria-label="命令名称" placeholder="按钮名称" value={name} onChange={e => setName(e.target.value)} required /></label><label className="command-text-field">命令内容<textarea aria-label="命令内容" placeholder="命令内容" value={text} onChange={e => setText(e.target.value)} required rows={2} /></label><label className="command-color-picker">颜色<input type="color" aria-label="命令按钮颜色" value={color || '#2563eb'} onChange={e => setColor(e.target.value)} /></label><div className="command-edit-actions"><button type="button" onClick={() => setColor(randomCommandColor([...groups.flatMap(item => item.commands.map(command => command.color || '')), color]))}>换个颜色</button><button type="button" disabled={!color} onClick={() => setColor('')}>默认颜色</button>{!quickAdd && !singleEdit && <button className="primary">{editing ? '保存修改' : '新增命令'}</button>}{editing && !singleEdit && <button type="button" onClick={() => { reset(); setSingleEdit(false); }}>取消编辑</button>}</div></form>;
  return <div className="telnet-commands" style={visible ? undefined : { display: 'contents' }}>
    <div className="command-button-bar" style={visible ? undefined : { display: 'none' }} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - 200)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 165)) }); }}>

      <select aria-label="按钮组" value={group?.id || ''} onChange={e => { if (e.target.value === '__add__') { setGroupName(''); setAddingGroup(true); } else { setActive(e.target.value); reset(); } }}><option value="" disabled>选择按钮组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__add__">＋ 新增分组…</option></select>
      <div className="command-buttons">
        {group?.commands.map(command => <button key={command.id} draggable
          data-drop-position={dropTarget?.id === command.id ? (dropTarget.after ? 'after' : 'before') : undefined}
          onDragStart={event => {
            draggedCommand.current = { groupId: group.id, commandId: command.id };
            suppressCommandClickUntil.current = Number.POSITIVE_INFINITY;
            setMenu(null);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', command.id);
          }}
          onDragOver={event => {
            if (draggedCommand.current?.groupId !== group.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const bounds = event.currentTarget.getBoundingClientRect();
            setDropTarget(command.id === draggedCommand.current.commandId ? null : { id: command.id, after: event.clientX >= bounds.left + bounds.width / 2 });
            const bar = event.currentTarget.parentElement;
            if (bar) {
              const viewport = bar.getBoundingClientRect();
              if (event.clientX < viewport.left + 32) bar.scrollLeft -= 20;
              else if (event.clientX > viewport.right - 32) bar.scrollLeft += 20;
            }
          }}
          onDragLeave={() => setDropTarget(target => target?.id === command.id ? null : target)}
          onDrop={event => dropCommand(event, command.id)} onDragEnd={endCommandDrag}
          className={commandVariables(command.text).length ? 'variable-command-button' : undefined} style={{ ...buttonStyle(command.color), ...(commandVariables(command.text).length ? { borderColor: 'currentColor' } : {}) }} title={(commandVariables(command.text).length ? '可变命令 · 点击填写参数后发送\n' : '') + command.text + '\n拖动调整顺序 · 右键编辑按钮'} onClick={() => { if (Date.now() >= suppressCommandClickUntil.current) sendCommand(command); }} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ id: command.id, x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 130) }); }}>{commandVariables(command.text).length > 0 && <span className="variable-command-badge" aria-hidden="true"><b>{'{ }'}</b>参数</span>}<span>{command.name}</span>{commandVariables(command.text).length > 0 && <span className="variable-command-indicator" aria-hidden="true">…</span>}</button>)}
        {!group?.commands.length && <small>右键按钮栏新增按钮或调整分组</small>}
      </div>

    </div>
    {settingsSlot && createPortal(<button type="button" onClick={() => { reset(); setManage(true); }}>命令按钮 / 分组导入导出…</button>, settingsSlot)}
    {menu && <div className="command-menu-shade" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }}><div className="text-context-menu" role="menu" aria-label={menu.id ? "命令按钮操作" : "按钮栏操作"} style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>{menu.id && <button role="menuitem" onClick={() => { const command = group?.commands.find(c => c.id === menu.id); if (command) { setEditing(command.id); setName(command.name); setText(command.text); setColor(command.color || ''); setManage(false); setQuickAdd(false); setSingleEdit(true); } setMenu(null); }}>编辑按钮…</button>}<button role="menuitem" onClick={addButton}>新增按钮…</button>{!menu.id && <><button role="menuitem" onClick={() => { setMenu(null); importInput.current?.click(); }}>导入配置…</button><button role="menuitem" onClick={openGroups}>调整分组…</button></>}{menu.id && <button role="menuitem" onClick={() => { save(groups.map(g => g.id === group?.id ? { ...g, commands: g.commands.filter(c => c.id !== menu.id) } : g)); reset(); setMenu(null); }}>删除按钮</button>}</div></div>}
    {(quickAdd || singleEdit) && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => { setQuickAdd(false); setSingleEdit(false); reset(); }}>
      <section className="directory-settings command-config-dialog single-command-dialog" role="dialog" aria-label={singleEdit ? '编辑命令按钮' : '新增命令按钮'} onClick={event => event.stopPropagation()}>
        <div className="panel-title"><strong>{singleEdit ? '编辑命令按钮' : '新增命令按钮'}</strong><button aria-label={singleEdit ? '关闭按钮编辑' : '关闭新增按钮'} onClick={() => { setQuickAdd(false); setSingleEdit(false); reset(); }}>×</button></div>
        <label>所属分组<select aria-label="按钮所属分组" disabled={singleEdit} value={group?.id || ''} onChange={event => setActive(event.target.value)}>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {commandForm}
        <small>可换个颜色或手动选择。可变命令使用 {'{{变量名}}'}，点击按钮时填写变量。</small>
        <footer className="quick-command-actions"><button type="button" onClick={() => { setQuickAdd(false); setSingleEdit(false); reset(); }}>取消</button><button type="submit" className="primary" form={protocol + '-command-form'}>{singleEdit ? '保存修改' : '确认'}</button></footer>
      </section>
    </div>}
    {adjustGroups && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => setAdjustGroups(false)}>
      <section className="directory-settings command-groups-dialog" role="dialog" aria-label="调整分组" onClick={event => event.stopPropagation()}>
        <header className="panel-title command-groups-heading"><div><strong>调整分组</strong><small>管理分组名称、显示顺序与按钮配置导出</small></div><button aria-label="关闭分组调整" onClick={() => setAdjustGroups(false)}>×</button></header>
        <div className="command-groups-body">
          <div className="command-group-list">{groups.map((item, index) => <div className="command-group-row" key={item.id}>
            <label><span>{item.id === group?.id ? '当前分组' : '分组'} · {item.commands.length} 个按钮</span><input aria-label={'分组名称：' + item.name} value={groupDrafts[item.id] ?? item.name} onChange={event => setGroupDrafts({ ...groupDrafts, [item.id]: event.target.value })} /></label>
            <button className="primary" disabled={!(groupDrafts[item.id] || '').trim() || groupDrafts[item.id].trim() === item.name} onClick={() => save(groups.map(value => value.id === item.id ? { ...value, name: groupDrafts[item.id].trim() } : value))}>保存名称</button>
            <button aria-label={'上移分组' + item.name} title="上移分组" disabled={index === 0} onClick={() => moveGroup(item.id, -1)}>↑</button>
            <button aria-label={'下移分组' + item.name} title="下移分组" disabled={index === groups.length - 1} onClick={() => moveGroup(item.id, 1)}>↓</button>
            <button aria-label={'导出分组' + item.name} title="导出此分组的按钮配置（JSON）" onClick={() => exportGroups([item])}>导出</button>
            <button aria-label={'删除分组' + item.name} title="删除分组及其中的按钮" onClick={() => { const next = groups.filter(value => value.id !== item.id); save(next); if (item.id === group?.id) setActive(next[0]?.id || ''); }}>删除</button>
          </div>)}{!groups.length && <p className="command-groups-empty">暂无分组，可在下方新增。</p>}</div>
          <div className="command-group-create"><label htmlFor={protocol + '-new-group-name'}>新增分组</label><form onSubmit={event => { event.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setGroupDrafts({ ...groupDrafts, [id]: groupName.trim() }); setActive(id); setGroupName(''); }}><input id={protocol + '-new-group-name'} aria-label="新分组名称" placeholder="输入新分组名称" value={groupName} onChange={event => setGroupName(event.target.value)} /><button className="primary" disabled={!groupName.trim()}>新增分组</button></form></div>
        </div>
        <footer className="command-groups-footer"><p>用 ↑ ↓ 调整分组顺序，修改名称后点击“保存名称”。<br />点击“导出”可下载对应分组的按钮配置（JSON）。<br />删除分组会同时删除其中的按钮。</p><div className="command-groups-actions"><span>操作后自动保存</span><button className="primary" onClick={() => setAdjustGroups(false)}>完成</button></div></footer>
      </section>
    </div>}
    {manage && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => setManage(false)}><section className="directory-settings command-config-dialog" role="dialog" aria-label="按钮栏配置" onClick={e => e.stopPropagation()}><div className="panel-title"><strong>按钮栏配置 · {group?.name || '新建按钮组'}</strong><button aria-label="关闭按钮栏配置" onClick={() => setManage(false)}>×</button></div><div className="command-config-list">{group?.commands.map(c => <div className="command-config-item" key={c.id}><div className="inline"><strong className="command-color-preview" style={buttonStyle(c.color)}>{commandVariables(c.text).length > 0 && <span className="variable-command-badge"><b>{'{ }'}</b>参数</span>}{c.name}</strong><code style={{ flex: 1 }}>{c.text}</code><button onClick={() => { setEditing(c.id); setName(c.name); setText(c.text); setColor(c.color || ''); }}>编辑</button><button onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, commands: g.commands.filter(item => item.id !== c.id) } : g)); reset(); }}>删除</button></div></div>)}</div>
      <form className="inline" onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setGroupName(''); reset(); }}><input aria-label="分组名称" placeholder="分组名称" value={groupName} onChange={e => setGroupName(e.target.value)} /><button className="primary">新增分组</button>{group && <><button type="button" className="primary" disabled={!groupName.trim()} onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, name: groupName.trim() } : g)); setGroupName(''); }}>重命名当前分组</button><button type="button" onClick={() => { save(groups.filter(g => g.id !== group.id)); setActive(''); reset(); }}>删除当前分组</button></>}</form>
      {group && <div className="command-inline-editor"><strong>{editing ? '编辑命令按钮' : '新增命令按钮'}</strong>{commandForm}<small>可变命令使用 {'{{变量名}}'}，例如 {'find / -name "{{map文件名}}"'}。点击按钮时填写变量。</small></div>}
      <div className="inline"><button type="button" onClick={() => importInput.current?.click()}>导入分组与命令…</button><button type="button" disabled={!group} onClick={() => group && exportGroups([group])}>导出当前分组</button><button type="button" disabled={!groups.length} onClick={() => exportGroups(groups)}>导出全部分组</button></div>
      <small>JSON 文件包含分组及命令按钮；导入时追加分组，不覆盖已有配置。</small>
      {transferMessage && <p role="status">{transferMessage}</p>}
    </section></div>}
    <input ref={importInput} type="file" accept=".json,application/json" aria-label="导入命令配置文件" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importGroups(file); }} />
    {pendingCommand && <div className="settings-backdrop" style={{ zIndex: 140 }} onClick={() => setPendingCommand(null)}><form className="directory-settings variable-command-dialog" role="dialog" aria-label="填写命令变量" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); try { const command = renderCommand(pendingCommand.text, variableValues); const filenames = commandVariables(pendingCommand.text).filter(isMapFilename).map(label => variableValues[label]).filter(Boolean);
      if (filenames.length) { const next = [...new Set([...filenames, ...mapHistory])].slice(0, 20); localStorage.setItem(mapHistoryKey, JSON.stringify(next)); setMapHistory(next); }
      setPendingCommand(null); onSend(command); } catch (error) { setVariableError(error instanceof Error ? error.message : String(error)); } }}>
      <div className="panel-title">{pendingCommand.name}<button type="button" aria-label="关闭命令变量" onClick={() => setPendingCommand(null)}>×</button></div>
      {commandVariables(pendingCommand.text).map((variable, index) => <label key={variable}>{variable}<div className="variable-input-field"><input autoFocus={index === 0} required aria-label={variable} list={isMapFilename(variable) ? `map-history-${index}` : undefined} autoComplete="off" value={variableValues[variable] || ''} onChange={e => setVariableValues(previous => ({ ...previous, [variable]: e.target.value }))} />{isMapFilename(variable) && <button className="clear-variable-history" type="button" title="清除地图文件名历史记录" aria-label="清除地图文件名历史记录" disabled={!mapHistory.length} onClick={() => { localStorage.removeItem(mapHistoryKey); setMapHistory([]); }}>清除历史</button>}</div>{isMapFilename(variable) && <datalist id={`map-history-${index}`}>{mapHistory.map(value => <option key={value} value={value} />)}</datalist>}</label>)}
      <p className="hint">填写后确认发送，每次点击均可输入不同内容。</p><pre className="variable-command-preview">{pendingCommand.text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, label) => variableValues[label.trim()] || match)}</pre>
      {variableError && <p role="alert">{variableError}</p>}<div className="inline"><button type="button" onClick={() => setPendingCommand(null)}>取消</button><button className="primary">发送命令</button></div>
    </form></div>}
    {addingGroup && <div className="settings-backdrop" style={{ zIndex: 130 }} onClick={() => setAddingGroup(false)}>
      <form className="directory-settings new-command-group-dialog" role="dialog" aria-label="新增按钮组" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setAddingGroup(false); setGroupName(''); reset(); }}>
        <header className="panel-title"><strong>新增分组</strong><button type="button" aria-label="关闭新增分组" onClick={() => setAddingGroup(false)}>×</button></header>
        <label>分组名称<input autoFocus required aria-label="新分组名称" placeholder="例如：设备调试" value={groupName} onChange={e => setGroupName(e.target.value)} /></label>
        <p>创建后将自动切换到新分组。</p>
        <footer className="quick-command-actions"><button type="button" onClick={() => setAddingGroup(false)}>取消</button><button type="submit" className="primary" disabled={!groupName.trim()}>确认</button></footer>
      </form>
    </div>}

  </div>;
}
