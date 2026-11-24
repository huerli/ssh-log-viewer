import React, { useEffect, useRef, useState } from 'react';
import { startCommandStream } from '../shared/command-stream.mjs';
import { commandVariables, renderCommand } from '../shared/telnet-commands.mjs';

type Command = { id: string; name: string; text: string; color?: string };
type Group = { id: string; name: string; commands: Command[] };
type Step = Command & { interval: number; values: Record<string, string> };
type Flow = { id: string; name: string; steps: Step[]; interval: number; repeat: boolean };
const validInterval = (value: number) => Number.isFinite(value) && value >= 10 && value <= 86400000;
function readFlows(key: string): Flow[] {
  try {
    const saved: Flow[] = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(saved) ? saved.filter(flow => flow && typeof flow.id === 'string' && typeof flow.name === 'string' && validInterval(flow.interval) && typeof flow.repeat === 'boolean' && Array.isArray(flow.steps) && flow.steps.every(step => step && typeof step.id === 'string' && typeof step.name === 'string' && typeof step.text === 'string' && validInterval(step.interval) && step.values && typeof step.values === 'object' && Object.values(step.values).every(value => typeof value === 'string'))) : [];
  } catch { return []; }
}
const dragType = 'application/x-viewer-command-stream';
export function CommandStream({ enabled, send, groups, protocol }: { protocol: 'ssh' | 'telnet'; enabled: boolean; send(command: string): Promise<void>; groups: Group[] }) {
  const storageKey = protocol + '-command-streams';
  const [flows, setFlows] = useState(() => readFlows(storageKey));
  const [selectedFlow, setSelectedFlow] = useState('');
  const [flowName, setFlowName] = useState('');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [interval, setInterval] = useState(1000);
  const [steps, setSteps] = useState<Step[]>([]);
  const [groupId, setGroupId] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const sender = useRef(send);
  sender.current = send;
  function stop() { cancel.current?.(); cancel.current = null; setRunning(false); }
  useEffect(() => {
    if (!enabled && cancel.current) { stop(); setMessage('连接断开或会话切换，已停止'); }
  }, [enabled]);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => {
    const refresh = () => setFlows(readFlows(storageKey));
    window.addEventListener('command-streams-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('command-streams-changed', refresh); window.removeEventListener('storage', refresh); };
  }, [storageKey]);
  function persist(next: Flow[]) {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setFlows(next);
    window.dispatchEvent(new Event('command-streams-changed'));
  }
  function saveFlow(asNew: boolean) {
    try {
      const name = flowName.trim();
      if (!name || !steps.length) throw new Error('请输入执行流名称，并添加至少一条命令');
      if (!validInterval(interval) || steps.some(step => !validInterval(step.interval))) throw new Error('间隔须为 10–86400000 毫秒');
      const current = readFlows(storageKey);
      const id = !asNew && selectedFlow ? selectedFlow : crypto.randomUUID();
      if (current.some(flow => flow.id !== id && flow.name === name)) throw new Error('已有同名执行流，请使用其他名称');
      const flow = { id, name, steps, interval, repeat };
      persist(current.some(item => item.id === id) ? current.map(item => item.id === id ? flow : item) : [...current, flow]);
      setSelectedFlow(id); setFlowName(name); setMessage('已保存执行流：' + name);
    } catch (error) { setMessage('保存失败：' + String(error)); }
  }
  function loadFlow(id: string) {
    const current = readFlows(storageKey); setFlows(current);
    const flow = current.find(item => item.id === id);
    if (!flow) { setSelectedFlow(''); return; }
    setSelectedFlow(id); setFlowName(flow.name);
    setSteps(flow.steps.map(step => ({ ...step, id: crypto.randomUUID(), values: { ...step.values } })));
    setInterval(flow.interval); setRepeat(flow.repeat); setText(''); setMessage('已加载执行流：' + flow.name);
  }
  function deleteFlow() {
    try {
      persist(readFlows(storageKey).filter(flow => flow.id !== selectedFlow));
      setSelectedFlow(''); setMessage('已删除保存的执行流，当前队列保留');
    } catch (error) { setMessage('删除失败：' + String(error)); }
  }
  const group = groups.find(item => item.id === groupId) || groups[0];
  function makeStep(command: Command): Step { return { ...command, id: crypto.randomUUID(), interval, values: {} }; }
  function add(command: Command) { if (!running) setSteps(previous => [...previous, makeStep(command)]); }
  function update(id: string, change: Partial<Step>) { setSteps(previous => previous.map(step => step.id === id ? { ...step, ...change } : step)); }
  function drop(event: React.DragEvent, target?: string) {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    if (running) return;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(dragType));
      const after = target && event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2;
      setSteps(previous => {
        if (payload.step === target) return previous;
        const item = payload.step ? previous.find(step => step.id === payload.step) : groups.flatMap(g => g.commands).find(c => c.id === payload.command);
        if (!item) return previous;
        const next = payload.step ? previous.filter(step => step.id !== payload.step) : [...previous];
        const index = target ? next.findIndex(step => step.id === target) : next.length;
        next.splice(index + (after ? 1 : 0), 0, payload.step ? item as Step : makeStep(item));
        return next;
      });
    } catch { /* Ignore unrelated dragged content. */ }
  }
  return <div className="command-stream-controls">
    <button type="button" onClick={() => setOpen(true)}>流式执行{running ? ' · 运行中' : ''}…</button>
    {running && <button type="button" onClick={() => { stop(); setMessage('已停止'); }}>停止流式执行</button>}
    {open && <div className="settings-backdrop" style={{ zIndex: 130 }}>
      <form className="directory-settings command-stream-dialog" role="dialog" aria-label="流式执行命令" onClick={e => e.stopPropagation()} onSubmit={e => {
        e.preventDefault();
        if (!enabled || running) return;
        try {
          const commands = steps.map(step => ({ text: renderCommand(step.text, step.values), interval: step.interval }));
          setRunning(true); setMessage('正在发送…');
          cancel.current = startCommandStream({ commands, repeat,
            send: command => sender.current(command),
            onProgress: count => setMessage(`已发送 ${count} 条命令`),
            onDone: () => { cancel.current = null; setRunning(false); setMessage(`已完成，共发送 ${commands.length} 条命令`); },
            onError: error => { cancel.current = null; setRunning(false); setMessage('执行停止：' + String(error)); },
          });
        } catch (error) { setRunning(false); setMessage(String(error)); }
      }}>
        <div className="panel-title"><strong>流式执行命令</strong><button type="button" aria-label="关闭流式执行" onClick={() => setOpen(false)}>×</button></div>
        <div className="stream-saved-flows">
          <label>已保存执行流<select aria-label="已保存执行流" disabled={running} value={flows.some(flow => flow.id === selectedFlow) ? selectedFlow : ''} onChange={e => loadFlow(e.target.value)}><option value="">选择执行流…</option>{flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name} · {flow.steps.length} 步</option>)}</select></label>
          <label>执行流名称<input aria-label="执行流名称" disabled={running} value={flowName} onChange={e => setFlowName(e.target.value)} placeholder="例如：设备巡检" /></label>
          <div className="inline"><button type="button" disabled={running || !flowName.trim() || !steps.length} onClick={() => saveFlow(false)}>{selectedFlow ? '保存修改' : '保存执行流'}</button><button type="button" disabled={running || !selectedFlow || !flowName.trim() || !steps.length} onClick={() => saveFlow(true)}>另存为新流</button><button type="button" disabled={running || !selectedFlow} onClick={deleteFlow}>删除已保存流</button></div>
          <small>保存按钮顺序、命令内容、间隔、变量值和循环设置；SSH 与 Telnet 分开保存，重启后可选择加载。修改后需点击保存。</small>
        </div>
        <div className="stream-source"><div className="inline"><label>命令分组<select aria-label="流式命令分组" value={group?.id || ''} onChange={e => setGroupId(e.target.value)}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label>新增步骤默认间隔（毫秒）<input aria-label="命令发送间隔" type="number" min={10} max={86400000} required disabled={running} value={interval} onChange={e => setInterval(Number(e.target.value))} /></label></div>
          <p className="hint">点击命令按钮，或拖入下方执行队列；同一按钮可多次添加。</p>
          <div className="stream-command-palette">{group?.commands.map(command => <button key={command.id} type="button" disabled={running} draggable={!running} title={command.text} style={{ borderColor: command.color }} onClick={() => add(command)} onDragStart={e => { e.dataTransfer.setData(dragType, JSON.stringify({ command: command.id })); e.dataTransfer.effectAllowed = 'copy'; }}>{command.name}</button>)}</div>
        </div>
        <div className="stream-queue" aria-label="执行队列" onDragOver={e => { if (!running && e.dataTransfer.types.includes(dragType)) e.preventDefault(); }} onDrop={e => drop(e)}>
          {!steps.length && <p className="hint">将上方命令按钮拖到这里，按排列顺序执行</p>}
          {steps.map((step, index) => <div key={step.id} className={'stream-step' + (dropTarget === step.id ? ' stream-drop-target' : '')} onDragOver={e => { if (!running && e.dataTransfer.types.includes(dragType)) { e.preventDefault(); e.stopPropagation(); setDropTarget(step.id); } }} onDrop={e => drop(e, step.id)}>
            <div className="stream-step-heading"><button type="button" className="stream-drag-handle" draggable={!running} disabled={running} aria-label={`拖动步骤 ${index + 1}`} title="拖动调整顺序" onDragStart={e => { e.dataTransfer.setData(dragType, JSON.stringify({ step: step.id })); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropTarget(null)}>⠿ {index + 1} · {step.name}</button><button type="button" disabled={running} aria-label={`移除步骤 ${index + 1}`} onClick={() => setSteps(previous => previous.filter(item => item.id !== step.id))}>移除</button></div>
            <code>{step.text}</code>
            {commandVariables(step.text).map(variable => <label key={variable}>{variable}<input aria-label={`步骤 ${index + 1} ${variable}`} required disabled={running} value={step.values[variable] || ''} onChange={e => update(step.id, { values: { ...step.values, [variable]: e.target.value } })} /></label>)}
            <label className="stream-delay">{index === steps.length - 1 ? '本条发送后等待（循环时生效）' : '本条发送后等待，再发送下一条'}<input aria-label={`步骤 ${index + 1} 间隔`} type="number" min={10} max={86400000} required disabled={running} value={step.interval} onChange={e => update(step.id, { interval: Number(e.target.value) })} />毫秒</label>
          </div>)}
        </div>
        <details><summary>手动输入多条命令</summary><label>每行一条<textarea aria-label="流式命令列表" rows={3} disabled={running} value={text} onChange={e => setText(e.target.value)} /></label><button type="button" disabled={running || !text.trim()} onClick={() => { setSteps(previous => [...previous, ...text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).map(line => makeStep({ id: '', name: line, text: line }))]); setText(''); }}>添加到队列</button></details>
        <label className="stream-repeat"><input type="checkbox" disabled={running} checked={repeat} onChange={e => setRepeat(e.target.checked)} />循环执行命令队列</label>
        <p className="hint">首条立即发送，各步骤按各自间隔发送，不等待远端命令结束。输出实时显示；断开连接或切换会话会停止，关闭此窗口继续执行。</p>
        <p role="status">{message}</p>
        <div className="inline"><button className="primary" disabled={!enabled || running || !steps.length}>开始执行</button><button type="button" disabled={!running} onClick={() => { stop(); setMessage('已停止'); }}>停止执行</button><button type="button" disabled={running || !steps.length} onClick={() => setSteps([])}>清空队列</button></div>
      </form>
    </div>}
  </div>;
}
