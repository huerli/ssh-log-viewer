import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bookmark, Doc, Entry, Profile, Row, SearchResult, ViewerEvent, LogFilter, Match, JumpProfile, LocalListing } from './types';
import { themes, resolveTheme, type ThemeId } from './themes';
import './style.css';
import { TerminalPage } from './TerminalPage';
import { UpdateControl } from './UpdateControl';
import { filenamePattern } from '../shared/glob.mjs';
import { defaultLogFont, logLineHeight, resultLineHeight, logFontFamily } from '../shared/log-font.mjs';

const api = window.viewer;
const defaultLogDirectory = '/system/log';
const defaultJump: JumpProfile = { enabled: false, host: '', port: 22, username: '', auth: 'password', keyPath: '', password: '', passphrase: '', rememberPassword: true };
const initial: Profile = { name: '', host: '', port: 22, username: '', auth: 'password', keyPath: '', password: '', passphrase: '', rememberPassword: true };
const size = (bytes = 0) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const join = (directory: string, name: string) => `${directory.replace(/\/$/, '')}/${name}`;
const searchHistoryKey = 'ssh-log-viewer.search-history';
type TransferJump = { name?: string; enabled: boolean; host: string; port: number; username: string; auth: string; keyPath: string; rememberPassword: boolean };
type TransferProfile = { name: string; host: string; port: number; username: string; auth: string; keyPath: string; rememberPassword: boolean; jumpName?: string; jump?: TransferJump };
type DirectTelnetNode = { id: string; name: string; host: string; port: number };
type WebTelnetNode = { id: string; name: string; address: string; username: string; rememberPassword?: boolean };
type ConnectionTransfer = { format: 'ssh-log-viewer-connection-config'; version: 1; exportedAt: string; sshProfiles: TransferProfile[]; sshJumpProfiles: TransferJump[]; directTelnetNodes: Omit<DirectTelnetNode, 'id'>[]; webTelnetNodes: Omit<WebTelnetNode, 'id'>[] };
const connectionTransferFormat = 'ssh-log-viewer-connection-config' as const;
function storedArray<T>(key: string, guard: (value: unknown) => value is T): T[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(guard) : []; } catch { return []; }
}
function isDirectTelnetNode(value: unknown): value is DirectTelnetNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === 'string' && typeof node.name === 'string' && typeof node.host === 'string' && !!node.host.trim() && Number.isInteger(node.port) && Number(node.port) >= 1 && Number(node.port) <= 65535;
}
function isWebTelnetNode(value: unknown): value is WebTelnetNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === 'string' && typeof node.name === 'string' && typeof node.address === 'string' && !!node.address.trim() && typeof node.username === 'string' && !!node.username.trim();
}
function exportJump(value: Partial<JumpProfile>): TransferJump {
  return { ...(value.name ? { name: String(value.name) } : {}), enabled: Boolean(value.enabled), host: String(value.host || ''), port: Number(value.port || 22), username: String(value.username || ''), auth: String(value.auth || 'password'), keyPath: String(value.keyPath || ''), rememberPassword: Boolean(value.rememberPassword) };
}
function exportProfile(value: Profile): TransferProfile {
  return { name: String(value.name), host: String(value.host), port: Number(value.port || 22), username: String(value.username), auth: String(value.auth || 'password'), keyPath: String(value.keyPath || ''), rememberPassword: Boolean(value.rememberPassword), ...(value.jumpName ? { jumpName: String(value.jumpName) } : {}), ...(value.jump ? { jump: exportJump(value.jump) } : {}) };
}
function transferString(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}格式无效`);
  return value.trim();
}
function transferPort(value: unknown, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}端口无效`);
  return port;
}
function parseTransferJump(value: unknown, label: string): TransferJump {
  if (!value || typeof value !== 'object') throw new Error(`${label}格式无效`);
  const item = value as Record<string, unknown>;
  const auth = transferString(item.auth || 'password', `${label}认证方式`);
  if (!['password', 'key', 'agent'].includes(auth)) throw new Error(`${label}认证方式无效`);
  return { ...(typeof item.name === 'string' && item.name.trim() ? { name: transferString(item.name, `${label}名称`, 200) } : {}), enabled: Boolean(item.enabled), host: transferString(item.host, `${label}主机`), port: transferPort(item.port, label), username: transferString(item.username, `${label}用户名`), auth, keyPath: typeof item.keyPath === 'string' ? item.keyPath : '', rememberPassword: Boolean(item.rememberPassword) };
}
function parseConnectionTransfer(value: unknown): ConnectionTransfer {
  if (!value || typeof value !== 'object') throw new Error('配置文件格式无效');
  const data = value as Record<string, unknown>;
  if (data.format !== connectionTransferFormat || data.version !== 1) throw new Error('不支持的登录配置文件版本');
  const profilesValue = data.sshProfiles, jumpsValue = data.sshJumpProfiles, directValue = data.directTelnetNodes, webValue = data.webTelnetNodes;
  if (![profilesValue, jumpsValue, directValue, webValue].every(Array.isArray)) throw new Error('登录配置缺少必要分组');
  if ((profilesValue as unknown[]).length > 200 || (jumpsValue as unknown[]).length > 200 || (directValue as unknown[]).length > 200 || (webValue as unknown[]).length > 200) throw new Error('单个配置文件最多包含 200 条记录');
  const jumps = (jumpsValue as unknown[]).map((value, index) => parseTransferJump(value, `SSH 跳板机 ${index + 1}`));
  const jumpNames = new Set<string>();
  for (const jump of jumps) { const name = transferString(jump.name, 'SSH 跳板机名称', 200); if (jumpNames.has(name)) throw new Error(`SSH 跳板机名称重复：${name}`); jumpNames.add(name); jump.name = name; }
  const profiles = (profilesValue as unknown[]).map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`SSH 连接 ${index + 1} 格式无效`);
    const item = value as Record<string, unknown>;
    const auth = transferString(item.auth || 'password', `SSH 连接 ${index + 1}认证方式`);
    if (!['password', 'key', 'agent'].includes(auth)) throw new Error(`SSH 连接 ${index + 1}认证方式无效`);
    const profile: TransferProfile = { name: transferString(item.name, `SSH 连接 ${index + 1}名称`, 200), host: transferString(item.host, `SSH 连接 ${index + 1}主机`), port: transferPort(item.port, `SSH 连接 ${index + 1}`), username: transferString(item.username, `SSH 连接 ${index + 1}用户名`), auth, keyPath: typeof item.keyPath === 'string' ? item.keyPath : '', rememberPassword: Boolean(item.rememberPassword) };
    if (typeof item.jumpName === 'string' && item.jumpName.trim()) profile.jumpName = transferString(item.jumpName, `SSH 连接 ${index + 1}跳板机名称`, 200);
    if (item.jump !== undefined) profile.jump = parseTransferJump(item.jump, `SSH 连接 ${index + 1}跳板机`);
    return profile;
  });
  const directTelnetNodes = (directValue as unknown[]).map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Telnet 直连 ${index + 1}格式无效`);
    const item = value as Record<string, unknown>;
    return { name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : '', host: transferString(item.host, `Telnet 直连 ${index + 1}主机`), port: transferPort(item.port, `Telnet 直连 ${index + 1}`) };
  });
  const webTelnetNodes = (webValue as unknown[]).map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Telnet Web 节点 ${index + 1}格式无效`);
    const item = value as Record<string, unknown>;
    return { name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : '', address: transferString(item.address, `Telnet Web 节点 ${index + 1}地址`), username: transferString(item.username, `Telnet Web 节点 ${index + 1}用户名`), rememberPassword: Boolean(item.rememberPassword) };
  });
  return { format: connectionTransferFormat, version: 1, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '', sshProfiles: profiles, sshJumpProfiles: jumps, directTelnetNodes, webTelnetNodes };
}
function uniqueTransferName(value: string, used: Set<string>): string {
  const base = value.trim() || '导入配置';
  let candidate = base, suffix = 2;
  while (used.has(candidate)) candidate = `${base} (${suffix++})`;
  used.add(candidate); return candidate;
}
function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function readSearchHistory(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(searchHistoryKey) || '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && !!item.trim() && item.length <= 2048))].slice(0, 30) : [];
  } catch { return []; }
}
function SearchHistoryInput({ inputRef, query, onChange, history, onClear }: { inputRef: React.RefObject<HTMLInputElement | null>; query: string; onChange: (value: string) => void; history: string[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const visible = open && !query && history.length > 0;
  function choose(value: string) { onChange(value); setOpen(false); setActive(-1); inputRef.current?.focus(); }
  return <div className="search-history-input" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setActive(-1); } }}>
    <input ref={inputRef} role="combobox" name="search-query" aria-label="搜索全文关键词或正则表达式" aria-autocomplete="none" aria-expanded={visible} aria-controls={visible ? 'search-history-list' : undefined} aria-activedescendant={visible && active >= 0 ? `search-history-${active}` : undefined} autoComplete="off" title="普通搜索支持 * 匹配同一行内的任意内容；勾选正则后按正则表达式搜索" placeholder="搜索全文关键词或正则表达式…" value={query} onFocus={() => { setOpen(true); setActive(-1); }} onClick={() => setOpen(true)} onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }} onKeyDown={e => {
      if (e.key === 'Escape') { setOpen(false); setActive(-1); }
      else if (!query && history.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); setActive(index => e.key === 'ArrowDown' ? (index + 1) % history.length : (index <= 0 ? history.length : index) - 1); }
      else if (visible && active >= 0 && e.key === 'Enter') { e.preventDefault(); choose(history[active]); }
    }} />
    {visible && <div className="search-history-dropdown"><div className="search-history-heading"><span>搜索历史</span><button type="button" onClick={() => { onClear(); setOpen(false); inputRef.current?.focus(); }}>清空搜索历史</button></div><div id="search-history-list" role="listbox" aria-label="搜索历史">{history.map((item, index) => <button id={`search-history-${index}`} key={item} type="button" role="option" aria-selected={active === index} title={item} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>{item}</button>)}</div></div>}
  </div>;
}
type DownloadNode = { folders: Map<string, DownloadNode>; path?: string; files: { name: string; path: string }[] };
function DownloadedFiles({ paths, autoExpandPaths, roots, selected, disabled, onOpen, onRefresh, onError, onOpenFolder }: { paths: string[]; autoExpandPaths: string[]; roots: string[]; selected?: string; disabled: boolean; onOpen: (file: string) => void; onRefresh: () => void; onError: (error: string) => void; onOpenFolder: (path: string) => void }) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpanded(previous => {
      const next = new Set(previous);
      for (const file of autoExpandPaths) {
        const parts = file.replace(/\\/g, '/').split('/');
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      }
      return next;
    });
  }, [autoExpandPaths]);
  const tree: DownloadNode = { folders: new Map(), files: [] };
  for (const file of paths) {
    const normalized = file.replace(/\\/g, '/');
    const root = roots.map(root => root.replace(/\\/g, '/').replace(/\/$/, '')).find(root => normalized.startsWith(root + '/'));
    const relative = root ? normalized.slice(root.length + 1) : normalized.replace(/^\//, '');
    if (filter && !relative.toLowerCase().includes(filter.toLowerCase())) continue;
    const parts = relative.split('/');
    let node = tree;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], path: root ? `${root}/${parts.slice(0, index + 1).join('/')}` : `/${parts.slice(0, index + 1).join('/')}` });
      node = node.folders.get(part)!;
    }
    node.files.push({ name: parts[parts.length - 1], path: file });
  }
  function render(node: DownloadNode): React.ReactNode {
    return <>{[...node.folders].map(([name, child]) => <details key={name} open={!!filter || expanded.has(child.path || '')} onToggle={e => { const isOpen = e.currentTarget.open; setExpanded(previous => { const next = new Set(previous); if (isOpen) next.add(child.path || ''); else next.delete(child.path || ''); return next; }); }}><summary title={name} onContextMenu={e => { e.preventDefault(); if (child.path) onOpenFolder(child.path); }}>{name}</summary><div className="download-tree-children">{render(child)}</div></details>)}{node.files.map(file => <button key={file.path} className={`download-tree-file ${selected === file.path ? 'active' : ''}`} title={file.path} disabled={disabled} onClick={() => onOpen(file.path)}><span>≡</span><span>{file.name}</span></button>)}</>;
  }
  return <aside className="downloads-panel" aria-label="已下载文件"><div className="panel-title">已下载文件 <span>{paths.length}</span><button aria-label="刷新已下载文件" onClick={onRefresh}>↻</button></div><input aria-label="筛选已下载文件" placeholder="筛选文件名或文件夹…" value={filter} onChange={e => setFilter(e.target.value)} /><div className="download-tree">{render(tree)}{!tree.folders.size && !tree.files.length && <p className="hint">{paths.length ? '没有匹配的文件' : '暂无已下载文件'}</p>}</div></aside>;
}
const palette = ['#fbbf24', '#60a5fa', '#c084fc', '#34d399'];

function Highlight({ text, words, sensitive }: { text: string; words: string[]; sensitive: boolean }) {
  const visible = text.slice(0, 12000);
  const tokens = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return <>{visible}{text.length > visible.length && ' … [超长行显示已截断]'}</>;
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = visible.split(new RegExp(`(${escaped.join('|')})`, sensitive ? 'g' : 'gi'));
  return <>{parts.map((part, i) => {
    const index = tokens.findIndex(t => sensitive ? t === part : t.toLocaleLowerCase() === part.toLocaleLowerCase());
    return index < 0 ? part : <mark key={i} style={{ background: palette[index % palette.length] }}>{part}</mark>;
  })}{text.length > visible.length && ' … [超长行显示已截断]'}</>;
}

function LogView({ doc, words, sensitive, bookmarks, jump, filter, onContext, onSelect, onError, onBottomChange, rowHeight, selectedLine }:  {
  selectedLine: number | null;
  doc: Doc; words: string[]; sensitive: boolean; bookmarks: Bookmark[]; jump: { line: number; token: number; query?: string; regex?: boolean; caseSensitive?: boolean };
  onSelect(line: number): void; onError(message: string): void;
  filter: LogFilter | null; onContext(text: string, x: number, y: number): void;
  rowHeight: number;
  onBottomChange(bottom: boolean): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const horizontalJump = useRef(-1);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [rows, setRows] = useState<Row[]>([]);
  const count = filter ? filter.count : doc.ready ? doc.lines : doc.preview?.length || 0;
  const totalHeight = Math.min(8000000, Math.max(height, count * rowHeight));
  const visibleCount = Math.max(1, Math.floor(height / rowHeight));
  const maxStart = Math.max(0, count - visibleCount);
  const start = Math.min(maxStart, Math.floor(scroll / Math.max(1, totalHeight - height) * maxStart));
  const needed = Math.max(0, start - 30);
  useEffect(() => { setRows([]); }, [doc.id, filter?.token]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const top = Math.min(maxStart, Math.max(0, jump.line)) / Math.max(1, maxStart) * (totalHeight - height);
    if (viewport.current) viewport.current.scrollTop = top;
    setScroll(top);
  }, [jump, doc.id, doc.ready, filter?.token, rowHeight, height]);
  useEffect(() => {
    let active = true;
    if (!doc.ready) { setRows((doc.preview || []).map((text, line) => ({ text, line }))); return; }
    const timer = setTimeout(() => {
      api.page(doc.id, needed, visibleCount + 70, filter?.token).then(data => { if (active) setRows(data); }).catch(e => { if (active) onError(e.message); });
    }, 20);
    return () => { active = false; clearTimeout(timer); };
  }, [doc.id, doc.lines, doc.ready, filter?.token, needed, visibleCount]);
  useLayoutEffect(() => {
    const view = viewport.current;
    const content = view?.querySelector(`[data-line="${jump.line}"] .line-content`);
    if (!view || !content || !jump.query || horizontalJump.current === jump.token) return;
    const text = content.textContent || '';
    let at = -1, length = 0;
    try {
      if (jump.regex || jump.query.includes('*')) {
        const pattern = jump.regex ? jump.query : jump.query.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?');
        const found = new RegExp(pattern, jump.caseSensitive ? '' : 'i').exec(text);
        if (found) { at = found.index; length = found[0].length; }
      } else {
        at = jump.caseSensitive ? text.indexOf(jump.query) : text.toLocaleLowerCase().indexOf(jump.query.toLocaleLowerCase());
        length = jump.query.length;
      }
    } catch { return; }
    if (at < 0) return;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let offset = 0, node;
    while ((node = walker.nextNode())) {
      const size = node.textContent?.length || 0;
      if (offset + size > at) {
        const range = document.createRange();
        range.setStart(node, at - offset);
        range.setEnd(node, Math.min(size, at - offset + Math.max(1, length)));
        const bounds = range.getBoundingClientRect();
        const box = view.getBoundingClientRect();
        view.scrollLeft = Math.max(0, view.scrollLeft + bounds.left - box.left - 100);
        horizontalJump.current = jump.token;
        break;
      }
      offset += size;
    }
  }, [rows, jump, height]);
  const flashJump = jump.token > 0;
  const shown = rows.filter(row => (row.position ?? row.line) >= start && (row.position ?? row.line) <= start + visibleCount + 1);
  return <div className="log-viewport" ref={viewport} onCopy={e => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!viewport.current?.contains(range.commonAncestorContainer)) return;
    const fragment = range.cloneContents();
    fragment.querySelectorAll('.line-number').forEach(node => node.remove());
    const lines = [...fragment.querySelectorAll('.log-row')];
    const text = lines.length ? lines.map(line => line.textContent || '').join('\n') : fragment.textContent || '';
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
  }} onScroll={e => { const view = e.currentTarget; setScroll(view.scrollTop); onBottomChange(view.scrollHeight - view.clientHeight - view.scrollTop <= 4); }}>
    <div style={{ height: totalHeight, position: 'relative' }}>
      <div className="log-rows" style={{ top: Math.min(scroll, totalHeight - height), height, overflow: 'hidden', overflowAnchor: 'none' }}>
        {shown.map(row => {
          const bookmark = bookmarks.find(b => b.line === row.line);
          const level = /\b(ERROR|FATAL)\b/.test(row.text) ? 'error-line' : /\bWARN(?:ING)?\b/.test(row.text) ? 'warn-line' : '';
          return <div key={row.line === jump.line ? `${row.line}:${jump.token}` : row.line} data-line={row.line} className={`log-row ${level} ${selectedLine === row.line ? 'selected-line' : ''} ${flashJump && row.line === jump.line ? 'jump-highlight' : ''}`} style={{ borderLeftColor: bookmark?.color || 'transparent' }}>
            <button className="line-number" aria-pressed={selectedLine === row.line} title={doc.ready ? '点击选择此行，再添加标注' : '缓存完成后可添加标注'} onClick={() => doc.ready && onSelect(row.line)}>{bookmark ? '◆ ' : ''}{doc.ready ? row.line + 1 : '·'}</button>
            <span className="line-content" onContextMenu={e => {
              const selection = window.getSelection();
              const inside = selection?.anchorNode && viewport.current?.contains(selection.anchorNode) && selection.focusNode && viewport.current.contains(selection.focusNode);
              const text = inside && selection?.toString() ? selection.toString() : (e.target as HTMLElement).closest('mark')?.textContent || '';
              if (!text) return;
              e.preventDefault();
              if (text.length > 2048 || /[\r\n]/.test(text)) { onError('请选择单行内、不超过 2048 字符的文本'); return; }
              onContext(text, e.clientX, e.clientY);
            }}><Highlight text={row.text} words={words} sensitive={sensitive} />{(row.truncated || row.displayTruncated) && <em> [超长行显示已截断]</em>}</span>
          </div>;
        })}
        {!count && <p className="empty-inline">{filter ? '没有包含该字符串的日志行' : doc.ready ? '文件为空' : '正在准备日志…'}</p>}
      </div>
    </div>
  </div>;
}

function SearchRows({ results, onJump, rowHeight, searching, onCopy, onError }: { onCopy: () => void; onError: (error: string) => void; searching: boolean; results: SearchResult | null; onJump(match: Match): void; rowHeight: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(180);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [results === null]);
  const [copyMenu, setCopyMenu] = useState<{ x: number; y: number; text: string; selected: boolean } | null>(null);
  useEffect(() => {
    if (!copyMenu) return;
    const close = () => setCopyMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [copyMenu]);
  useEffect(() => setCopyMenu(null), [results === null, top]);
  function selectedText(row: HTMLElement): string {
    const text = row.querySelector('.search-result-text');
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && text?.contains(selection.anchorNode) && text.contains(selection.focusNode) ? selection.toString() : '';
  }
  async function copy(text: string) {
    setCopyMenu(null);
    try { await api.copyText(text); onCopy(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  const matches = results?.matches || [];
  const start = Math.max(0, Math.floor(top / rowHeight) - 6);
  const end = Math.min(matches.length, start + Math.ceil(height / rowHeight) + 14);
  return <div className="result-list search-results" ref={viewport} onScroll={e => setTop(e.currentTarget.scrollTop)}>
    <div className="search-result-rows" style={{ paddingTop: start * rowHeight, paddingBottom: Math.max(0, matches.length - end) * rowHeight }}>
      {matches.slice(start, end).map(match => <div className="search-result-row" key={`${match.file || ''}:${match.line}`} onContextMenu={e => { e.preventDefault(); const selected = selectedText(e.currentTarget); setCopyMenu({ x: e.clientX, y: e.clientY, text: selected || match.text, selected: Boolean(selected) }); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); void copy(selectedText(e.currentTarget) || match.text); } }}><button className="result" onClick={e => { if (!selectedText(e.currentTarget)) onJump(match); }}><small>第 {match.line + 1} 行</small>{match.file && <label className="result-file" title={match.file}>{match.file.split('/').pop()}</label>}<span className="search-result-text">{match.text}</span></button><button className="copy-search-result" aria-label={`复制第 ${match.line + 1} 行日志`} title="复制选中文本；未选中则复制整条日志" onPointerDown={e => e.preventDefault()} onClick={e => void copy(selectedText(e.currentTarget.parentElement!) || match.text)}>复制</button></div>)}
    </div>
    {copyMenu && <div className="text-context-menu" role="menu" aria-label="搜索结果操作" style={{ left: Math.max(4, Math.min(copyMenu.x, window.innerWidth - 244)), top: Math.max(4, Math.min(copyMenu.y, window.innerHeight - 64)) }} onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }}><button role="menuitem" onClick={() => void copy(copyMenu.text)}>{copyMenu.selected ? '复制选中内容' : '复制整条日志'}</button></div>}
    {searching && !matches.length && <p className="empty-inline">正在搜索，匹配结果将实时显示…</p>}
    {!searching && !results && <p className="empty-inline">选中日志文本后按 Ctrl+F 搜索，点击结果跳转到日志上下文。</p>}
    {!searching && results?.count === 0 && <p className="empty-inline">未找到匹配内容</p>}
  </div>;
}

function App() {
  const [telnetPage, setTelnetPage] = useState(false);
  const [featureEnabled, setFeatureEnabled] = useState({ ssh: false, telnet: true });
  const [terminalMode, setTerminalMode] = useState<'ssh' | 'telnet'>('telnet');
  const modeVersion = useRef(0);
  const [modeSwitching, setModeSwitching] = useState(false);
  async function showTerminal(mode: 'ssh' | 'telnet') {
    if (!featureEnabled[mode]) return;
    if (mode === terminalMode && !modeSwitching) { setTelnetPage(true); return; }
    const version = ++modeVersion.current;
    setModeSwitching(true);
    try {
      await api.terminalMode(mode);
      if (version === modeVersion.current) { setTerminalMode(mode); setTelnetPage(true); }
    } catch (error) { fail(error); }
    finally { if (version === modeVersion.current) setModeSwitching(false); }
  }
  const [theme, setTheme] = useState<ThemeId>('midnight');
  const [font, setFont] = useState(defaultLogFont);
  const [fontDraft, setFontDraft] = useState(defaultLogFont);
  const [fontSettings, setFontSettings] = useState(false);
  const [fontSaving, setFontSaving] = useState(false);
  const [profile, setProfile] = useState<Profile>(initial);
  const [jumpSettings, setJumpSettings] = useState(false);
  const [connectionSettings, setConnectionSettings] = useState(false);
  const [jumpProfiles, setJumpProfiles] = useState<JumpProfile[]>([]);
  const jumpLoadToken = useRef(0);
  const jumpConfig = { ...defaultJump, ...profile.jump };
  const updateJump = (fields: Partial<JumpProfile>) => { jumpLoadToken.current++; setProfile(p => ({ ...p, jumpName: fields.enabled !== undefined ? p.jumpName : undefined, jump: { ...defaultJump, ...p.jump, ...fields } })); };
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const profileLoadToken = useRef(0);
  const [connection, setConnection] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [directory, setDirectory] = useState(defaultLogDirectory);
  const [pathInput, setPathInput] = useState(defaultLogDirectory);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [fileSource, setFileSource] = useState<'remote' | 'local'>('remote');
  const [localListing, setLocalListing] = useState<LocalListing | null>(null);
  const [localPicker, setLocalPicker] = useState<LocalListing | null>(null);
  const [pickerPath, setPickerPath] = useState('');
  const [pickerSelection, setPickerSelection] = useState('');
  const [localPathInput, setLocalPathInput] = useState('');
  const localMode = fileSource === 'local';
  const browseDirectory = localMode ? localListing?.path || '' : directory;
  const browseEntries = localMode ? localListing?.entries || [] : entries;
  const canBrowse = localMode ? Boolean(localListing) : Boolean(connection);
  const [filePattern, setFilePattern] = useState('');
  const [filenameFromSelection, setFilenameFromSelection] = useState(false);
  const [selectionListPattern, setSelectionListPattern] = useState('');
  const activePattern = filenameFromSelection ? selectionListPattern : filePattern;
  const [directories, setDirectories] = useState({ download: '', extract: '' });
  const [resultIndex, setResultIndex] = useState(-1);
  const [shortcuts, setShortcuts] = useState(() => {
    try { return { next: 'F3', previous: 'Shift+F3', ...JSON.parse(localStorage.getItem('viewer-shortcuts') || '{}') }; }
    catch { return { next: 'F3', previous: 'Shift+F3' }; }
  });
  const [directorySettings, setDirectorySettings] = useState(false);
  const [connectionTransferMessage, setConnectionTransferMessage] = useState('');
  const connectionTransferInput = useRef<HTMLInputElement>(null);
  const [autoExpandPaths, setAutoExpandPaths] = useState<string[]>([]);
  const [downloadedPaths, setDownloadedPaths] = useState<string[]>([]);
  const [extractedPaths, setExtractedPaths] = useState<string[]>([]);
  const pendingJump = useRef<number | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  const pendingEvents = useRef<ViewerEvent[]>([]);
  const opening = useRef(false);
  const [openingState, setOpeningState] = useState(false);
  const [message, setMessage] = useState('就绪 · 连接服务器或打开本地日志');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchHistory, setSearchHistory] = useState(readSearchHistory);
  const searchHistoryRef = useRef(searchHistory);
  const historyTouched = useRef(false);
  async function persistSearchHistory(history: string[]) {
    historyTouched.current = true; searchHistoryRef.current = history; setSearchHistory(history);
    await api.saveSearchHistory(history);
  }
  useEffect(() => { try { localStorage.setItem(searchHistoryKey, JSON.stringify(searchHistory)); } catch { /* Search remains usable if storage is unavailable. */ } }, [searchHistory]);
  const [searchScope, setSearchScope] = useState<'current' | 'extracted' | 'remote' | 'folder'>('current');
  const [regex, setRegex] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [rules, setRules] = useState('');
  const [extraHighlights, setExtraHighlights] = useState<string[]>([]);
  const [suppressedHighlights, setSuppressedHighlights] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [filter, setFilter] = useState<LogFilter | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [resultContext, setResultContext] = useState({ query: '', file: '', regex: false, caseSensitive: false, partial: true });
  const searchToken = useRef('');
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(false);
  const atBottomRef = useRef(true);
  const jumpSearch = useRef<{ query?: string; regex?: boolean; caseSensitive?: boolean }>({});
  const [jump, setJump] = useState<{ line: number; token: number; query?: string; regex?: boolean; caseSensitive?: boolean }>({ line: 0, token: 0 });
  const [jumpInput, setJumpInput] = useState('');
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [color, setColor] = useState('#fbbf24');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [task, setTask] = useState<ViewerEvent | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [sideTab, setSideTab] = useState<'search' | 'marks'>('search');
  const go = (line: number) => setJump(previous => ({ line, token: previous.token + 1, ...jumpSearch.current }));
  const fail = (e: unknown) => setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  const run = async (work: () => Promise<unknown>) => { setError(''); try { await work(); } catch (e) { fail(e); } };

  async function exportConnectionConfig() {
    const settings = await api.settings();
    const payload: ConnectionTransfer = {
      format: connectionTransferFormat,
      version: 1,
      exportedAt: new Date().toISOString(),
      sshProfiles: settings.profiles.map(exportProfile),
      sshJumpProfiles: settings.jumpProfiles.map(exportJump),
      directTelnetNodes: storedArray<DirectTelnetNode>('direct-telnet-nodes', isDirectTelnetNode).map(({ id: _id, ...node }) => node),
      webTelnetNodes: storedArray<WebTelnetNode>('web-telnet-nodes', isWebTelnetNode).map(({ id: _id, ...node }) => node),
    };
    downloadJson(`ssh-log-viewer-connections-${new Date().toISOString().slice(0, 10)}.json`, payload);
    setConnectionTransferMessage(`已导出 ${payload.sshProfiles.length} 个 SSH 连接、${payload.directTelnetNodes.length + payload.webTelnetNodes.length} 个 Telnet 节点`);
  }
  async function importConnectionConfig(file: File) {
    if (file.size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5MB');
    const transfer = parseConnectionTransfer(JSON.parse(await file.text()));
    const current = await api.settings();
    const usedProfiles = new Set(current.profiles.map(item => item.name));
    const usedJumps = new Set(current.jumpProfiles.map(item => item.name || ''));
    const jumpNames = new Map<string, string>();
    for (const jump of transfer.sshJumpProfiles) {
      const originalName = jump.name!;
      const name = uniqueTransferName(originalName, usedJumps);
      jumpNames.set(originalName, name);
      await api.saveJumpProfile({ ...jump, name });
    }
    for (const profile of transfer.sshProfiles) {
      const name = uniqueTransferName(profile.name, usedProfiles);
      const jumpName = profile.jumpName ? jumpNames.get(profile.jumpName) || (usedJumps.has(profile.jumpName) ? profile.jumpName : undefined) : undefined;
      await api.saveProfile({ ...profile, name, ...(jumpName ? { jumpName } : {}), ...(!jumpName && profile.jump ? { jump: profile.jump } : {}) });
    }
    const direct = storedArray<DirectTelnetNode>('direct-telnet-nodes', isDirectTelnetNode);
    const web = storedArray<WebTelnetNode>('web-telnet-nodes', isWebTelnetNode);
    localStorage.setItem('direct-telnet-nodes', JSON.stringify([...direct, ...transfer.directTelnetNodes.map(node => ({ ...node, id: crypto.randomUUID(), name: node.name || `${node.host}:${node.port}` }))]));
    localStorage.setItem('web-telnet-nodes', JSON.stringify([...web, ...transfer.webTelnetNodes.map(node => ({ ...node, id: crypto.randomUUID(), name: node.name || node.address }))]));
    window.dispatchEvent(new Event('connection-config-imported'));
    const updated = await api.settings();
    setProfiles(updated.profiles); setJumpProfiles(updated.jumpProfiles);
    setConnectionTransferMessage(`已追加导入 ${transfer.sshProfiles.length} 个 SSH 连接、${transfer.directTelnetNodes.length + transfer.webTelnetNodes.length} 个 Telnet 节点；密码和令牌未导入，请重新填写`);
  }

  async function selectJump(name: string) {
    profileLoadToken.current++;
    const token = ++jumpLoadToken.current;
    if (!name) { setProfile(p => ({ ...p, jumpName: undefined, jump: { ...defaultJump, name: '', enabled: Boolean(p.jump?.enabled) } })); return; }
    const loaded = await api.loadJumpProfile(name);
    if (token === jumpLoadToken.current) setProfile(p => ({ ...p, jumpName: name, jump: { ...defaultJump, ...loaded, enabled: Boolean(p.jump?.enabled) } }));
  }
  async function importServerAsJump(name: string) {
    if (!name) return;
    const token = ++jumpLoadToken.current;
    const loaded = await api.importServerAsJump(name);
    if (token !== jumpLoadToken.current) return;
    setProfile(p => ({ ...p, jumpName: undefined, jump: { ...defaultJump, ...loaded, enabled: true } }));
  }
  async function saveJumpCurrent() {
    const name = (jumpConfig.name || '').trim();
    const updated = await api.saveJumpProfile({ ...jumpConfig, name });
    setJumpProfiles(updated);
    setProfile(p => ({ ...p, jumpName: name, jump: { ...p.jump, ...updated.find(item => item.name === name)!, password: p.jump?.password || '', enabled: Boolean(p.jump?.enabled) } }));
  }
  async function selectProfile(name: string) {
    jumpLoadToken.current++;
    const token = ++profileLoadToken.current;
    setSelectedProfile(name);
    if (!name) { setProfile(initial); setConnectionSettings(true); return; }
    const metadata = profiles.find(item => item.name === name);
    if (metadata) setProfile({ ...initial, ...metadata, password: '' });
    const loaded = await api.loadProfile(name);
    if (token === profileLoadToken.current) setProfile({ ...initial, ...loaded });
  }
  async function saveCurrentProfile(value = profile) {
    const name = value.name || value.host;
    const updated = await api.saveProfile({ ...value, name });
    setProfiles(updated); setSelectedProfile(name); setProfile(p => { const saved = updated.find(item => item.name === name); return { ...p, ...saved, name, jump: saved?.jump ? { ...p.jump, ...saved.jump } : p.jump }; });
  }
  async function deleteCurrentProfile() {
    const updated = await api.deleteProfile(selectedProfile);
    if (!updated) return;
    profileLoadToken.current++; jumpLoadToken.current++;
    setProfiles(updated); setSelectedProfile(''); setProfile(initial);
    setMessage('连接配置已删除');
  }
  async function deleteCurrentJump() {
    const name = profile.jumpName;
    if (!name) return;
    const updated = await api.deleteJumpProfile(name);
    if (!updated) return;
    profileLoadToken.current++; jumpLoadToken.current++;
    setProfiles(updated.profiles); setJumpProfiles(updated.jumpProfiles);
    setProfile(p => ({ ...p, jumpName: undefined, jump: { ...defaultJump, enabled: Boolean(p.jump?.enabled) } }));
    setMessage('跳板机配置已删除');
  }
  function sameWord(a: string, b: string) { return sensitive ? a === b : a.toLocaleLowerCase() === b.toLocaleLowerCase(); }
  function highlightWord(text: string) {
    setExtraHighlights(previous => previous.some(word => sameWord(word, text)) ? previous : [...previous.slice(-31), text]);
    setSuppressedHighlights(previous => previous.filter(word => !sameWord(word, text)));
    setContextMenu(null);
  }
  function unhighlightWord(text: string) {
    setExtraHighlights(previous => previous.filter(word => !sameWord(word, text)));
    setSuppressedHighlights(previous => [...previous.filter(word => !sameWord(word, text)), text]);
    setContextMenu(null);
  }
  function clearFilter() {
    if (filtering) { searchToken.current = ''; setFiltering(false); void api.cancelSearch().catch(fail); }
    setFilter(null); setContextMenu(null);
    if (doc) void run(() => api.clearFilter(doc.id));
    go(0);
  }
  function goOriginal(line: number) {
    if (filtering) { searchToken.current = ''; setFiltering(false); void api.cancelSearch().catch(fail); }
    setFilter(null);
    if (doc) void api.clearFilter(doc.id).catch(fail);
    go(line);
  }
  async function filterWord(text: string) {
    if (!doc?.ready) return;
    const token = crypto.randomUUID(); searchToken.current = token;
    setContextMenu(null); setFiltering(true); setSearching(false); setResults(null); setError('');
    setFollowing(false); followingRef.current = false;
    try {
      const response = await api.filter(doc.id, text, sensitive, token);
      if (searchToken.current !== token) return;
      setFilter(response); highlightWord(text); go(0);
      setMessage(`筛选完成 · ${response.total.toLocaleString()} 个匹配行${response.capped ? ' · 仅展示前 100 万行' : ''}`);
    } catch (e) { if (searchToken.current === token) fail(e); }
    finally { if (searchToken.current === token) setFiltering(false); }
  }

  async function list(path: string) {
    const response = await api.list(path);
    setFileSource('remote'); setDirectory(response.path); setPathInput(response.path); setEntries(response.entries); setSelectedFile(''); if (filenameFromSelection) { setFilePattern(selectionListPattern); setFilenameFromSelection(false); }
  }
  async function showLocalPicker(path?: string) {
    const listing = await api.browseLocalSelection(path);
    setLocalPicker(listing); setPickerPath(listing.path); setPickerSelection('');
  }
  async function selectLocal(file: string) {
    const result = await api.selectLocalPath(file);
    setLocalListing(result.listing); setLocalPathInput(result.listing.path); setFileSource('local');
    setSelectedFile(result.kind === 'file' ? result.path : '');
    setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern('');
    setLocalPicker(null);
    if (result.kind === 'file') await open(() => api.openLocalFile(result.path));
    else { setSearchScope('folder'); setMessage(`本地文件夹 · ${result.listing.entries.filter(entry => !entry.directory).length} 个文件`); }
  }
  async function browseLocal(path?: string) {
    const response = path ? await api.listLocal(path) : await api.chooseLocalFolder();
    if (!response) return;
    setLocalListing(response); setLocalPathInput(response.path); setFileSource('local'); setSelectedFile('');
    setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope('folder');
    setMessage(`本地文件夹 · ${response.entries.filter(entry => !entry.directory).length} 个文件`);
  }
  async function browse(path: string) { if (localMode) await browseLocal(path); else await list(path); }
  function viewFile(file: string) { return localMode ? api.openLocalFile(file) : api.openRemote(file); }
  function refreshDownloadedFiles() { void api.downloadedFiles().then(setDownloadedPaths).catch(fail); }
  useEffect(() => { refreshDownloadedFiles(); }, [directories.download, directories.extract]);
  function processEvent(e: ViewerEvent) {
    if (e.type === 'local-files-changed') { refreshDownloadedFiles(); return; }
    if (e.type === 'connection-progress') { setMessage(e.message || '正在连接'); return; }
    if (e.type === 'task') { if (e.state !== 'running') {
      refreshDownloadedFiles();
      if (e.kind?.includes('下载')) {
        const paths = e.paths?.length ? e.paths : e.kind === '下载' && e.destination ? [e.destination] : [];
        if (paths.length) setAutoExpandPaths(paths);
      }
    } setTask(previous => previous?.id === e.id ? { ...previous, ...e } : e); return; }
    if (e.type === 'disconnected') { searchToken.current = ''; setSearching(false); setFiltering(false); setConnection(''); if (!localMode) setEntries([]); setFollowing(false); followingRef.current = false; setDoc(null); docRef.current = null; setFilter(null); setContextMenu(null); setMessage(e.message || 'SSH 连接已断开'); return; }
    if (e.type === 'connection-error') { setError(e.error || 'SSH 连接错误'); return; }
    if (['search-progress', 'batch-search-progress'].includes(e.type) && e.requestId === searchToken.current && e.result) {
      const update = e.result;
      setResults(previous => ({ ...previous, ...update, matches: [...(previous?.matches || []), ...update.matches].slice(0, 10000) }));
    }
    if (e.type === 'batch-search-progress' && e.requestId === searchToken.current) { setMessage(`${e.source === 'local' ? '本地搜索' : '远程搜索'} ${e.fileIndex}/${e.files} · ${e.file} · ${size(e.bytes)}`); return; }
    if (e.id !== docRef.current?.id) return;
    if (e.type === 'ready') {
      const wasReady = docRef.current!.ready;
      const updated = { ...docRef.current!, ...e, ready: true } as Doc;
      docRef.current = updated; setDoc(updated);
      setMessage(`全文就绪 · ${updated.lines.toLocaleString()} 行 · ${size(updated.size)}`);
      if (!wasReady || pendingJump.current !== null || (followingRef.current && atBottomRef.current)) go(pendingJump.current ?? updated.lines);
      pendingJump.current = null;
    } else if (e.type === 'cache-progress') setMessage(`缓存日志 ${size(e.bytes)} / ${size(e.size)}`);
    else if (e.type === 'index-progress') setMessage(`建立行索引 ${size(e.bytes)} / ${size(e.size)}`);
    else if (e.type === 'search-progress' && e.requestId === searchToken.current) setMessage(`搜索中 · ${size(e.bytes)} / ${size(e.size)} · ${e.count} 条匹配`);
    else if (e.type === 'filter-progress' && e.requestId === searchToken.current) setMessage(`筛选中 · ${size(e.bytes)} / ${size(e.size)} · ${e.count} 个匹配行`);
    else if (e.type === 'document-error') { setError(e.error || '读取失败'); setFollowing(false); followingRef.current = false; }
    else if (e.type === 'rotated') { setFollowing(false); followingRef.current = false; setError('检测到日志截断或替换，请重新打开文件'); }
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
      if (!api) return;
    api.settings().then(async s => { setFeatureEnabled({ ssh: s.sshEnabled !== false, telnet: s.telnetEnabled !== false }); if (!historyTouched.current) { if (s.searchHistory !== undefined) { searchHistoryRef.current = s.searchHistory; setSearchHistory(s.searchHistory); } else if (searchHistoryRef.current.length) await api.saveSearchHistory(searchHistoryRef.current); } if (s.version !== __APP_VERSION__) setError('界面与后台版本不一致，请关闭旧窗口并重新启动工具'); setDirectories(s.directories); setTheme(resolveTheme(s.theme)); setFont(s.logFont || defaultLogFont); setProfiles(s.profiles); setJumpProfiles(s.jumpProfiles); if (s.localPaths?.length) { setExtractedPaths(s.localPaths); setSearchScope('extracted'); } const name = s.profiles.find(p => p.name === s.selectedProfile)?.name || s.profiles[0]?.name; if (name) await selectProfile(name); else if (s.selectedJump) await selectJump(s.selectedJump); }).catch(fail);
    return api.onEvent(e => {
      if (opening.current && ['ready', 'document-error', 'cache-progress', 'index-progress'].includes(e.type)) pendingEvents.current.push(e);
      else processEvent(e);
    });
  }, []);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: Event) => { if (!(e.target instanceof Element) || !e.target.closest('.text-context-menu')) setContextMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('scroll', dismiss, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('scroll', dismiss, true); document.removeEventListener('keydown', key); };
  }, [contextMenu]);
  async function open(work: () => Promise<Doc | null>, line?: number, keepResults = false, scope?: 'current' | 'extracted' | 'remote' | 'folder') {
    setTelnetPage(false);
    if (opening.current) return;
    opening.current = true; setOpeningState(true); pendingEvents.current = [];
    setError('');
    try {
      const result = await work();
      if (!result) return;
      setSearchScope(scope || (result.remote && activePattern ? 'remote' : 'current'));
      docRef.current = result; setDoc(result); setBookmarks(result.bookmarks || []); if (!keepResults) setResults(null); pendingJump.current = line ?? null;
      if (!keepResults) { searchToken.current = ''; setSearching(false); setFiltering(false); }
      setFilter(null); setContextMenu(null); setSelectedLine(null); setFollowing(false); followingRef.current = false;
      go(result.ready ? line ?? result.lines : result.preview?.length || 0);
      setMessage('预览日志末尾 · 后台缓存全文');
      for (const e of pendingEvents.current) processEvent(e);
    } catch (e) { setDoc(null); docRef.current = null; setFollowing(false); followingRef.current = false; fail(e); }
    finally { opening.current = false; setOpeningState(false); pendingEvents.current = []; }
  }
  async function search(text = query, useRegex = regex) {
    text = text.trim();
    if (!text || opening.current || (searchScope === 'folder' && (!localListing || !!patternError)) || (searchScope === 'current' && !doc?.ready) || (searchScope === 'extracted' && !extractedPaths.length) || (searchScope === 'remote' && (!connection || !activePattern))) return;
    setBottomOpen(true);
    if (searching || filtering) {
      searchToken.current = '';
      setSearching(false); setFiltering(false);
      await api.cancelSearch();
      if (doc && filter) await api.clearFilter(doc.id);
      setFilter(null);
    }
    setResultContext({ query: text, file: doc?.name || '', regex: useRegex, caseSensitive: sensitive, partial: true });
    const token = crypto.randomUUID(); searchToken.current = token; setSearching(true); setFiltering(false); setResults(null); setSideTab('search'); setError('');
    try {
      if (text.length > 2048) throw new Error('搜索内容不得超过 2048 字符');
      if (useRegex) new RegExp(text, sensitive ? '' : 'i');
      if (text.trim()) await persistSearchHistory([text, ...searchHistoryRef.current.filter(item => item !== text)].slice(0, 30));
      if (searchToken.current !== token) return;
      const response = searchScope === 'folder' ? await api.searchLocalFiles(localListing!.path, activePattern, text, { regex: useRegex, caseSensitive: sensitive }, token) : searchScope === 'extracted' ? await api.searchExtracted(extractedPaths, text, { regex: useRegex, caseSensitive: sensitive }, token) : searchScope === 'remote' ? await api.searchFiles(directory, activePattern, text, { regex: useRegex, caseSensitive: sensitive }, token) : await api.search(doc!.id, text, { regex: useRegex, caseSensitive: sensitive }, token);
      if (searchToken.current !== token) return;
      setResultContext(previous => ({ ...previous, partial: false }));
      if (response.source === 'local') { if (response.paths) setExtractedPaths(response.paths); setSearchScope(searchScope === 'folder' ? 'folder' : 'extracted'); } setResults(response); setMessage(`搜索完成 · ${response.count.toLocaleString()} 条匹配${response.files !== undefined ? ` · ${response.searchedFiles}/${response.files} 个文件` : ''}`); if (response.errors?.length) setError(response.errors.join('；'));
    } catch (e) { if (searchToken.current === token) fail(e); }
    finally { if (searchToken.current === token) { searchToken.current = ''; setSearching(false); } }
  }
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && (searching || filtering)) { event.preventDefault(); void cancelSearch(); return; }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f' || event.isComposing) return;
      event.preventDefault(); setContextMenu(null);
      const selection = window.getSelection();
      const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
      const focus = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
      const selected = anchor?.closest('.log-viewport') && focus?.closest('.log-viewport') ? selection?.toString() || '' : '';
      searchInput.current?.focus();
      if (selected) {
        setQuery(selected); setRegex(false); setSuppressedHighlights(previous => previous.filter(word => !sameWord(word, selected)));
        void search(selected, false);
      } else searchInput.current?.select();
    };
    document.addEventListener('keydown', find);
    return () => document.removeEventListener('keydown', find);
  });
  async function cancelSearch() { const wasFiltering = filtering; searchToken.current = ''; setSearching(false); setFiltering(false); await api.cancelSearch(); if (doc && !filter) await api.clearFilter(doc.id); setMessage(wasFiltering ? '筛选已取消' : '搜索已取消'); }
  async function saveMark() {
    if (!doc || selectedLine === null) return;
    const updated = [...bookmarks.filter(b => b.line !== selectedLine), { line: selectedLine, note: note || '书签', color }].sort((a, b) => a.line - b.line);
    await api.saveBookmarks(doc.bookmarkKey, updated); setBookmarks(updated); setSideTab('marks'); setBottomOpen(true); setNote('');
  }
    async function extract(file?: string) {
    await run(async () => {
      const result = await api.extract(file, Boolean(file && localMode));
      if (!result) return;
      setExtractedPaths(result.paths);
      if (result.openPath) await open(() => api.openExtracted(result.openPath!), undefined, false, 'extracted');
      else setMessage('解压完成 · 归档内没有文件');
    });
  }
  async function extractLocalMatches() {
    await run(async () => {
      const result = await api.extractLocalMatches(browseDirectory, activePattern);
      setExtractedPaths(result.paths);
      if (result.paths.length) setSearchScope('extracted');
      if (result.openPath) await open(() => api.openExtracted(result.openPath!), undefined, false, 'extracted');
      setMessage(`本地批量解压${result.cancelled ? '已取消' : '完成'} · 成功 ${result.completedFiles} 个 · 失败 ${result.failedFiles} 个`);
      if (result.errors.length) setError(result.errors.join('；'));
    });
  }
  async function transferMatches(unpack: boolean) {
    await run(async () => {
      const result = await api.batchTransfer(directory, activePattern, unpack);
      setExtractedPaths(result.paths); if (result.paths.length) setSearchScope('extracted');
      if (result.errors.length) setError(result.errors.join('；'));
      if (result.openPath) await open(() => api.openExtracted(result.openPath!), undefined, false, 'extracted');
      setMessage(`批量处理${result.cancelled ? '已取消' : '完成'} · 成功 ${result.completedFiles} 个 · 失败 ${result.failedFiles} 个`);
      if (result.errors.length) setError(result.errors.join('；'));
    });
  }
  async function exportResults() {
    if (!results?.matches.length || exporting) return;
    const snapshot = { ...results, matches: [...results.matches], ...resultContext };
    setExporting(true);
    try {
      const exported = await api.exportSearchResults(snapshot);
      if (exported) setMessage(`已导出 ${exported.count} 条搜索结果 · ${exported.path}`);
    } catch (error) { fail(error); }
    finally { setExporting(false); }
  }
  function highlightSearchTerms() {
    if (regex || !query) return;
    const terms = query.split('*').map(part => part.trim()).filter(Boolean).slice(0, 32);
    if (!terms.length) return;
    setExtraHighlights(previous => [...new Set([...previous, ...terms])].slice(-32));
    setSuppressedHighlights(previous => previous.filter(word => !terms.some(term => sameWord(term, word))));
  }
  async function navigateResult(direction: number) {
    if (!results?.matches.length || openingState) return;
    const index = ((resultIndex < 0 ? (direction > 0 ? -1 : 0) : resultIndex) + direction + results.matches.length) % results.matches.length;
    setResultIndex(index);
    await jumpResult(results.matches[index]);
  }
  useEffect(() => { setResultIndex(-1); }, [query, searchScope]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('.telnet-page') || directorySettings || fontSettings || e.repeat) return;
      const key = [e.ctrlKey ? 'Ctrl' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
      if (key === shortcuts.next || key === shortcuts.previous) {
        e.preventDefault(); void navigateResult(key === shortcuts.next ? 1 : -1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
  async function jumpResult(match: Match) {
    jumpSearch.current = { query: resultContext.query, regex: resultContext.regex, caseSensitive: resultContext.caseSensitive };
    setTelnetPage(false);
    setFollowing(false); followingRef.current = false;
    if (doc) void api.follow(false).catch(fail);
    highlightSearchTerms();
    if (match.file && (doc?.name !== match.file || Boolean(doc.remote) !== (match.source !== 'local'))) await open(() => match.source === 'local' ? api.openExtracted(match.file!) : api.openRemote(match.file!), match.line, true, match.source === 'local' ? searchScope === 'folder' ? 'folder' : 'extracted' : 'remote');
    else goOriginal(match.line);
  }
  function applyDateWildcard() {
    const source = filePattern || selectedFile.split('/').pop() || '';
    const match = source.match(/(\d{4})[._-](\d{2})[._-](\d{2})/);
    if (!match) { setError('未识别到日期，请输入包含 YYYY-MM-DD、YYYY.MM.DD 或 YYYY_MM_DD 的文件名'); return; }
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    const prefix = source.slice(0, match.index || 0);
    setFilePattern(`${prefix}${date}.*`); setFilenameFromSelection(false); setSelectionListPattern(''); setSelectedFile('');
    setSearchScope(localMode ? 'folder' : connection ? 'remote' : 'current'); setError('');
  }
  let visibleEntries = browseEntries;
  let patternError = '';
  if (activePattern) {
    try { const matcher = filenamePattern(activePattern); visibleEntries = browseEntries.filter(entry => entry.directory || matcher.test(entry.name)); }
    catch (e) { patternError = e instanceof Error ? e.message : String(e); }
  }
  const matchedFileCount = visibleEntries.filter(entry => !entry.directory).length;
  const matchedArchiveCount = visibleEntries.filter(entry => !entry.directory && /\.(gz|zip|tgz|tar)$/i.test(entry.name)).length;
  const selectedEntry = browseEntries.find(entry => join(browseDirectory, entry.name) === selectedFile);
  const canExtractSelection = Boolean(selectedEntry && !selectedEntry.directory && /\.(gz|zip|tgz|tar)$/i.test(selectedEntry.name));
  if (!api) return <div className="browser-warning">请通过桌面程序启动。<code>npm run build && npm start</code></div>;

  return <div className="app" style={{ '--log-font-family': logFontFamily(font.family), '--log-font-size': `${font.size}px`, '--log-line-height': `${logLineHeight(font.size)}px`, '--result-line-height': `${resultLineHeight(font.size)}px` } as React.CSSProperties}>
    <header className="header"><div className="brand"><span className="brand-icon">⌁</span><div><strong>SSH Log Viewer</strong><small>远程日志工作台 · v{__APP_VERSION__}</small></div></div><span className={`connection-pill ${connection ? 'connected' : ''}`}><i />{connection || '本地模式 / 未连接'}</span><div className="header-actions"><button className={!telnetPage ? 'primary' : ''} onClick={() => setTelnetPage(false)}>日志查看</button>{(['ssh', 'telnet'] as const).filter(mode => featureEnabled[mode]).map(mode => <button key={mode} disabled={modeSwitching || disconnecting} className={telnetPage && terminalMode === mode ? 'primary' : ''} aria-pressed={telnetPage && terminalMode === mode} onClick={() => void showTerminal(mode)}>{mode === 'ssh' ? 'SSH' : 'Telnet'} 输出</button>)}<button onClick={() => void run(() => showLocalPicker(localListing?.path))} disabled={openingState}>打开本地文件/文件夹</button><button onClick={() => setDirectorySettings(true)}>设置</button></div></header>
    <UpdateControl settingsOpen={directorySettings} />
    <div className="workspace">
      <aside className="left-panel" style={{ display: featureEnabled.ssh || featureEnabled.telnet ? undefined : 'none' }}>
        {featureEnabled.ssh && <><div className="panel-title">连接管理 <span>SSH / SFTP</span></div>
        <select aria-label="已保存连接" disabled={!featureEnabled.ssh} value={selectedProfile} onChange={e => void run(() => selectProfile(e.target.value))}><option value="">新建连接…</option>{profiles.map(p => <option key={p.name} value={p.name}>{p.jump?.enabled ? '【跳板连接】' : '【直连】'}{p.name} · {p.username}@{p.host}:{p.port}{p.jump?.enabled ? ` · 经 ${p.jumpName || p.jump.name || p.jump.host}` : ''}</option>)}</select>
        <div className="connection-actions"><button className="primary" disabled={!featureEnabled.ssh || connecting || disconnecting} onClick={() => void run(async () => { if (!featureEnabled.ssh) return; if (!profile.host.trim() || !profile.username.trim() || (profile.auth === 'password' && !profile.password && !profile.hasPassword) || (profile.auth === 'key' && !profile.keyPath)) { setConnectionSettings(true); setError('请在连接设置中补全主机、用户名和认证信息。'); return; } if (profile.jump?.enabled && (profile.jump.auth === 'password' || !profile.jump.auth) && !profile.jump.password && !profile.jump.hasPassword) { setJumpSettings(true); setError('请在“跳板机密码”中输入登录密码，再保存并使用。连接设置中的密码用于目标机器。'); return; } setConnecting(true); searchToken.current = ''; setFiltering(false); setSearching(false); setFilter(null); setContextMenu(null); setDoc(null); docRef.current = null; setConnection(''); try { const c = await api.connect(profile); setConnection(c.name); setConnectionSettings(false); await saveCurrentProfile(profile); setProfile(p => ({ ...p, password: p.rememberPassword ? p.password : '', passphrase: '', jump: p.jump ? { ...p.jump, password: p.jump.rememberPassword ? p.jump.password : '', passphrase: '' } : undefined })); await list(defaultLogDirectory); } finally { setConnecting(false); } })}>{connecting ? '连接中…' : '连接'}</button>{connecting && <button onClick={() => void run(() => api.disconnect())}>取消连接</button>}{connection && <button disabled={disconnecting} onClick={() => void run(async () => { setDisconnecting(true); try { await api.disconnect(); } finally { setConnection(''); setDoc(null); docRef.current = null; setEntries([]); setDisconnecting(false); } })}>{disconnecting ? '断开中…' : '断开'}</button>}<button className={`connection-settings-toggle ${connectionSettings ? 'active' : ''}`} aria-expanded={connectionSettings} aria-controls="connection-settings" onClick={() => setConnectionSettings(value => !value)}>⚙ 设置</button></div>
        {connectionSettings && <div id="connection-settings" className="connection-form" role="region" aria-label="连接设置">
          <div className="connection-settings-heading">连接设置 <span>目标服务器与认证</span></div>
          <div className="connection-mode" role="radiogroup" aria-label="连接方式"><label><input type="radio" name="connection-mode" aria-label="本地连接" checked={!jumpConfig.enabled} onChange={() => updateJump({ enabled: false })} />直接连接</label><label><input type="radio" name="connection-mode" aria-label="通过跳板机连接" checked={jumpConfig.enabled} onChange={() => { jumpLoadToken.current++; setProfile(p => ({ ...p, host: '127.0.0.1', port: 2223, username: 'root', auth: 'password', password: '', hasPassword: false, passphrase: '', jump: { ...defaultJump, ...p.jump, enabled: true } })); }} />通过跳板机连接</label></div>
          {jumpConfig.enabled && <div className="jump-source-picker"><label>通过哪台服务器连接<select aria-label="选择跳板机" value={profile.jumpName ? 'jump:' + profile.jumpName : profile.jump?.name && profiles.some(item => item.name === profile.jump?.name) ? 'server:' + profile.jump.name : ''} onChange={e => { const value = e.target.value; if (value === '__manual__') { setJumpSettings(true); return; } void run(() => value.startsWith('server:') ? importServerAsJump(value.slice(7)) : selectJump(value.slice(5))); }}><option value="" disabled>选择已保存的服务器…</option><optgroup label="已保存服务器">{profiles.map(item => <option key={item.name} value={'server:' + item.name}>{item.name} · {item.host}:{item.port}</option>)}</optgroup>{jumpProfiles.length > 0 && <optgroup label="已有跳板机">{jumpProfiles.map(item => <option key={item.name} value={'jump:' + item.name}>{item.name} · {item.host}:{item.port}</option>)}</optgroup>}<option value="__manual__">手动配置其他跳板机…</option></select></label><small className="hint">{jumpConfig.host ? `经 ${jumpConfig.host}:${jumpConfig.port} 连接下方目标服务器` : '自动复用所选服务器的账号和认证信息'}</small></div>}
          <div className="connection-target-title">目标服务器{jumpConfig.enabled && <small>填写跳板机可访问的地址，反向隧道使用 127.0.0.1 和隧道端口</small>}</div>
          <label>连接名称<input value={profile.name} placeholder="生产服务器" onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
          <div className="host-fields"><label>主机<input value={profile.host} placeholder="192.168.1.100" onChange={e => setProfile({ ...profile, host: e.target.value })} /></label><label>端口<input type="number" value={profile.port} onChange={e => setProfile({ ...profile, port: +e.target.value })} /></label></div>
          <label>用户名<input value={profile.username} placeholder="用户名" onChange={e => setProfile({ ...profile, username: e.target.value })} /></label>
          <label>认证方式<select value={profile.auth} onChange={e => setProfile({ ...profile, auth: e.target.value })}><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></label>
          {profile.auth === 'password' && <><label>密码<input type="password" value={profile.password} onChange={e => setProfile({ ...profile, password: e.target.value })} /></label><label className="remember-password"><input type="checkbox" checked={profile.rememberPassword ?? true} onChange={e => setProfile({ ...profile, rememberPassword: e.target.checked })} />保存密码</label></>}
          {profile.auth === 'key' && <><label>私钥文件<div className="inline"><input value={profile.keyPath} onChange={e => setProfile({ ...profile, keyPath: e.target.value })} /><button onClick={() => void run(async () => { const p = await api.chooseKey(); if (p) setProfile({ ...profile, keyPath: p }); })}>选择</button></div></label><label>私钥口令<input type="password" value={profile.passphrase} onChange={e => setProfile({ ...profile, passphrase: e.target.value })} /></label></>}
          <small className="hint">{profile.auth === 'password' ? '勾选后，保存配置或连接成功时加密保存密码。' : '私钥口令仅用于本次连接，不保存。'}</small>
          <div className="connection-config-actions"><button className="danger-button" disabled={!selectedProfile || connecting} onClick={() => void run(deleteCurrentProfile)}>删除连接</button><button className="save-connection primary" onClick={() => void run(async () => { await saveCurrentProfile(); setMessage('连接配置已保存'); setConnectionSettings(false); })}>保存配置</button></div>
        </div>}
        </>}
        <div id="telnet-connection-slot" className={featureEnabled.ssh ? undefined : 'standalone-telnet'} />
        {featureEnabled.ssh && <><div className="panel-title files-title">{localMode ? '本地文件' : '远程文件'} <div className="file-source-controls"><select aria-label="文件来源" value={fileSource} onChange={e => { const source = e.target.value as 'remote' | 'local'; setFileSource(source); setSelectedFile(''); setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope(source === 'local' ? 'folder' : 'current'); }}><option value="remote">远程</option><option value="local" disabled={!localListing}>本地</option></select><button disabled={!canBrowse} onClick={() => void run(() => browse(browseDirectory))}>↻</button></div></div>
        <form className="path-bar" onSubmit={e => { e.preventDefault(); void run(() => browse(localMode ? localPathInput : pathInput)); }}><input aria-label={localMode ? "本地路径" : "远程路径"} value={localMode ? localPathInput : pathInput} onChange={e => localMode ? setLocalPathInput(e.target.value) : setPathInput(e.target.value)} /><button disabled={!canBrowse}>前往</button></form>
        <div className="file-pattern"><input aria-label="文件名匹配" title={filenameFromSelection ? `${filePattern}（按 Enter 应用匹配）` : filePattern} onKeyDown={e => { if (e.key === 'Enter') { setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope(localMode ? 'folder' : (doc && !doc.remote) || searchScope === 'extracted' ? extractedPaths.length ? 'extracted' : 'current' : filePattern ? 'remote' : 'current'); } }} placeholder="文件名匹配：signal.2026-10-12.*" value={filePattern} onChange={e => { setSelectionListPattern(''); setFilenameFromSelection(false); setFilePattern(e.target.value); setSearchScope(localMode ? 'folder' : (doc && !doc.remote) || searchScope === 'extracted' ? extractedPaths.length ? 'extracted' : 'current' : e.target.value ? 'remote' : 'current'); setSelectedFile(''); }} /><button type="button" title="识别日期并匹配该日期的所有文件" onClick={applyDateWildcard}>日期*</button>{filePattern && <button title="清除文件名匹配" onClick={() => { setSelectionListPattern(''); setFilenameFromSelection(false); setFilePattern(''); setSearchScope(localMode ? 'folder' : 'current'); }}>×</button>}</div>
        {activePattern && <small className="pattern-hint">{patternError || `匹配 ${matchedFileCount} 个文件 · 搜索覆盖匹配日志及 .gz · 支持日期/关键词片段`}</small>}
        {localMode && canBrowse && <div className="batch-actions"><button disabled={!!patternError || !matchedArchiveCount || task?.state === 'running'} onClick={() => void extractLocalMatches()}>解压匹配文件（{matchedArchiveCount}）</button></div>}
        {!localMode && activePattern && <div className="batch-actions"><button disabled={!connection || !!patternError || !matchedFileCount || task?.state === 'running'} onClick={() => void transferMatches(false)}>全部下载</button><button disabled={!connection || !!patternError || !matchedFileCount || task?.state === 'running'} onClick={() => void transferMatches(true)}>全部下载并解压</button></div>}
        <div className="file-list">{canBrowse && <button className="file-entry" disabled={localMode && browseDirectory === localListing?.root} onClick={() => void run(() => browse(join(browseDirectory, '..')))}>↰ 上级目录</button>}{visibleEntries.map(entry => <button key={entry.name} className={`file-entry ${selectedFile === join(browseDirectory, entry.name) ? 'selected' : ''}`} title={`${entry.name}\n${new Date(entry.mtime * 1000).toLocaleString()}`} onClick={() => { setSelectedFile(join(browseDirectory, entry.name)); if (!entry.directory) { setSelectionListPattern(activePattern); setFilePattern(entry.name); setFilenameFromSelection(true); } }} onDoubleClick={() => entry.directory ? void run(() => browse(join(browseDirectory, entry.name))) : void open(() => viewFile(join(browseDirectory, entry.name)))}><span className={entry.directory ? 'folder' : 'file'}>{entry.directory ? '▸' : '≡'}</span><span>{entry.name}</span><small>{entry.directory ? '' : size(entry.size)}</small></button>)}{!canBrowse && <p className="empty-inline">{localMode ? '请打开本地文件夹' : '连接后浏览远程目录'}</p>}{canBrowse && !visibleEntries.length && <p className="empty-inline">没有匹配的文件</p>}</div>
        {task && <div className="task-card"><strong>{task.kind} · {task.state === 'running' ? '进行中' : task.state === 'done' ? '完成' : task.state === 'cancelled' ? '已取消' : '失败'}</strong>{task.files !== undefined && <small>{task.fileIndex ? `${task.fileIndex}/${task.files} · ${task.phase || ''} · ${task.file || ''}` : `共 ${task.files} 个文件`} · 成功 {task.completedFiles || 0} · 失败 {task.failedFiles || 0}</small>}{task.currentBytes !== undefined && task.state === 'running' && <small>当前文件 {size(task.currentBytes)}{task.currentSize ? ` / ${size(task.currentSize)}` : ''}</small>}<span>{size(task.bytes)}{task.size ? ` / ${size(task.size)}` : ''}</span>{task.origin && <small title={task.origin}>来源：{task.origin}</small>}{task.destination && <small>{task.destination}</small>}{task.error && <small>{task.error}</small>}{task.state !== 'running' && extractedPaths.length > 0 && <select aria-label={task.kind?.includes('解压') ? '打开解压文件' : '打开已下载文件'} value="" onChange={e => e.target.value && void open(() => api.openExtracted(e.target.value), undefined, false, 'extracted')}><option value="">打开已下载/解压文件…</option>{extractedPaths.map(file => <option key={file} value={file}>{file.split('/').pop()}</option>)}</select>}{task.state === 'running' && <button onClick={() => void run(() => api.cancelTask(task.id!))}>取消任务</button>}</div>}
        <div className="file-actions"><button disabled={!selectedFile || openingState} onClick={() => void open(() => viewFile(selectedFile))}>查看</button><button disabled={localMode || !selectedFile} onClick={() => void run(async () => { const result = await api.download(selectedFile) as { destination: string } | null; if (result) { setExtractedPaths([result.destination]); setSearchScope('extracted'); } })}>下载</button><button disabled={task?.state === 'running' || (localMode && !selectedFile ? !!patternError || !matchedArchiveCount : !canExtractSelection)} title={localMode && !selectedFile ? '解压当前列表中所有匹配的压缩文件' : '解压选中的压缩文件'} onClick={() => void (localMode && !selectedFile ? extractLocalMatches() : extract(selectedFile))}>{localMode && !selectedFile ? '解压匹配' : '解压'}</button></div>
        </>}
      </aside>
      <main className={'main-panel unified-terminal ' + (telnetPage ? 'show-telnet' : 'show-log')}>
        <div className="log-view-section">
        <div className="document-bar"><span className="file-badge">LOG</span><strong title={doc ? `${doc.name}${doc.archive ? `\n来源压缩文件：${doc.archive}` : ''}` : undefined}>{doc ? doc.remote ? doc.name : doc.name.replace(/\\/g, '/').split('/').pop() : '尚未打开日志'}</strong>{doc?.archive && <span className="source-origin" title={`来源压缩文件：${doc.archive}`}>本地解压 · {doc.archive.replace(/\\/g, '/').split('/').pop()}</span>}{doc?.origin && <span className="source-origin" title={doc.origin}>来源：{doc.origin}</span>}{doc && <span>{size(doc.size)} · {doc.ready ? `${doc.lines.toLocaleString()} 行` : '缓存中'}</span>}</div>
        <form className="search-bar" onSubmit={e => { e.preventDefault(); void search((e.currentTarget.elements.namedItem('search-query') as HTMLInputElement)?.value ?? query, regex); }}><span>⌕</span><SearchHistoryInput inputRef={searchInput} query={query} onChange={setQuery} history={searchHistory} onClear={() => void persistSearchHistory([]).catch(fail)} /><label><input type="checkbox" checked={sensitive} onChange={e => setSensitive(e.target.checked)} />Aa</label><label><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} />正则</label><button className="primary" disabled={(searchScope === 'folder' && (!localListing || !!patternError)) || (searchScope === 'current' && !doc?.ready) || (searchScope === 'extracted' && !extractedPaths.length) || (searchScope === 'remote' && (!activePattern || !connection || !!patternError || !matchedFileCount)) || openingState || !query || searching || filtering}>搜索全文</button>{(searching || filtering) && <button type="button" onClick={() => void cancelSearch()}>取消</button>}</form>
        <div className="search-scope"><label>搜索范围<select aria-label="搜索范围" value={searchScope} onChange={e => { setSearchScope(e.target.value as 'current' | 'extracted' | 'remote' | 'folder'); }}><option value="current">当前打开文件{doc && !doc.remote ? '（本地）' : ''}</option><option value="extracted" disabled={!extractedPaths.length}>已下载/解压文件（本地 {extractedPaths.length} 个）</option><option value="folder" disabled={!localListing || !localMode}>本地文件夹（当前目录匹配文件）</option><option value="remote" disabled={localMode || !connection || !activePattern}>匹配文件（优先本地）</option></select></label><small>{searchScope === 'folder' ? '搜索本地当前目录的匹配文件，支持普通日志和 .gz；不包含子目录' : searchScope === 'extracted' ? '直接搜索已下载或解压的本地文件，不重新下载' : searchScope === 'remote' ? '优先使用该连接已下载的匹配文件；无本地副本时读取远程' : '仅搜索当前打开的日志'} · 优先搜索范围内当前打开的文件 · 普通搜索支持 * 通配</small></div>
        <div className="log-toolbar"><label>高亮<input value={rules} onChange={e => { setRules(e.target.value); setSuppressedHighlights([]); }} placeholder="多个关键词用逗号分隔" /></label><div className="toolbar-right"><button onClick={() => { setError(''); setFontDraft(font); setFontSettings(true); }}>字体设置</button><button disabled={!doc} onClick={() => go(0)}>首行</button><button disabled={!doc} onClick={() => go(doc?.ready ? doc.lines : doc?.preview?.length || 0)}>末尾</button><input className="jump-input" aria-label="跳转行号" placeholder="行号" value={jumpInput} onChange={e => setJumpInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && doc?.ready) goOriginal(Math.max(0, (Number(jumpInput) || 1) - 1)); }} /><button disabled={!doc?.ready} onClick={() => goOriginal(Math.max(0, (Number(jumpInput) || 1) - 1))}>跳转</button><button className={following ? 'primary' : ''} aria-pressed={following} disabled={!doc?.ready || doc.compressed || openingState || !!filter || filtering} onClick={() => { const value = !following; setFollowing(value); followingRef.current = value; void run(async () => { try { await api.follow(value); if (value && doc) go(doc.lines); } catch (error) { setFollowing(false); followingRef.current = false; throw error; } }); }}>{following ? '停止跟随' : '实时跟随'}</button></div></div>
        {filter && <div className="filter-bar"><span title={filter.query}>筛选：{filter.query} · {filter.total.toLocaleString()} 个匹配行{filter.capped ? '（仅展示前 100 万行）' : ''}</span><button onClick={clearFilter}>取消筛选</button></div>}
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
        {(['ssh', 'telnet'] as const).map(mode => <div key={mode} id={mode + '-display-slot'} className="shared-telnet-display" style={{ display: telnetPage && terminalMode === mode ? 'flex' : 'none' }} />)}
        {!telnetPage && (doc ? <LogView selectedLine={selectedLine} onBottomChange={bottom => { atBottomRef.current = bottom; }} key={doc.id} rowHeight={logLineHeight(font.size)} doc={doc} filter={filter} onContext={(text, x, y) => setContextMenu({ text, x, y })} words={[...rules.split(/[,，]/).map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 12), ...extraHighlights, ...(!regex && query && query.length <= 2048 ? query.split('*').map(part => part.trim()).filter(Boolean) : [])].filter(word => !suppressedHighlights.some(excluded => sameWord(excluded, word)))} sensitive={sensitive} bookmarks={bookmarks} jump={jump} onSelect={line => { setSelectedLine(line); setSideTab('marks'); setBottomOpen(true); }} onError={setError} /> : <div className="welcome"><div className="welcome-symbol">⌁</div><h1>让远程日志，触手可及</h1><p>连接 SSH 服务器，双击文件开始查看。<br />后台缓存全文，按需显示日志，保持浏览流畅。</p><button className="primary" disabled={openingState} onClick={() => void run(() => showLocalPicker(localListing?.path))}>打开本地文件/文件夹</button><div className="features"><span>分块读取</span><span>全文搜索</span><span>高亮与标注</span><span>下载与解压</span></div></div>)}
      <section className={`bottom-panel ${bottomOpen ? 'expanded' : 'collapsed'}`} aria-label="搜索结果与标注"><div className="side-tabs"><button className={sideTab === 'search' ? 'active' : ''} onClick={() => { setSideTab('search'); setBottomOpen(true); }}>搜索结果 {results ? `(${results.count})` : ''}</button><button className={sideTab === 'marks' ? 'active' : ''} onClick={() => { setSideTab('marks'); setBottomOpen(true); }}>标注 ({bookmarks.length})</button><button disabled={!results?.matches.length || exporting} title="导出当前已展示的匹配结果（含行号和日志内容，不含来源文件名），支持 TXT、CSV、JSON" onClick={() => void exportResults()}>{exporting ? '导出中…' : '导出结果'}</button><button className="panel-toggle" aria-label={bottomOpen ? '收起结果面板' : '展开结果面板'} onClick={() => setBottomOpen(value => !value)}>{bottomOpen ? '收起 ▾' : '展开 ▴'}</button></div>
        {bottomOpen && <div className="bottom-content">{sideTab === 'search' ? <>{results?.files !== undefined && <small className="batch-summary">已搜索 {results.searchedFiles}/{results.files} 个匹配文件 · {results.count.toLocaleString()} 条匹配</small>}{results?.capped && <p className="hint side-hint">仅展示前 10000 条匹配</p>}{!!results?.truncatedLines && <p className="hint side-hint">{results.truncatedLines} 个超长行仅搜索前 1MB</p>}<div className="inline"><button disabled={!results?.matches.length || openingState} title={shortcuts.previous} onClick={() => void navigateResult(-1)}>上一个</button><span>{results?.matches.length ? Math.max(0, resultIndex + 1) : 0} / {results?.matches.length || 0}</span><button disabled={!results?.matches.length || openingState} title={shortcuts.next} onClick={() => void navigateResult(1)}>下一个</button></div><SearchRows onCopy={() => setMessage('已复制搜索结果日志')} onError={setError} searching={searching} rowHeight={resultLineHeight(font.size)} results={results} onJump={match => { setResultIndex(results?.matches.indexOf(match) ?? -1); void jumpResult(match); }} /></> : <><div className="mark-form"><small>{selectedLine === null ? '点击日志行号选择要标注的行' : `标注第 ${selectedLine + 1} 行`}</small><input placeholder="添加备注…" value={note} onChange={e => setNote(e.target.value)} /><div className="inline"><input type="color" aria-label="标注颜色" value={color} onChange={e => setColor(e.target.value)} /><button className="primary" disabled={selectedLine === null || !doc?.ready} onClick={() => void run(saveMark)}>保存标注</button></div></div><div className="result-list">{bookmarks.map(mark => <div className="bookmark" key={mark.line}><button className="result" style={{ borderLeft: `3px solid ${mark.color}` }} onClick={() => goOriginal(mark.line)}><small>第 {mark.line + 1} 行</small><span>{mark.note}</span></button><button title="删除标注" onClick={() => void run(async () => { if (!doc) return; const updated = bookmarks.filter(b => b.line !== mark.line); await api.saveBookmarks(doc.bookmarkKey, updated); setBookmarks(updated); })}>×</button></div>)}</div></>}
</div>}
      </section>
        <div className="status-bar"><i className={searching || filtering || (doc && !doc.ready) ? 'busy' : ''} /><span>{message}</span>{selectedLine !== null && <span>已选第 {selectedLine + 1} 行</span>}</div>
        </div>
        <div className="embedded-telnet">{(['ssh', 'telnet'] as const).filter(mode => featureEnabled[mode]).map(mode => <TerminalPage key={mode} protocol={mode} active={terminalMode === mode && !modeSwitching} sshConnection={connection} outputVisible={telnetPage} settingsOpen={directorySettings} font={font} onShowOutput={() => showTerminal(mode)} />)}</div>
      </main>
      <DownloadedFiles autoExpandPaths={autoExpandPaths} paths={downloadedPaths} roots={[directories.download, directories.extract]} selected={!doc?.remote ? doc?.name : undefined} disabled={openingState} onRefresh={refreshDownloadedFiles} onError={setError} onOpenFolder={folder => void run(async () => { const result = await api.selectLocalPath(folder); setLocalListing(result.listing); setLocalPathInput(result.listing.path); setFileSource('local'); setSearchScope('folder'); setSelectedFile(''); setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern(''); setMessage(`本地文件夹 · ${result.listing.entries.filter(entry => !entry.directory).length} 个文件`); })} onOpen={file => { setExtractedPaths([file]); void open(() => api.openExtracted(file), undefined, false, 'extracted'); }} />

    </div>
    {jumpSettings && <div className="settings-backdrop" onClick={() => setJumpSettings(false)}><section className="directory-settings jump-settings" role="dialog" aria-label="跳板机配置" onClick={e => e.stopPropagation()}><div className="panel-title">跳板机配置<button aria-label="关闭跳板机配置" onClick={() => setJumpSettings(false)}>×</button></div><label>已保存跳板机<select aria-label="已保存跳板机" value={profile.jumpName || ''} onChange={e => void run(() => selectJump(e.target.value))}><option value="">新建跳板机…</option>{jumpProfiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.host}:{item.port}</option>)}</select></label><label>从已有服务器导入<select aria-label="从已有服务器导入" value="" onChange={e => void run(() => importServerAsJump(e.target.value))}><option value="">选择已保存的服务器…</option>{profiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}</select></label><small className="hint">填入服务器地址及认证信息，确认后点击“保存并使用”。</small><label>跳板机名称<input aria-label="跳板机名称" placeholder="例如：办公室跳板机" value={jumpConfig.name || ''} onChange={e => updateJump({ name: e.target.value })} /></label><label>跳板机主机<input aria-label="跳板机主机" value={jumpConfig.host} onChange={e => updateJump({ host: e.target.value })} /></label><label>跳板机端口<input aria-label="跳板机端口" type="number" value={jumpConfig.port} onChange={e => updateJump({ port: Number(e.target.value) })} /></label><label>跳板机用户名<input aria-label="跳板机用户名" value={jumpConfig.username} onChange={e => updateJump({ username: e.target.value })} /></label><label>跳板机认证方式<select aria-label="跳板机认证方式" value={jumpConfig.auth} onChange={e => updateJump({ auth: e.target.value })}><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></label>{jumpConfig.auth === 'password' && <><label>跳板机密码<input aria-label="跳板机密码" type="password" value={jumpConfig.password || ''} onChange={e => updateJump({ password: e.target.value })} /></label><label className="jump-enable"><input type="checkbox" aria-label="保存跳板机密码" checked={jumpConfig.rememberPassword ?? true} onChange={e => updateJump({ rememberPassword: e.target.checked })} />保存跳板机密码</label></>}{jumpConfig.auth === 'key' && <><label>跳板机私钥<div className="inline"><input aria-label="跳板机私钥" value={jumpConfig.keyPath} onChange={e => updateJump({ keyPath: e.target.value })} /><button onClick={() => void run(async () => { const file = await api.chooseKey(); if (file) updateJump({ keyPath: file }); })}>选择私钥</button></div></label><label>跳板机私钥口令<input aria-label="跳板机私钥口令" type="password" value={jumpConfig.passphrase || ''} onChange={e => updateJump({ passphrase: e.target.value })} /></label></>}<p className="hint">不勾选保存密码时，密码仅用于当前会话，重启后需重新输入。连接设置中的主机、端口、用户名和认证信息用于目标机器。已有反向隧道时，目标主机填 127.0.0.1、端口填跳板机上的监听端口。此功能连接已有隧道，目标机器仍需先建立反向隧道。</p>{error && <p className="settings-error">{error}</p>}<div className="inline"><button className="primary" onClick={() => void run(async () => { await saveJumpCurrent(); setJumpSettings(false); })}>保存并使用</button><button className="danger-button" disabled={!profile.jumpName || connecting} onClick={() => void run(deleteCurrentJump)}>删除跳板机</button><button onClick={() => setJumpSettings(false)}>关闭</button></div></section></div>}
    {fontSettings && <div className="settings-backdrop" onClick={() => !fontSaving && setFontSettings(false)}><form className="directory-settings font-settings" role="dialog" aria-label="日志字体设置" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); setFontSaving(true); void run(async () => { const saved = await api.saveLogFont(fontDraft); setFont(saved); setFontSettings(false); }).finally(() => setFontSaving(false)); }}><div className="panel-title">日志字体设置<button type="button" aria-label="关闭字体设置" disabled={fontSaving} onClick={() => setFontSettings(false)}>×</button></div><label>字体名称<input aria-label="日志字体" list="log-font-options" maxLength={100} required value={fontDraft.family} onChange={e => setFontDraft({ ...fontDraft, family: e.target.value })} /></label><datalist id="log-font-options">{['Cascadia Code', 'Consolas', 'DejaVu Sans Mono', 'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', 'Microsoft YaHei'].map(family => <option key={family} value={family} />)}</datalist><label>字号（px）<input aria-label="日志字号" type="number" min={10} max={32} step={1} required value={Number.isNaN(fontDraft.size) ? '' : fontDraft.size} onChange={e => setFontDraft({ ...fontDraft, size: e.target.valueAsNumber })} /></label><p className="hint">可选择或输入本机已安装的字体名称；未安装的字体会使用备用字体。应用后日志正文、搜索结果及 SSH / Telnet 终端同步生效，重启后保留。</p><div className="font-preview" style={{ fontFamily: logFontFamily(fontDraft.family), fontSize: `${Number.isFinite(fontDraft.size) ? Math.max(10, Math.min(32, fontDraft.size)) : 12}px` }}>2026-10-13 12:34:56 INFO 日志字体预览<br />连接成功 · ERROR 0123456789 AaBb</div>{error && <p className="settings-error">{error}</p>}<div className="inline"><button type="button" disabled={fontSaving} onClick={() => setFontDraft({ ...defaultLogFont })}>恢复默认</button><button className="primary" disabled={fontSaving}>{fontSaving ? '保存中…' : '应用并保存'}</button><button type="button" disabled={fontSaving} onClick={() => setFontSettings(false)}>取消</button></div></form></div>}
    {localPicker && <div className="settings-backdrop" onClick={() => setLocalPicker(null)}><section className="directory-settings local-picker" role="dialog" aria-label="打开本地文件或文件夹" onClick={e => e.stopPropagation()}><div className="panel-title">打开本地文件或文件夹<button aria-label="关闭本地选择" onClick={() => setLocalPicker(null)}>×</button></div><form className="path-bar" onSubmit={e => { e.preventDefault(); void run(() => selectLocal(pickerPath)); }}><input aria-label="选择路径" value={pickerPath} onChange={e => setPickerPath(e.target.value)} /><button>打开路径</button></form><div className="file-list"><button className="file-entry" disabled={localPicker.path === localPicker.root} onClick={() => void run(() => showLocalPicker(join(localPicker.path, '..')))}>↰ 上级目录</button>{localPicker.entries.map(entry => <button key={entry.name} className={`file-entry ${pickerSelection === entry.name ? 'selected' : ''}`} onClick={() => setPickerSelection(entry.name)} onDoubleClick={() => void run(() => entry.directory ? showLocalPicker(join(localPicker.path, entry.name)) : selectLocal(join(localPicker.path, entry.name)))}><span className={entry.directory ? 'folder' : 'file'}>{entry.directory ? '▸' : '≡'}</span><span>{entry.name}</span><small>{entry.directory ? '文件夹' : size(entry.size)}</small></button>)}</div><p className="hint">选择文件或文件夹后点击打开；双击文件夹进入目录。未选择项目时打开当前文件夹。</p>{error && <p className="settings-error">{error}</p>}<div className="inline"><button className="primary" disabled={openingState} onClick={() => void run(() => selectLocal(pickerSelection ? join(localPicker.path, pickerSelection) : localPicker.path))}>打开</button><button onClick={() => setLocalPicker(null)}>取消</button></div></section></div>}
    {directorySettings && <div className="settings-backdrop" onClick={() => setDirectorySettings(false)}><section className="directory-settings app-settings" role="dialog" aria-label="设置" onClick={e => e.stopPropagation()}><div className="panel-title settings-heading"><div><strong>设置</strong><small>软件更新与日志模式设置</small></div><button aria-label="关闭目录设置" onClick={() => setDirectorySettings(false)}>×</button></div><div className="settings-groups"><section className="settings-section" aria-labelledby="settings-update-heading"><h2 id="settings-update-heading">软件更新</h2><div className="settings-grid settings-update-grid"><section className="settings-card"><h3>版本与升级</h3><p>检查并安装最新发行版</p><div id="update-settings-slot" /></section></div></section><section className="settings-section" aria-labelledby="settings-log-heading"><h2 id="settings-log-heading">日志模式设置</h2><div className="settings-grid">{(['ssh', 'telnet'] as const).map(mode => <section className="settings-card" key={mode}><div className="settings-card-heading"><div><h3>{mode === 'ssh' ? 'SSH' : 'Telnet'}</h3><p>输出日志与常用命令配置</p></div><label className="feature-toggle"><input type="checkbox" checked={featureEnabled[mode]} onChange={e => { const enabled = e.target.checked; setFeatureEnabled(current => ({ ...current, [mode]: enabled })); if (mode === 'ssh' && !enabled && connection) void run(async () => { await api.disconnect(); setConnection(''); setDoc(null); docRef.current = null; setEntries([]); }); void run(() => api.saveFeatureEnabled(mode, enabled)); }} /><span aria-hidden="true" /></label></div>{featureEnabled[mode] && <div id={mode + '-settings-slot'} className="inline terminal-settings-slot" />}</section>)}<section className="settings-card settings-appearance"><h3>外观</h3><p>选择适合当前环境的界面配色</p><label className="theme-picker"><span className="theme-dot" /><select aria-label="颜色主题" value={theme} onChange={e => { const selected = resolveTheme(e.target.value); setTheme(selected); void run(() => api.saveTheme(selected)); }}>{themes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></section><section className="settings-card settings-shortcuts"><h3>搜索结果快捷键</h3><p>快速切换全文搜索中的匹配结果</p>{(['previous', 'next'] as const).map(action => <label key={action}>{action === 'next' ? '下一个结果' : '上一个结果'}<input aria-label={action === 'next' ? '下一个结果快捷键' : '上一个结果快捷键'} readOnly value={shortcuts[action]} onKeyDown={e => { e.preventDefault(); e.stopPropagation(); if (['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape'].includes(e.key)) return; const key = [e.ctrlKey ? 'Ctrl' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+'); const updated = { ...shortcuts, [action]: key }; if (updated.next === updated.previous) { setError('上一个与下一个结果不能使用相同快捷键'); return; } setShortcuts(updated); localStorage.setItem('viewer-shortcuts', JSON.stringify(updated)); }} /></label>)}<small>点击输入框后按下快捷键，自动保存。</small></section><section className="settings-card settings-storage"><h3>文件存储</h3><p>管理下载文件、解压文件与自动记录的日志</p>{(['download', 'extract'] as const).map(kind => <label key={kind}>{kind === 'download' ? '下载目录' : '解压目录'}<div className="inline"><input aria-label={kind === 'download' ? '默认下载目录' : '默认解压目录'} readOnly value={directories[kind]} /><button onClick={() => void run(async () => setDirectories(await api.chooseDirectory(kind)))}>选择目录</button></div></label>)}<p className="hint">选择后自动保存。下载按IP/远端文件夹名称/下载时间（YYYY-MM-DD_HH）/原文件名保存，同名文件保留已有文件；远程解压按相同层级归档到压缩包名目录，重名添加编号，完成后自动打开日志。</p></section><section className="settings-card settings-connection-transfer"><h3>登录配置迁移</h3><p>导出或导入 SSH、Telnet 的主机和登录配置</p><div className="inline"><button type="button" onClick={() => void run(exportConnectionConfig)}>导出登录配置</button><button type="button" onClick={() => connectionTransferInput.current?.click()}>导入登录配置</button></div><small className="hint">导出文件不包含密码、私钥口令或 Web 令牌；导入后请在对应设置中重新填写。</small>{connectionTransferMessage && <p role="status">{connectionTransferMessage}</p>}<input ref={connectionTransferInput} type="file" accept=".json,application/json" aria-label="导入登录配置文件" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => importConnectionConfig(file)); }} /></section></div></section></div><footer className="settings-footer"><span>设置更改后自动保存</span><button className="primary" onClick={() => setDirectorySettings(false)}>完成</button></footer></section></div>}
    {contextMenu && <div className="text-context-menu" role="menu" aria-label="日志文本操作" style={{ left: Math.max(4, Math.min(contextMenu.x, window.innerWidth - 244)), top: Math.max(4, Math.min(contextMenu.y, window.innerHeight - 208)) }} onPointerDown={e => e.preventDefault()}>
      <div className="context-selection" title={contextMenu.text}>{contextMenu.text}</div>
      <button role="menuitem" onClick={() => highlightWord(contextMenu.text)}>高亮所有该字符串</button>
      <button role="menuitem" disabled={!doc?.ready || filtering || openingState} onClick={() => void filterWord(contextMenu.text)}>仅显示包含该字符串的行</button>
      <button role="menuitem" onClick={() => unhighlightWord(contextMenu.text)}>取消该字符串高亮</button>
      {filter && <button role="menuitem" onClick={clearFilter}>取消筛选，显示全部日志</button>}
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
