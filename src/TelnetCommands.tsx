import React, { useState } from 'react';
type Command = { id: string; name: string; text: string };
type Group = { id: string; name: string; commands: Command[] };
const key = 'telnet-command-groups';
export function TelnetCommands({ onSend }: { onSend(text: string): void }) {
  const [groups, setGroups] = useState<Group[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (Array.isArray(saved) && saved.every(g => typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.commands) && g.commands.every((c: Command) => typeof c.id === 'string' && typeof c.name === 'string' && typeof c.text === 'string'))) return saved;
    } catch {}
    return [{ id: 'default', name: '常用', commands: [{ id: 'info', name: '设备信息', text: 'dev-get-info' }] }];
  });
  const [active, setActive] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [groupName, setGroupName] = useState('');
  const group = groups.find(g => g.id === active) || groups[0];
  function save(next: Group[]) { localStorage.setItem(key, JSON.stringify(next)); setGroups(next); }
  function reset() { setEditing(null); setName(''); setText(''); }
  const commandForm = <form className="inline" onSubmit={e => { e.preventDefault(); if (!name.trim() || !text.trim()) return; const command = { id: editing || crypto.randomUUID(), name: name.trim(), text }; save(groups.map(g => g.id !== group.id ? g : { ...g, commands: editing ? g.commands.map(c => c.id === editing ? command : c) : [...g.commands, command] })); reset(); }}><input aria-label="命令名称" placeholder="按钮名称" value={name} onChange={e => setName(e.target.value)} required /><input aria-label="命令内容" placeholder="命令内容" value={text} onChange={e => setText(e.target.value)} required style={{ flex: 1 }} /><button>{editing ? '保存修改' : '新增命令'}</button>{editing && <button type="button" onClick={reset}>取消编辑</button>}</form>;
  return <div className="telnet-commands">
    <div className="command-button-bar" onContextMenu={e => { e.preventDefault(); reset(); setManage(true); }}>
      <select aria-label="按钮组" value={group?.id || ''} onChange={e => { if (e.target.value === '__add__') { setGroupName(''); setAddingGroup(true); } else { setActive(e.target.value); reset(); } }}><option value="" disabled>选择按钮组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__add__">＋ 新增分组…</option></select>
      <div className="command-buttons" onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); setManage(true); reset(); } }}>
        {group?.commands.map(command => <button key={command.id} title={command.text + '\n右键编辑按钮'} onClick={() => onSend(command.text)} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ id: command.id, x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 130) }); }}>{command.name}</button>)}
        {!group?.commands.length && <small>右键按钮栏配置命令</small>}
      </div>

    </div>
    {menu && <div className="command-menu-shade" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }}><div className="text-context-menu" role="menu" aria-label="命令按钮操作" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}><button role="menuitem" onClick={() => { const command = group?.commands.find(c => c.id === menu.id); if (command) { setEditing(command.id); setName(command.name); setText(command.text); setManage(true); } setMenu(null); }}>编辑按钮…</button><button role="menuitem" onClick={() => { reset(); setManage(true); setMenu(null); }}>新增按钮…</button><button role="menuitem" onClick={() => { save(groups.map(g => g.id === group?.id ? { ...g, commands: g.commands.filter(c => c.id !== menu.id) } : g)); reset(); setMenu(null); }}>删除按钮</button></div></div>}
    {manage && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => setManage(false)}><section className="directory-settings command-config-dialog" role="dialog" aria-label="按钮栏配置" onClick={e => e.stopPropagation()}><div className="panel-title"><strong>按钮栏配置 · {group?.name || '新建按钮组'}</strong><button aria-label="关闭按钮栏配置" onClick={() => setManage(false)}>×</button></div><div className="command-config-list">{group?.commands.map(c => <div className="command-config-item" key={c.id}><div className="inline"><strong>{c.name}</strong><code style={{ flex: 1 }}>{c.text}</code><button onClick={() => { setEditing(c.id); setName(c.name); setText(c.text); }}>编辑</button><button onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, commands: g.commands.filter(item => item.id !== c.id) } : g)); reset(); }}>删除</button></div>{editing === c.id && <div className="command-inline-editor">{commandForm}</div>}</div>)}</div>
      <form className="inline" onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setGroupName(''); reset(); }}><input aria-label="分组名称" placeholder="分组名称" value={groupName} onChange={e => setGroupName(e.target.value)} /><button>新增分组</button>{group && <><button type="button" disabled={!groupName.trim()} onClick={() => { save(groups.map(g => g.id === group.id ? { ...g, name: groupName.trim() } : g)); setGroupName(''); }}>重命名当前分组</button><button type="button" onClick={() => { save(groups.filter(g => g.id !== group.id)); setActive(''); reset(); }}>删除当前分组</button></>}</form>
      {group && !editing && commandForm}
    </section></div>}
    {addingGroup && <div className="settings-backdrop" style={{ zIndex: 130 }} onClick={() => setAddingGroup(false)}><form className="directory-settings" role="dialog" aria-label="新增按钮组" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (!groupName.trim()) return; const id = crypto.randomUUID(); save([...groups, { id, name: groupName.trim(), commands: [] }]); setActive(id); setAddingGroup(false); setGroupName(''); reset(); }}><div className="panel-title">新增按钮组</div><input autoFocus required aria-label="新分组名称" placeholder="分组名称" value={groupName} onChange={e => setGroupName(e.target.value)} /><div className="inline"><button>创建</button><button type="button" onClick={() => setAddingGroup(false)}>取消</button></div></form></div>}
  </div>;
}
