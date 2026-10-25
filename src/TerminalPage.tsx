import type { LogFont } from './types';
import { logFontFamily } from '../shared/log-font.mjs';
import { createPortal } from 'react-dom';
import { TelnetCommands } from './TelnetCommands';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import React, { useEffect, useRef, useState } from 'react';
export function TerminalPage({ protocol, active, onShowOutput, font, settingsOpen, sshConnection = '', outputVisible }: { protocol: 'ssh' | 'telnet'; active: boolean; settingsOpen: boolean; onShowOutput(): void | Promise<void>; font: LogFont; sshConnection?: string; outputVisible: boolean }) {
  const isSsh = protocol === 'ssh';
  const label = isSsh ? 'SSH' : 'Telnet';
  const activeRef = useRef(active);
  activeRef.current = active;
  const outputVisibleRef = useRef(outputVisible);
  outputVisibleRef.current = outputVisible;
  const recording = isSsh ? window.viewer.sshTerminalRecording : window.viewer.telnetRecording;
  const write = isSsh ? window.viewer.sshTerminalWrite : window.viewer.telnetWrite;
  const disconnectedMessage = isSsh ? 'SSH 终端未连接，请使用上方连接管理连接 SSH' : '设备未连接，请先点击连接；Web 登录成功不代表设备终端已连接';
  const [displaySlot, setDisplaySlot] = useState<HTMLElement | null>(null);
  const [settingsSlot, setSettingsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSettingsSlot(settingsOpen ? document.getElementById(protocol + '-settings-slot') : null); }, [settingsOpen]);
  const [connectionSlot, setConnectionSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setConnectionSlot(document.getElementById('telnet-connection-slot')); setDisplaySlot(document.getElementById(protocol + '-display-slot')); }, []);
  const showOutputRef = useRef(onShowOutput);
  showOutputRef.current = onShowOutput;
  const [webMode, setWebMode] = useState(false);
  const webModeRef = useRef(webMode);
  webModeRef.current = webMode;
  const webLineRef = useRef('');
  const [webNodes, setWebNodes] = useState<{ id: string; name: string; address: string; username: string; rememberPassword?: boolean }[]>(() => {
    try { const value = JSON.parse(localStorage.getItem('web-telnet-nodes') || '[]'); return Array.isArray(value) ? value.filter(node => typeof node.id === 'string' && typeof node.name === 'string' && typeof node.address === 'string' && typeof node.username === 'string') : []; } catch { return []; }
  });
  const [webNodeId, setWebNodeId] = useState('');
  const [webNodeName, setWebNodeName] = useState('');
  const [connectionSettings, setConnectionSettings] = useState(false);
  function saveWebNodes(nodes: typeof webNodes) { localStorage.setItem('web-telnet-nodes', JSON.stringify(nodes)); setWebNodes(nodes); }
  function selectWebNode(id: string) {
    const node = webNodes.find(item => item.id === id);
    setWebNodeId(id); setWebNodeName(node?.name || '');
    setDevice(''); setDeviceName(''); setDeviceQuery('');
    setWebAddress(node?.address || ''); setWebUser(node?.username || '');
    setWebPassword(''); setRememberPassword(node?.rememberPassword ?? true); setTelnetToken(''); setWebLoginStatus('');
  }
  const [webAddress, setWebAddress] = useState('');
  const [webUser, setWebUser] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [webPassword, setWebPassword] = useState('');
  const [deviceQuery, setDeviceQuery] = useState('');
  const [deviceSearchError, setDeviceSearchError] = useState('');
  const deviceSearchVersion = useRef(0);
  const [deviceMatches, setDeviceMatches] = useState<{ number: string; name: string; online: boolean }[]>([]);
  const [deviceSearching, setDeviceSearching] = useState(false);
  const [deviceSearchOpen, setDeviceSearchOpen] = useState(false);
  const [device, setDevice] = useState('');
  const [deviceName, setDeviceName] = useState('');
  useEffect(() => {
    const version = ++deviceSearchVersion.current;
    setDeviceMatches([]); setDeviceSearchError(''); setDeviceSearchOpen(false); setDeviceSearching(false);
    if (isSsh || !webMode || !deviceQuery.trim() || !webAddress.trim()) return;
    let pending = true;
    const timer = setTimeout(async () => {
      setDeviceSearching(true); setDeviceSearchOpen(true);
      try {
        await window.viewer.webTelnetLogin(webAddress, webUser, webPassword);
        if (!pending || deviceSearchVersion.current !== version) return;
        setWebPassword('');
        const matches = await window.viewer.webTelnetSearchDevices(webAddress, deviceQuery);
        if (pending && deviceSearchVersion.current === version) setDeviceMatches(matches);
      } catch (error) {
        if (pending && deviceSearchVersion.current === version) setDeviceSearchError(String(error));
      } finally {
        if (pending && deviceSearchVersion.current === version) setDeviceSearching(false);
      }
    }, 350);
    return () => { pending = false; clearTimeout(timer); };
  }, [deviceQuery, webAddress, webUser, webMode, isSsh]);
  const [telnetToken, setTelnetToken] = useState('');
  const [webLoginStatus, setWebLoginStatus] = useState('');
  const [directNodes, setDirectNodes] = useState<{ id: string; name: string; host: string; port: number }[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('direct-telnet-nodes') || '[]');
      return Array.isArray(saved) ? saved.filter(node => typeof node.id === 'string' && typeof node.name === 'string' && typeof node.host === 'string' && node.host.trim() && Number.isInteger(node.port) && node.port >= 1 && node.port <= 65535) : [];
    } catch { return []; }
  });
  const [directNodeId, setDirectNodeId] = useState(directNodes[0]?.id || '');
  const [directNodeName, setDirectNodeName] = useState(directNodes[0]?.name || '');
  const [host, setHost] = useState(directNodes[0]?.host || '192.168.20.7');
  const [port, setPort] = useState(directNodes[0]?.port || 23);
  function saveDirectNodes(nodes: typeof directNodes) {
    localStorage.setItem('direct-telnet-nodes', JSON.stringify(nodes)); setDirectNodes(nodes);
  }
  function selectDirectNode(id: string) {
    const node = directNodes.find(item => item.id === id);
    setDirectNodeId(node?.id || ''); setDirectNodeName(node?.name || '');
    setHost(node?.host || ''); setPort(node?.port || 23);
  }
  const connectedRef = useRef(false);
  const connectionVersion = useRef(0);
  const sshOpening = useRef(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('未连接');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState(!isSsh);
  const echoRef = useRef(!isSsh);
  const [logMode, setLogMode] = useState('printable');
  useEffect(() => { void window.viewer.settings().then(s => setLogMode((isSsh ? s.sshLogMode : s.telnetLogMode) || 'printable')).catch(() => {}); }, []);
  const [append, setAppend] = useState(true);
  const [logFile, setLogFile] = useState('');
  const [logApplied, setLogApplied] = useState('');
  const [logSettings, setLogSettings] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const searchingRef = useRef(false);
  const searchAddon = useRef<SearchAddon | null>(null);
  function find(previous = false) {
    searchingRef.current = Boolean(searchText);
    if (!searchText) { searchAddon.current?.clearDecorations(); setSearchMessage(''); return; }
    if (regex) { try { new RegExp(searchText); } catch { setSearchMessage('正则表达式无效'); return; } }
    const options = { caseSensitive, regex, decorations: { matchBackground: '#8a6500', matchOverviewRuler: '#eab308', activeMatchBackground: '#2563eb', activeMatchColorOverviewRuler: '#60a5fa', activeMatchBorder: '#ffffff' } };
    const found = previous ? searchAddon.current?.findPrevious(searchText, options) : searchAddon.current?.findNext(searchText, options);
    if (!found) setSearchMessage('没有匹配内容');
  }
  useEffect(() => {
    searchAddon.current?.clearDecorations();
    if (searchText) find();
  }, [caseSensitive, regex]);
  const fitRef = useRef<FitAddon | null>(null);
  const fontRef = useRef(font);
  fontRef.current = font;
  const viewport = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!displaySlot || !viewport.current) return;
    const term = new Terminal({ allowProposedApi: true, convertEol: true, cursorBlink: true, fontSize: fontRef.current.size, fontFamily: logFontFamily(fontRef.current.family), scrollback: 10000, theme: { background: '#111827', foreground: '#e5e7eb' } });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchAddon.current = search;
    const searchResult = search.onDidChangeResults(result => setSearchMessage(result.resultCount ? (result.resultIndex + 1) + ' / ' + result.resultCount : '没有匹配内容'));
    term.open(viewport.current!);
    fit.fit();
    terminal.current = term;
    const syncTheme = () => {
      const css = getComputedStyle(document.documentElement);
      term.options.theme = { background: css.getPropertyValue('--log').trim(), foreground: css.getPropertyValue('--text').trim(), cursor: css.getPropertyValue('--text').trim(), selectionBackground: '#3b82f680' };
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    term.attachCustomKeyEventHandler(e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { if (e.type === 'keydown') { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); } return false; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) return false;
      return true;
    });
    const input = term.onData(text => {
      if (!activeRef.current) return;
      if (!connectedRef.current) { setStatus(disconnectedMessage); return; }
      if (isSsh) { void write(text).catch(error => setStatus(String(error))); return; }
      if (webModeRef.current) {
        if (text === '\x03') {
          webLineRef.current = ''; term.write('^C\r\n');
          void window.viewer.telnetWrite(text).catch(error => setStatus(String(error)));
          return;
        }
        for (const char of text.replace(/\r\n/g, '\r')) {
          if (char === '\r' || char === '\n') {
            const command = webLineRef.current; webLineRef.current = '';
            term.write('\r\n');
            if (command.trim()) void window.viewer.telnetWrite(command + '\n').catch(error => setStatus(String(error)));
          } else if (char === '\x7f' || char === '\b') {
            if (webLineRef.current) { webLineRef.current = [...webLineRef.current].slice(0, -1).join(''); if (echoRef.current) term.write('\b \b'); }
          } else if (char >= ' ' && !text.startsWith('\x1b')) {
            webLineRef.current += char;
            if (echoRef.current) term.write(char);
          }
        }
        return;
      }
      if (echoRef.current) {
        if (text === '\r') term.write('\r\n');
        else if (text === '\x7f' || text === '\b') term.write('\b \b');
        else if (text === '\x03') term.write('^C\r\n');
        else if (!text.startsWith('\x1b')) term.write(text);
      }
      void window.viewer.telnetWrite(text).catch(error => setStatus(String(error))); });
    const unsubscribe = window.viewer.onEvent(e => {
      if (e.type === (isSsh ? 'ssh-terminal-data' : 'telnet-data')) {
        const position = term.buffer.active.viewportY;
        term.write(e.message || '', () => { if (searchingRef.current) term.scrollToLine(position); });
      }
      if (isSsh && e.type === 'ssh-terminal-log-error') setLogApplied(e.message || e.error || '日志写入失败');
      if (e.type === (isSsh ? 'ssh-terminal-status' : 'telnet-status')) { connectedRef.current = e.message === '已连接' && (!isSsh || activeRef.current); setConnected(connectedRef.current); setStatus(e.message || ''); if (e.file) setLogFile(e.file); if (e.message === '已连接' && activeRef.current && outputVisibleRef.current) { requestAnimationFrame(() => { fit.fit(); term.focus(); }); } }
    });
    const terminalResize = term.onResize(({ cols, rows }) => { if (isSsh && connectedRef.current) void window.viewer.sshTerminalResize(cols, rows).catch(error => setStatus(String(error))); });
    const resize = new ResizeObserver(() => { if (viewport.current?.clientWidth) fit.fit(); });
    resize.observe(viewport.current!);
    return () => { resize.disconnect(); terminalResize.dispose(); themeObserver.disconnect(); searchResult.dispose(); searchAddon.current = null; unsubscribe(); input.dispose(); term.dispose(); terminal.current = null; };
  }, [displaySlot]);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.fontSize = font.size;
    term.options.fontFamily = logFontFamily(font.family);
    let active = true;
    document.fonts.ready.then(() => { if (active) fitRef.current?.fit(); });
    return () => { active = false; };
  }, [font.family, font.size, displaySlot]);
  useEffect(() => {
    if (active) requestAnimationFrame(() => { fitRef.current?.fit(); });
    else if (isSsh) { connectionVersion.current++; sshOpening.current = false; setBusy(false); connectedRef.current = false; setConnected(false); setStatus('已断开'); }
  }, [active]);
  const send = async (text: string) => { if (!activeRef.current) return; if (!connectedRef.current) { setStatus(disconnectedMessage); return; } showOutputRef.current(); if (!isSsh && echoRef.current) terminal.current?.write(text.replace(/\r?\n/g, '\r\n')); try { await write(!isSsh && webModeRef.current ? text.replace(/[\r\n]+$/, '') + (text === '\x03' ? '' : '\n') : text); } catch (error) { setStatus(String(error)); } };
  async function openSshTerminal() {
    if (sshOpening.current) return;
    sshOpening.current = true;
    const attempt = ++connectionVersion.current;
    setBusy(true); setStatus('连接中…');
    terminal.current?.reset(); searchAddon.current?.clearDecorations();
    setSearchText(''); setSearchMessage(''); searchingRef.current = false;
    try { fitRef.current?.fit(); await window.viewer.sshTerminalOpen(terminal.current?.cols || 80, terminal.current?.rows || 24); }
    catch (error) { if (connectionVersion.current === attempt) setStatus(String(error)); }
    finally { if (connectionVersion.current === attempt) { sshOpening.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (isSsh && active && outputVisible && sshConnection && displaySlot && !connectedRef.current) void openSshTerminal();
  }, [isSsh, active, outputVisible, sshConnection, displaySlot]);
  return <section className={active ? "telnet-page" : "inactive-terminal"} data-protocol={protocol} onKeyDownCapture={e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault(); e.stopPropagation();
      const selected = terminal.current?.getSelection();
      if (selected && !selected.includes('\n')) setSearchText(selected);
      searchInput.current?.focus(); searchInput.current?.select();
    }
  }}>
    {connectionSlot && !isSsh && createPortal(<section className="telnet-sidebar"><div className="panel-title">Telnet <span className={`connection-status telnet-connection-status${connected ? ' connected' : busy ? ' connecting' : ''}`} role="status" aria-label="Telnet 连接状态">{status}</span></div><div className="inline telnet-controls"><select aria-label="Telnet 连接选择" value={webMode ? webNodeId || '__web__' : directNodeId || '__direct__'} onChange={e => { if (e.target.value === '__direct__' || directNodes.some(node => node.id === e.target.value)) { setWebMode(false); if (e.target.value !== '__direct__') selectDirectNode(e.target.value); } else { setWebMode(true); if (e.target.value !== '__web__') selectWebNode(e.target.value); } }}><option value="__direct__">直连 · {host}:{port}</option>{directNodes.map(node => <option key={node.id} value={node.id}>直连 · {node.name}</option>)}<option value="__web__">Web 远程设备…</option>{webNodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select>{webMode && <><label>设备/车号<input aria-label="设备号或车号" value={deviceQuery || device} onChange={e => { deviceSearchVersion.current++; setDevice(''); setDeviceName(''); setDeviceQuery(e.target.value); setDeviceMatches([]); setDeviceSearchOpen(false); }} placeholder="输入设备号或车号关键词" /></label>{deviceSearchOpen && <div className="device-search-results" role="listbox" aria-label="设备搜索结果">{deviceSearching ? <small>搜索中…</small> : deviceSearchError ? <small>{deviceSearchError}</small> : deviceMatches.length ? deviceMatches.map(item => <button role="option" aria-selected={device === item.number} key={item.number} title={`车号：${item.name || '未知'} · 设备号：${item.number}`} onClick={() => { deviceSearchVersion.current++; setDevice(item.number); setDeviceName(item.name); setDeviceQuery(''); setDeviceSearchOpen(false); setDeviceSearching(false); }}><i className={`device-status-dot ${item.online ? 'online' : 'offline'}`} aria-label={item.online ? '在线' : '离线'} />{`${item.name || '未知车号'} · ${item.number}`}</button>) : <small>没有匹配的设备</small>}</div>}</>}<div className="telnet-connection-actions"><button onClick={() => setConnectionSettings(true)}>⚙ 设置</button><button className="primary" disabled={busy} onClick={async () => { const attempt = ++connectionVersion.current; const current = () => connectionVersion.current === attempt; setBusy(true); await showOutputRef.current();
      terminal.current?.reset();
      searchAddon.current?.clearDecorations();
      setSearchText(''); setSearchMessage(''); searchingRef.current = false;
      webLineRef.current = '';
      connectedRef.current = false; setConnected(false); setStatus('连接中…'); try { if (webMode) {
        if (!webAddress.trim()) { setConnectionSettings(true); setStatus('请在设置中填写服务地址'); return; }
        if (!device.trim() || !telnetToken) {
          if (!webUser.trim()) { setConnectionSettings(true); setStatus('请在设置中填写用户名和密码'); return; }
          if (webPassword) await window.viewer.webTelnetPassword(webAddress, webUser, webPassword, rememberPassword);
          if (!current()) return;
          await window.viewer.webTelnetLogin(webAddress, webUser, webPassword);
          if (!current()) return;
          setWebPassword(''); setWebLoginStatus('登录成功');
        }
        if (!device.trim()) {
          await window.viewer.telnetClose();
          setStatus(deviceQuery.trim() ? '请先从搜索结果中选择设备' : 'Web 已登录 · 未连接设备');
          return;
        }
        if (!current()) return;
        await window.viewer.webTelnetConnect(webAddress, device.trim(), telnetToken, { name: webNodeName, deviceName });
      } else await window.viewer.telnetConnect(host, port, directNodeName); } catch (error) { if (current()) setStatus(String(error)); } finally { setBusy(false); } }}>连接</button><button onClick={() => { connectionVersion.current++; void window.viewer.telnetClose(); connectedRef.current = false; setConnected(false); setStatus('已断开'); }}>断开</button><button onClick={() => terminal.current?.clear()}>清屏</button><label><input type="checkbox" checked={echo} onChange={e => { setEcho(e.target.checked); echoRef.current = e.target.checked; }} />本地回显</label></div></div></section>, connectionSlot)}
    {!isSsh && connectionSettings && <div className="settings-backdrop" style={{ zIndex: 115 }} onClick={() => setConnectionSettings(false)}><form className="directory-settings telnet-connection-settings" role="dialog" aria-label="Telnet 连接设置" onClick={e => e.stopPropagation()} onSubmit={async e => {
      e.preventDefault();
      if (webMode) {
        const id = webNodeId || crypto.randomUUID();
        const node = { id, name: webNodeName.trim() || webAddress.trim(), address: webAddress.trim(), username: webUser.trim(), rememberPassword };
        try { await window.viewer.webTelnetPassword(webAddress, webUser, webPassword, rememberPassword); } catch (error) { setStatus(String(error)); return; }
        saveWebNodes([...webNodes.filter(item => item.id !== id), node]); setWebNodeId(id); setWebNodeName(node.name);
      } else {
        if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) return;
        const id = directNodeId || crypto.randomUUID();
        const node = { id, name: directNodeName.trim() || host.trim() + ':' + port, host: host.trim(), port };
        saveDirectNodes(directNodes.some(item => item.id === id) ? directNodes.map(item => item.id === id ? node : item) : [...directNodes, node]);
        setDirectNodeId(id); setDirectNodeName(node.name); setHost(node.host);
      }
      setConnectionSettings(false);
    }}><div className="panel-title">Telnet 设置<button type="button" aria-label="关闭设置" onClick={() => setConnectionSettings(false)}>×</button></div>
      <label>连接方式<select value={webMode ? 'web' : 'direct'} onChange={e => setWebMode(e.target.value === 'web')}><option value="direct">直连 Telnet</option><option value="web">Web 远程设备</option></select></label>
      {webMode ? <>
        <label>登录节点<select aria-label="Web 登录节点" value={webNodeId} onChange={e => selectWebNode(e.target.value)}><option value="">＋ 新建节点</option>{webNodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
        <label>名称<input value={webNodeName} placeholder="选填，默认使用服务地址" onChange={e => setWebNodeName(e.target.value)} /></label>
        <label>服务地址<input required aria-label="Web 服务地址" value={webAddress} placeholder="http://服务器:端口" onChange={e => setWebAddress(e.target.value)} /></label>
        <label>用户名<input required value={webUser} onChange={e => setWebUser(e.target.value)} /></label>
        <label>密码<input type="password" autoComplete="off" value={webPassword} placeholder="留空使用已保存密码" onChange={e => setWebPassword(e.target.value)} /></label><label className="web-remember-password"><input type="checkbox" checked={rememberPassword} onChange={e => setRememberPassword(e.target.checked)} />记住密码</label>
        <details><summary>高级选项</summary><label>专用令牌（通常无需填写）<input type="password" value={telnetToken} onChange={e => setTelnetToken(e.target.value)} /></label></details>
      </> : <><label>直连配置<select aria-label="直连配置" value={directNodeId} onChange={e => selectDirectNode(e.target.value)}><option value="">＋ 新建直连</option>{directNodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label>名称<input aria-label="直连名称" value={directNodeName} placeholder="选填，默认使用主机和端口" onChange={e => setDirectNodeName(e.target.value)} /></label><label>主机<input required value={host} onChange={e => setHost(e.target.value)} /></label><label>端口<input required type="number" min={1} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></label></>}
      <div className="inline"><button className="primary">保存</button><button type="button" onClick={() => setConnectionSettings(false)}>取消</button>{!webMode && <button type="button" onClick={() => selectDirectNode('')}>新增直连</button>}{!webMode && directNodeId && <button type="button" onClick={() => { const next = directNodes.filter(node => node.id !== directNodeId); saveDirectNodes(next); selectDirectNode(next[0]?.id || ''); }}>删除直连</button>}{webMode && webNodeId && <button type="button" onClick={() => { saveWebNodes(webNodes.filter(node => node.id !== webNodeId)); selectWebNode(''); }}>删除节点</button>}</div>
    </form></div>}
    {settingsSlot && createPortal(<><button onClick={() => setLogSettings(true)}>日志设置…</button><button onClick={async () => { try { const file = await (isSsh ? window.viewer.sshTerminalSaveOutput() : window.viewer.telnetSaveOutput()); if (file) setLogApplied('已保存：' + file); } catch (error) { setLogApplied(String(error)); } }}>保存输出…</button>{logApplied && <small role="status">{logApplied}</small>}</>, settingsSlot)}
    {logSettings && <div className="settings-backdrop" style={{ zIndex: 120 }} onClick={() => setLogSettings(false)}><section className="directory-settings" role="dialog" aria-label={label + " 日志设置"} onClick={e => e.stopPropagation()}><div className="panel-title">日志设置<button aria-label="关闭日志设置" onClick={() => setLogSettings(false)}>×</button></div><label>日志类型<select value={logMode} onChange={e => setLogMode(e.target.value)}><option value="none">不记录</option><option value="printable">记录可打印输出</option><option value="all">记录所有输出（含控制序列）</option></select></label><label>写入方式<select value={append ? 'append' : 'overwrite'} onChange={e => setAppend(e.target.value === 'append')}><option value="append">追加日志文件</option><option value="overwrite">覆盖日志文件</option></select></label><button className="primary" onClick={async () => { try { const file = await recording(logMode, append); setLogFile(file || ''); setLogApplied(logMode === 'none' ? '已停止记录' : file ? '已应用日志设置' : '已应用，下次连接时自动创建日志'); } catch (error) { setLogApplied(String(error)); } }}>应用</button>{logFile && <><span title={logFile}>记录中：{logFile}</span><button onClick={async () => { try { await recording('none', true); setLogMode('none'); setLogFile(''); setLogApplied('已停止记录'); } catch (error) { setLogApplied(String(error)); } }}>停止记录</button></>}{logApplied && <p role="status">{logApplied}</p>}<p className="hint">自动保存到下载目录 {protocol}/日期/{isSsh ? '连接名称与主机' : '车号、设备号或直连名称与地址'}/，每次连接新建日志；清屏不影响记录。覆盖仅清空当前会话日志。</p></section></div>}
    {displaySlot && createPortal(<div className="shared-telnet-content">{isSsh && <div className="inline ssh-terminal-toolbar"><span className={connected ? 'connection-status connected' : 'connection-status'} aria-label="SSH 终端状态">{sshConnection ? status : '请使用左侧连接管理连接 SSH'}</span>{sshConnection && !connected && !busy && <button onClick={() => void openSshTerminal()}>重试终端</button>}<button onClick={() => terminal.current?.clear()}>清屏</button></div>}<form className="inline telnet-search" onSubmit={e => { e.preventDefault(); find(); }}><input ref={searchInput} aria-label={"搜索 " + label + " 输出"} placeholder="搜索终端输出（Ctrl+F）" value={searchText} onChange={e => { setSearchText(e.target.value); searchingRef.current = false; setSearchMessage(''); searchAddon.current?.clearDecorations(); }} onKeyDown={e => { if (e.key === 'Escape') { searchingRef.current = false; searchAddon.current?.clearDecorations(); terminal.current?.focus(); } if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); find(true); } }} /><label title="区分大小写"><input aria-label="区分大小写" type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />Aa</label><label><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} />正则</label><button type="button" disabled={!searchText} onClick={() => find(true)}>上一个</button><button disabled={!searchText}>下一个</button><span aria-live="polite">{searchMessage}</span></form>
    <div className="telnet-output" onClick={() => terminal.current?.focus()}><div ref={viewport} className="telnet-terminal-host" aria-label={label + " 交互终端"} /></div></div>, displaySlot)}
    <TelnetCommands visible={active} protocol={protocol} settingsSlot={settingsSlot} onSend={command => { if (!connectedRef.current) { void send(''); return; } let text = command.replace(/(?:\\r|\\n|[\r\n])+$/g, '').trim(); if (!isSsh && webModeRef.current && !/^send(?:\s|$)/i.test(text)) text = 'send ' + text; void send(text + (isSsh ? '\r' : '\r\n')); terminal.current?.focus(); }} />
    {active && logApplied && <small className="terminal-feedback" role="status">{logApplied}</small>}
    {active && <form className="inline"  onSubmit={e => { e.preventDefault(); void send(input + (isSsh ? '\r' : '\r\n')); setInput(''); }}><input type="text" aria-label={label + " 输入"} autoComplete="off" value={input} onChange={e => setInput(e.target.value)} placeholder={isSsh ? "输入 SSH 命令，按 Enter 发送" : "输入命令或登录信息，按 Enter 发送"} style={{ flex: 1 }} /><button disabled={!connected}>发送</button></form>}
  </section>;
}
