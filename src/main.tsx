import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bookmark, Doc, Entry, Profile, Row, SearchResult, ViewerEvent, LogFilter, Match, JumpProfile, LocalListing } from './types';
import { themes, resolveTheme, type ThemeId } from './themes';
import './style.css';
import { filenamePattern } from '../shared/glob.mjs';
import { defaultLogFont, logLineHeight, resultLineHeight, logFontFamily } from '../shared/log-font.mjs';

const api = window.viewer;
const defaultLogDirectory = '/system/log';
const defaultJump: JumpProfile = { enabled: false, host: '', port: 22, username: '', auth: 'password', keyPath: '', password: '', passphrase: '', rememberPassword: true };
const initial: Profile = { name: '', host: '', port: 22, username: '', auth: 'password', keyPath: '', password: '', passphrase: '', rememberPassword: true };
const size = (bytes = 0) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const join = (directory: string, name: string) => `${directory.replace(/\/$/, '')}/${name}`;
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

function LogView({ doc, words, sensitive, bookmarks, jump, filter, onContext, onSelect, onError, rowHeight }: {
  doc: Doc; words: string[]; sensitive: boolean; bookmarks: Bookmark[]; jump: { line: number; token: number };
  onSelect(line: number): void; onError(message: string): void;
  filter: LogFilter | null; onContext(text: string, x: number, y: number): void;
  rowHeight: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const top = Math.min(maxStart, Math.max(0, jump.line)) / Math.max(1, maxStart) * (totalHeight - height);
    if (viewport.current) viewport.current.scrollTop = top;
    setScroll(top);
  }, [jump, doc.id, doc.ready, filter?.token, rowHeight]);
  useEffect(() => {
    let active = true;
    if (!doc.ready) { setRows((doc.preview || []).map((text, line) => ({ text, line }))); return; }
    const timer = setTimeout(() => {
      api.page(doc.id, needed, visibleCount + 70, filter?.token).then(data => { if (active) setRows(data); }).catch(e => { if (active) onError(e.message); });
    }, 20);
    return () => { active = false; clearTimeout(timer); };
  }, [doc.id, doc.lines, doc.ready, filter?.token, needed, visibleCount]);
  const shown = rows.filter(row => (row.position ?? row.line) >= start && (row.position ?? row.line) <= start + visibleCount + 1);
  return <div className="log-viewport" ref={viewport} onScroll={e => setScroll(e.currentTarget.scrollTop)}>
    <div style={{ height: totalHeight, position: 'relative' }}>
      <div className="log-rows" style={{ top: Math.min(scroll, totalHeight - height), height, overflow: 'hidden', overflowAnchor: 'none' }}>
        {shown.map(row => {
          const bookmark = bookmarks.find(b => b.line === row.line);
          const level = /\b(ERROR|FATAL)\b/.test(row.text) ? 'error-line' : /\bWARN(?:ING)?\b/.test(row.text) ? 'warn-line' : '';
          return <div key={row.line} className={`log-row ${level}`} style={{ borderLeftColor: bookmark?.color || 'transparent' }}>
            <button className="line-number" title={doc.ready ? '点击选择此行，再添加标注' : '缓存完成后可添加标注'} onClick={() => doc.ready && onSelect(row.line)}>{bookmark ? '◆ ' : ''}{doc.ready ? row.line + 1 : '·'}</button>
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

function SearchRows({ results, onJump, rowHeight }: { results: SearchResult | null; onJump(match: Match): void; rowHeight: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(180);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setTop(0); if (viewport.current) viewport.current.scrollTop = 0; }, [results]);
  const matches = results?.matches || [];
  const start = Math.max(0, Math.floor(top / rowHeight) - 6);
  const end = Math.min(matches.length, start + Math.ceil(height / rowHeight) + 14);
  return <div className="result-list search-results" ref={viewport} onScroll={e => setTop(e.currentTarget.scrollTop)}>
    <div className="search-result-rows" style={{ paddingTop: start * rowHeight, paddingBottom: Math.max(0, matches.length - end) * rowHeight }}>
      {matches.slice(start, end).map(match => <button className="result" key={`${match.file || ''}:${match.line}`} onClick={() => onJump(match)}><small>第 {match.line + 1} 行</small>{match.file && <label className="result-file" title={match.file}>{match.file.split('/').pop()}</label>}<span>{match.text}</span></button>)}
    </div>
    {!results && <p className="empty-inline">选中日志文本后按 Ctrl+F 搜索，点击结果跳转到日志上下文。</p>}
    {results?.count === 0 && <p className="empty-inline">未找到匹配内容</p>}
  </div>;
}

function App() {
  const [theme, setTheme] = useState<ThemeId>('midnight');
  const [font, setFont] = useState(defaultLogFont);
  const [fontDraft, setFontDraft] = useState(defaultLogFont);
  const [fontSettings, setFontSettings] = useState(false);
  const [fontSaving, setFontSaving] = useState(false);
  const [profile, setProfile] = useState<Profile>(initial);
  const [jumpSettings, setJumpSettings] = useState(false);
  const [jumpProfiles, setJumpProfiles] = useState<JumpProfile[]>([]);
  const jumpLoadToken = useRef(0);
  const jumpConfig = { ...defaultJump, ...profile.jump };
  const updateJump = (fields: Partial<JumpProfile>) => { jumpLoadToken.current++; setProfile(p => ({ ...p, jumpName: fields.enabled !== undefined ? p.jumpName : undefined, jump: { ...defaultJump, ...p.jump, ...fields } })); };
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const profileLoadToken = useRef(0);
  const [connection, setConnection] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [directory, setDirectory] = useState(defaultLogDirectory);
  const [pathInput, setPathInput] = useState(defaultLogDirectory);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [fileSource, setFileSource] = useState<'remote' | 'local'>('remote');
  const [localListing, setLocalListing] = useState<LocalListing | null>(null);
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
  const [directorySettings, setDirectorySettings] = useState(false);
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
  const [searchScope, setSearchScope] = useState<'current' | 'extracted' | 'remote' | 'folder'>('current');
  const [regex, setRegex] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [rules, setRules] = useState('ERROR,WARN');
  const [extraHighlights, setExtraHighlights] = useState<string[]>([]);
  const [suppressedHighlights, setSuppressedHighlights] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [filter, setFilter] = useState<LogFilter | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const searchToken = useRef('');
  const [following, setFollowing] = useState(false);
  const followingRef = useRef(false);
  const [jump, setJump] = useState({ line: 0, token: 0 });
  const [jumpInput, setJumpInput] = useState('');
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [color, setColor] = useState('#fbbf24');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [task, setTask] = useState<ViewerEvent | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [sideTab, setSideTab] = useState<'search' | 'marks'>('search');
  const go = (line: number) => setJump({ line, token: Date.now() });
  const fail = (e: unknown) => setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  const run = async (work: () => Promise<unknown>) => { setError(''); try { await work(); } catch (e) { fail(e); } };

  async function selectJump(name: string) {
    profileLoadToken.current++;
    const token = ++jumpLoadToken.current;
    if (!name) { setProfile(p => ({ ...p, jumpName: undefined, jump: { ...defaultJump, name: '', enabled: Boolean(p.jump?.enabled) } })); return; }
    const loaded = await api.loadJumpProfile(name);
    if (token === jumpLoadToken.current) setProfile(p => ({ ...p, jumpName: name, jump: { ...defaultJump, ...loaded, enabled: Boolean(p.jump?.enabled) } }));
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
    if (!name) { setProfile(initial); return; }
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
  async function browseLocal(path?: string) {
    const response = path ? await api.listLocal(path) : await api.chooseLocalFolder();
    if (!response) return;
    setLocalListing(response); setLocalPathInput(response.path); setFileSource('local'); setSelectedFile('');
    setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope('folder');
    setMessage(`本地文件夹 · ${response.entries.filter(entry => !entry.directory).length} 个文件`);
  }
  async function browse(path: string) { if (localMode) await browseLocal(path); else await list(path); }
  function viewFile(file: string) { return localMode ? api.openLocalFile(file) : api.openRemote(file); }
  function processEvent(e: ViewerEvent) {
    if (e.type === 'connection-progress') { setMessage(e.message || '正在连接'); return; }
    if (e.type === 'task') { setTask(previous => previous?.id === e.id ? { ...previous, ...e } : e); return; }
    if (e.type === 'disconnected') { searchToken.current = ''; setSearching(false); setFiltering(false); setConnection(''); if (!localMode) setEntries([]); setFollowing(false); followingRef.current = false; setDoc(null); docRef.current = null; setFilter(null); setContextMenu(null); setMessage('SSH 连接已断开'); return; }
    if (e.type === 'connection-error') { setError(e.error || 'SSH 连接错误'); return; }
    if (e.type === 'batch-search-progress' && e.requestId === searchToken.current) { setMessage(`${e.source === 'local' ? '本地搜索' : '远程搜索'} ${e.fileIndex}/${e.files} · ${e.file} · ${size(e.bytes)}`); return; }
    if (e.id !== docRef.current?.id) return;
    if (e.type === 'ready') {
      const updated = { ...docRef.current!, ...e, ready: true } as Doc;
      docRef.current = updated; setDoc(updated);
      setMessage(`全文就绪 · ${updated.lines.toLocaleString()} 行 · ${size(updated.size)}`);
      go(pendingJump.current ?? updated.lines); pendingJump.current = null;
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
    api.settings().then(async s => { if (s.version !== __APP_VERSION__) setError('界面与后台版本不一致，请关闭旧窗口并重新启动工具'); setDirectories(s.directories); setTheme(resolveTheme(s.theme)); setFont(s.logFont || defaultLogFont); setProfiles(s.profiles); setJumpProfiles(s.jumpProfiles); if (s.localPaths?.length) { setExtractedPaths(s.localPaths); setSearchScope('extracted'); } const name = s.profiles.find(p => p.name === s.selectedProfile)?.name || s.profiles[0]?.name; if (name) await selectProfile(name); else if (s.selectedJump) await selectJump(s.selectedJump); }).catch(fail);
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
    if (opening.current) return;
    opening.current = true; setOpeningState(true); pendingEvents.current = [];
    setError('');
    try {
      const result = await work();
      if (!result) return;
      setSearchScope(scope || (result.remote && activePattern ? 'remote' : 'current'));
      docRef.current = result; setDoc(result); setBookmarks(result.bookmarks || []); if (!keepResults) setResults(null); pendingJump.current = line ?? null;
      searchToken.current = ''; setSearching(false); setFiltering(false); setFilter(null); setContextMenu(null); setSelectedLine(null); setFollowing(false); followingRef.current = false;
      go(result.ready ? line ?? result.lines : result.preview?.length || 0);
      setMessage('预览日志末尾 · 后台缓存全文');
      for (const e of pendingEvents.current) processEvent(e);
    } catch (e) { setDoc(null); docRef.current = null; setFollowing(false); followingRef.current = false; fail(e); }
    finally { opening.current = false; setOpeningState(false); pendingEvents.current = []; }
  }
  async function search(text = query, useRegex = regex) {
    if (!text || opening.current || (searchScope === 'folder' && (!localListing || !!patternError)) || (searchScope === 'current' && !doc?.ready) || (searchScope === 'extracted' && !extractedPaths.length) || (searchScope === 'remote' && (!connection || !activePattern))) return;
    setBottomOpen(true);
    const token = crypto.randomUUID(); searchToken.current = token; setSearching(true); setFiltering(false); setResults(null); setSideTab('search'); setError('');
    try {
      const response = searchScope === 'folder' ? await api.searchLocalFiles(localListing!.path, activePattern, text, { regex: useRegex, caseSensitive: sensitive }, token) : searchScope === 'extracted' ? await api.searchExtracted(extractedPaths, text, { regex: useRegex, caseSensitive: sensitive }, token) : searchScope === 'remote' ? await api.searchFiles(directory, activePattern, text, { regex: useRegex, caseSensitive: sensitive }, token) : await api.search(doc!.id, text, { regex: useRegex, caseSensitive: sensitive }, token);
      if (searchToken.current !== token) return;
      if (response.source === 'local') { if (response.paths) setExtractedPaths(response.paths); setSearchScope(searchScope === 'folder' ? 'folder' : 'extracted'); } setResults(response); setMessage(`搜索完成 · ${response.count.toLocaleString()} 条匹配${response.files !== undefined ? ` · ${response.searchedFiles}/${response.files} 个文件` : ''}`); if (response.errors?.length) setError(response.errors.join('；'));
    } catch (e) { if (searchToken.current === token) fail(e); }
    finally { if (searchToken.current === token) setSearching(false); }
  }
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
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
      const result = await api.extract(file);
      if (!result) return;
      setExtractedPaths(result.paths);
      if (result.openPath) await open(() => api.openExtracted(result.openPath!), undefined, false, 'extracted');
      else setMessage('解压完成 · 归档内没有文件');
    });
  }
  async function transferMatches(unpack: boolean) {
    await run(async () => {
      const result = await api.batchTransfer(directory, activePattern, unpack);
      setExtractedPaths(result.paths); if (result.paths.length) setSearchScope('extracted');
      if (result.errors.length) setError(result.errors.join('；'));
      if (result.openPath) await open(() => api.openExtracted(result.openPath!), undefined, false, 'extracted');
      setMessage(`批量处理完成 · 成功 ${result.completedFiles} 个 · 失败 ${result.failedFiles} 个`);
      if (result.errors.length) setError(result.errors.join('；'));
    });
  }
  async function jumpResult(match: Match) {
    if (match.file && (doc?.name !== match.file || Boolean(doc.remote) !== (match.source !== 'local'))) await open(() => match.source === 'local' ? api.openExtracted(match.file!) : api.openRemote(match.file!), match.line, true, match.source === 'local' ? searchScope === 'folder' ? 'folder' : 'extracted' : 'remote');
    else goOriginal(match.line);
  }
  let visibleEntries = browseEntries;
  let patternError = '';
  if (activePattern) {
    try { const matcher = filenamePattern(activePattern); visibleEntries = browseEntries.filter(entry => entry.directory || matcher.test(entry.name)); }
    catch (e) { patternError = e instanceof Error ? e.message : String(e); }
  }
  const matchedFileCount = visibleEntries.filter(entry => !entry.directory).length;
  if (!api) return <div className="browser-warning">请通过桌面程序启动。<code>npm run build && npm start</code></div>;

  return <div className="app" style={{ '--log-font-family': logFontFamily(font.family), '--log-font-size': `${font.size}px`, '--log-line-height': `${logLineHeight(font.size)}px`, '--result-line-height': `${resultLineHeight(font.size)}px` } as React.CSSProperties}>
    <header className="header"><div className="brand"><span className="brand-icon">⌁</span><div><strong>SSH Log Viewer</strong><small>远程日志工作台 · v{__APP_VERSION__}</small></div></div><span className={`connection-pill ${connection ? 'connected' : ''}`}><i />{connection || '本地模式 / 未连接'}</span><div className="header-actions"><label className="theme-picker"><span className="theme-dot" /><select aria-label="颜色主题" value={theme} onChange={e => { const selected = resolveTheme(e.target.value); setTheme(selected); void run(() => api.saveTheme(selected)); }}>{themes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button onClick={() => void open(() => api.openLocal())} disabled={openingState}>打开本地日志</button><button onClick={() => void run(() => browseLocal())}>打开本地文件夹</button><button onClick={() => void extract()}>本地解压</button><button onClick={() => setDirectorySettings(true)}>目录设置</button></div></header>
    <div className="workspace">
      <aside className="left-panel">
        <div className="panel-title">连接管理 <span>SSH / SFTP</span></div>
        <div className="connection-mode" role="radiogroup" aria-label="连接方式"><label><input type="radio" name="connection-mode" aria-label="本地连接" checked={!jumpConfig.enabled} onChange={() => updateJump({ enabled: false })} />本地连接</label><label><input type="radio" name="connection-mode" aria-label="通过跳板机连接" checked={jumpConfig.enabled} onChange={() => updateJump({ enabled: true })} />通过跳板机连接</label></div>
        <select aria-label="已保存连接" value={selectedProfile} onChange={e => void run(() => selectProfile(e.target.value))}><option value="">新建连接…</option>{profiles.map(p => <option key={p.name} value={p.name}>{p.name} · {p.username}@{p.host}:{p.port}</option>)}</select>
        <div className="connection-form">
          <label>连接名称<input value={profile.name} placeholder="生产服务器" onChange={e => setProfile({ ...profile, name: e.target.value })} /></label>
          <div className="host-fields"><label>主机<input value={profile.host} placeholder="192.168.1.100" onChange={e => setProfile({ ...profile, host: e.target.value })} /></label><label>端口<input type="number" value={profile.port} onChange={e => setProfile({ ...profile, port: +e.target.value })} /></label></div>
          <label>用户名<input value={profile.username} placeholder="用户名" onChange={e => setProfile({ ...profile, username: e.target.value })} /></label>
          <label>认证方式<select value={profile.auth} onChange={e => setProfile({ ...profile, auth: e.target.value })}><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></label>
          {profile.auth === 'password' && <><label>密码<input type="password" value={profile.password} onChange={e => setProfile({ ...profile, password: e.target.value })} /></label><label className="remember-password"><input type="checkbox" checked={profile.rememberPassword ?? true} onChange={e => setProfile({ ...profile, rememberPassword: e.target.checked })} />保存密码</label></>}
          {profile.auth === 'key' && <><label>私钥文件<div className="inline"><input value={profile.keyPath} onChange={e => setProfile({ ...profile, keyPath: e.target.value })} /><button onClick={() => void run(async () => { const p = await api.chooseKey(); if (p) setProfile({ ...profile, keyPath: p }); })}>选择</button></div></label><label>私钥口令<input type="password" value={profile.passphrase} onChange={e => setProfile({ ...profile, passphrase: e.target.value })} /></label></>}
          {jumpConfig.enabled && <div className="jump-controls"><select aria-label="选择跳板机" value={profile.jumpName || ''} onChange={e => void run(() => selectJump(e.target.value))}><option value="">新建跳板机…</option>{jumpProfiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}</select><button onClick={() => setJumpSettings(true)}>配置</button></div>}

          {jumpConfig.enabled && <small className="hint jump-hint">跳板机：{jumpConfig.host || '未配置'}:{jumpConfig.port}。目标主机填跳板机可访问的地址；反向隧道通常填 127.0.0.1 和隧道端口。</small>}
          <div className="inline"><button className="primary" disabled={connecting} onClick={() => void run(async () => { if (profile.jump?.enabled && (profile.jump.auth === 'password' || !profile.jump.auth) && !profile.jump.password && !profile.jump.hasPassword) { setJumpSettings(true); setError('请在“跳板机密码”中输入登录密码，再保存并使用。主界面的密码用于目标机器。'); return; } setConnecting(true); searchToken.current = ''; setFiltering(false); setSearching(false); setFilter(null); setContextMenu(null); setDoc(null); docRef.current = null; setConnection(''); try { const c = await api.connect(profile); setConnection(c.name); await saveCurrentProfile(profile); setProfile(p => ({ ...p, password: p.rememberPassword ? p.password : '', passphrase: '', jump: p.jump ? { ...p.jump, password: p.jump.rememberPassword ? p.jump.password : '', passphrase: '' } : undefined })); await list(defaultLogDirectory); } finally { setConnecting(false); } })}>{connecting ? '连接中…' : '连接'}</button><button onClick={() => void run(() => saveCurrentProfile())}>保存配置</button>{connecting && <button onClick={() => void run(() => api.disconnect())}>取消连接</button>}{connection && <button onClick={() => void run(async () => { await api.disconnect(); setConnection(''); setDoc(null); docRef.current = null; setEntries([]); })}>断开</button>}</div>
          <small className="hint">{profile.auth === 'password' ? '勾选后，保存配置或连接成功时加密保存密码。' : '私钥口令仅用于本次连接，不保存。'}</small>
        </div>
        <div className="panel-title files-title">{localMode ? '本地文件' : '远程文件'} <div className="file-source-controls"><select aria-label="文件来源" value={fileSource} onChange={e => { const source = e.target.value as 'remote' | 'local'; setFileSource(source); setSelectedFile(''); setFilePattern(''); setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope(source === 'local' ? 'folder' : 'current'); }}><option value="remote">远程</option><option value="local" disabled={!localListing}>本地</option></select><button disabled={!canBrowse} onClick={() => void run(() => browse(browseDirectory))}>↻</button></div></div>
        <form className="path-bar" onSubmit={e => { e.preventDefault(); void run(() => browse(localMode ? localPathInput : pathInput)); }}><input aria-label={localMode ? "本地路径" : "远程路径"} value={localMode ? localPathInput : pathInput} onChange={e => localMode ? setLocalPathInput(e.target.value) : setPathInput(e.target.value)} /><button disabled={!canBrowse}>前往</button></form>
        <div className="file-pattern"><input aria-label="文件名匹配" title={filenameFromSelection ? `${filePattern}（按 Enter 应用匹配）` : filePattern} onKeyDown={e => { if (e.key === 'Enter') { setFilenameFromSelection(false); setSelectionListPattern(''); setSearchScope(localMode ? 'folder' : (doc && !doc.remote) || searchScope === 'extracted' ? extractedPaths.length ? 'extracted' : 'current' : filePattern ? 'remote' : 'current'); } }} placeholder="文件名匹配：signal.2026-10-12.*" value={filePattern} onChange={e => { setSelectionListPattern(''); setFilenameFromSelection(false); setFilePattern(e.target.value); setSearchScope(localMode ? 'folder' : (doc && !doc.remote) || searchScope === 'extracted' ? extractedPaths.length ? 'extracted' : 'current' : e.target.value ? 'remote' : 'current'); setSelectedFile(''); }} />{filePattern && <button title="清除文件名匹配" onClick={() => { setSelectionListPattern(''); setFilenameFromSelection(false); setFilePattern(''); setSearchScope(localMode ? 'folder' : 'current'); }}>×</button>}</div>
        {activePattern && <small className="pattern-hint">{patternError || `匹配 ${matchedFileCount} 个文件 · 搜索覆盖匹配日志及 .gz · 支持日期/关键词片段`}</small>}
        {!localMode && activePattern && <div className="batch-actions"><button disabled={!connection || !!patternError || !matchedFileCount || task?.state === 'running'} onClick={() => void transferMatches(false)}>全部下载</button><button disabled={!connection || !!patternError || !matchedFileCount || task?.state === 'running'} onClick={() => void transferMatches(true)}>全部下载并解压</button></div>}
        <div className="file-list">{canBrowse && <button className="file-entry" disabled={localMode && browseDirectory === localListing?.root} onClick={() => void run(() => browse(join(browseDirectory, '..')))}>↰ 上级目录</button>}{visibleEntries.map(entry => <button key={entry.name} className={`file-entry ${selectedFile === join(browseDirectory, entry.name) ? 'selected' : ''}`} title={`${entry.name}\n${new Date(entry.mtime * 1000).toLocaleString()}`} onClick={() => { setSelectedFile(join(browseDirectory, entry.name)); if (!entry.directory) { setSelectionListPattern(activePattern); setFilePattern(entry.name); setFilenameFromSelection(true); } }} onDoubleClick={() => entry.directory ? void run(() => browse(join(browseDirectory, entry.name))) : void open(() => viewFile(join(browseDirectory, entry.name)))}><span className={entry.directory ? 'folder' : 'file'}>{entry.directory ? '▸' : '≡'}</span><span>{entry.name}</span><small>{entry.directory ? '' : size(entry.size)}</small></button>)}{!canBrowse && <p className="empty-inline">{localMode ? '请打开本地文件夹' : '连接后浏览远程目录'}</p>}{canBrowse && !visibleEntries.length && <p className="empty-inline">没有匹配的文件</p>}</div>
        {task && <div className="task-card"><strong>{task.kind} · {task.state === 'running' ? '进行中' : task.state === 'done' ? '完成' : task.state === 'cancelled' ? '已取消' : '失败'}</strong>{task.files !== undefined && <small>{task.fileIndex ? `${task.fileIndex}/${task.files} · ${task.phase || ''} · ${task.file || ''}` : `共 ${task.files} 个文件`} · 成功 {task.completedFiles || 0} · 失败 {task.failedFiles || 0}</small>}{task.currentBytes !== undefined && task.state === 'running' && <small>当前文件 {size(task.currentBytes)}{task.currentSize ? ` / ${size(task.currentSize)}` : ''}</small>}<span>{size(task.bytes)}{task.size ? ` / ${size(task.size)}` : ''}</span>{task.origin && <small title={task.origin}>来源：{task.origin}</small>}{task.destination && <small>{task.destination}</small>}{task.error && <small>{task.error}</small>}{(task.kind === '解压' || task.kind === '批量下载解压') && task.state === 'done' && extractedPaths.length > 1 && <select aria-label="打开解压文件" defaultValue="" onChange={e => e.target.value && void open(() => api.openExtracted(e.target.value), undefined, false, 'extracted')}><option value="">打开其他解压文件…</option>{extractedPaths.map(file => <option key={file} value={file}>{file.split('/').pop()}</option>)}</select>}{task.state === 'running' && <button onClick={() => void run(() => api.cancelTask(task.id!))}>取消任务</button>}</div>}
        <div className="file-actions"><button disabled={!selectedFile || openingState} onClick={() => void open(() => viewFile(selectedFile))}>查看</button><button disabled={localMode || !selectedFile} onClick={() => void run(async () => { const result = await api.download(selectedFile) as { destination: string } | null; if (result) { setExtractedPaths([result.destination]); setSearchScope('extracted'); } })}>下载</button><button disabled={localMode || !selectedFile} onClick={() => void extract(selectedFile)}>解压</button></div>
      </aside>
      <main className="main-panel">
        <div className="document-bar"><span className="file-badge">LOG</span><strong title={doc?.name}>{doc?.name || '尚未打开日志'}</strong>{doc?.origin && <span className="source-origin" title={doc.origin}>来源：{doc.origin}</span>}{doc && <span>{size(doc.size)} · {doc.ready ? `${doc.lines.toLocaleString()} 行` : '缓存中'}</span>}</div>
        <form className="search-bar" onSubmit={e => { e.preventDefault(); void search(); }}><span>⌕</span><input ref={searchInput} placeholder="搜索全文关键词或正则表达式…" value={query} onChange={e => setQuery(e.target.value)} /><label><input type="checkbox" checked={sensitive} onChange={e => setSensitive(e.target.checked)} />Aa</label><label><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} />正则</label><button className="primary" disabled={(searchScope === 'folder' && (!localListing || !!patternError)) || (searchScope === 'current' && !doc?.ready) || (searchScope === 'extracted' && !extractedPaths.length) || (searchScope === 'remote' && (!activePattern || !connection || !!patternError || !matchedFileCount)) || openingState || !query || searching || filtering}>搜索全文</button>{(searching || filtering) && <button type="button" onClick={() => void cancelSearch()}>取消</button>}</form>
        <div className="search-scope"><label>搜索范围<select aria-label="搜索范围" value={searchScope} onChange={e => { setSearchScope(e.target.value as 'current' | 'extracted' | 'remote' | 'folder'); }}><option value="current">当前打开文件{doc && !doc.remote ? '（本地）' : ''}</option><option value="extracted" disabled={!extractedPaths.length}>已下载/解压文件（本地 {extractedPaths.length} 个）</option><option value="folder" disabled={!localListing || !localMode}>本地文件夹（当前目录匹配文件）</option><option value="remote" disabled={localMode || !connection || !activePattern}>匹配文件（优先本地）</option></select></label><small>{searchScope === 'folder' ? '搜索本地当前目录的匹配文件，支持普通日志和 .gz；不包含子目录' : searchScope === 'extracted' ? '直接搜索已下载或解压的本地文件，不重新下载' : searchScope === 'remote' ? '优先使用该连接已下载的匹配文件；无本地副本时读取远程' : '仅搜索当前打开的日志'}</small></div>
        <div className="log-toolbar"><label>高亮<input value={rules} onChange={e => { setRules(e.target.value); setSuppressedHighlights([]); }} placeholder="多个关键词用逗号分隔" /></label><div className="toolbar-right"><button onClick={() => { setError(''); setFontDraft(font); setFontSettings(true); }}>字体设置</button><button disabled={!doc} onClick={() => go(0)}>首行</button><button disabled={!doc} onClick={() => go(doc?.ready ? doc.lines : doc?.preview?.length || 0)}>末尾</button><input className="jump-input" aria-label="跳转行号" placeholder="行号" value={jumpInput} onChange={e => setJumpInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && doc?.ready) goOriginal(Math.max(0, (Number(jumpInput) || 1) - 1)); }} /><button disabled={!doc?.ready} onClick={() => goOriginal(Math.max(0, (Number(jumpInput) || 1) - 1))}>跳转</button><label className="follow-toggle"><input type="checkbox" checked={following} disabled={!doc?.ready || doc.compressed || openingState || !!filter || filtering} onChange={e => { const value = e.target.checked; setFollowing(value); followingRef.current = value; void run(async () => { try { await api.follow(value); if (value && doc) go(doc.lines); } catch (error) { setFollowing(false); followingRef.current = false; throw error; } }); }} />实时跟随</label></div></div>
        {filter && <div className="filter-bar"><span title={filter.query}>筛选：{filter.query} · {filter.total.toLocaleString()} 个匹配行{filter.capped ? '（仅展示前 100 万行）' : ''}</span><button onClick={clearFilter}>取消筛选</button></div>}
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
        {doc ? <LogView key={doc.id} rowHeight={logLineHeight(font.size)} doc={doc} filter={filter} onContext={(text, x, y) => setContextMenu({ text, x, y })} words={[...rules.split(/[,，]/).map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 12), ...extraHighlights, ...(!regex && query && query.length <= 2048 ? [query] : [])].filter(word => !suppressedHighlights.some(excluded => sameWord(excluded, word)))} sensitive={sensitive} bookmarks={bookmarks} jump={jump} onSelect={line => { setSelectedLine(line); setSideTab('marks'); setBottomOpen(true); }} onError={setError} /> : <div className="welcome"><div className="welcome-symbol">⌁</div><h1>让远程日志，触手可及</h1><p>连接 SSH 服务器，双击文件开始查看。<br />后台缓存全文，按需显示日志，保持浏览流畅。</p><button className="primary" disabled={openingState} onClick={() => void open(() => api.openLocal())}>打开本地日志</button><div className="features"><span>分块读取</span><span>全文搜索</span><span>高亮与标注</span><span>下载与解压</span></div></div>}
      <section className={`bottom-panel ${bottomOpen ? 'expanded' : 'collapsed'}`} aria-label="搜索结果与标注"><div className="side-tabs"><button className={sideTab === 'search' ? 'active' : ''} onClick={() => { setSideTab('search'); setBottomOpen(true); }}>搜索结果 {results ? `(${results.count})` : ''}</button><button className={sideTab === 'marks' ? 'active' : ''} onClick={() => { setSideTab('marks'); setBottomOpen(true); }}>标注 ({bookmarks.length})</button><button className="panel-toggle" aria-label={bottomOpen ? '收起结果面板' : '展开结果面板'} onClick={() => setBottomOpen(value => !value)}>{bottomOpen ? '收起 ▾' : '展开 ▴'}</button></div>
        {bottomOpen && <div className="bottom-content">{sideTab === 'search' ? <>{results?.files !== undefined && <small className="batch-summary">已搜索 {results.searchedFiles}/{results.files} 个匹配文件 · {results.count.toLocaleString()} 条匹配</small>}{results?.capped && <p className="hint side-hint">仅展示前 10000 条匹配</p>}{!!results?.truncatedLines && <p className="hint side-hint">{results.truncatedLines} 个超长行仅搜索前 1MB</p>}<SearchRows rowHeight={resultLineHeight(font.size)} results={results} onJump={match => void jumpResult(match)} /></> : <><div className="mark-form"><small>{selectedLine === null ? '点击日志行号选择要标注的行' : `标注第 ${selectedLine + 1} 行`}</small><input placeholder="添加备注…" value={note} onChange={e => setNote(e.target.value)} /><div className="inline"><input type="color" aria-label="标注颜色" value={color} onChange={e => setColor(e.target.value)} /><button disabled={selectedLine === null || !doc?.ready} onClick={() => void run(saveMark)}>保存标注</button></div></div><div className="result-list">{bookmarks.map(mark => <div className="bookmark" key={mark.line}><button className="result" style={{ borderLeft: `3px solid ${mark.color}` }} onClick={() => goOriginal(mark.line)}><small>第 {mark.line + 1} 行</small><span>{mark.note}</span></button><button title="删除标注" onClick={() => void run(async () => { if (!doc) return; const updated = bookmarks.filter(b => b.line !== mark.line); await api.saveBookmarks(doc.bookmarkKey, updated); setBookmarks(updated); })}>×</button></div>)}</div></>}
</div>}
      </section>
        <div className="status-bar"><i className={searching || filtering || (doc && !doc.ready) ? 'busy' : ''} /><span>{message}</span>{selectedLine !== null && <span>已选第 {selectedLine + 1} 行</span>}</div>
      </main>

    </div>
    {jumpSettings && <div className="settings-backdrop" onClick={() => setJumpSettings(false)}><section className="directory-settings jump-settings" role="dialog" aria-label="跳板机配置" onClick={e => e.stopPropagation()}><div className="panel-title">跳板机配置<button aria-label="关闭跳板机配置" onClick={() => setJumpSettings(false)}>×</button></div><label>已保存跳板机<select aria-label="已保存跳板机" value={profile.jumpName || ''} onChange={e => void run(() => selectJump(e.target.value))}><option value="">新建跳板机…</option>{jumpProfiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.host}:{item.port}</option>)}</select></label><label>跳板机名称<input aria-label="跳板机名称" placeholder="例如：办公室跳板机" value={jumpConfig.name || ''} onChange={e => updateJump({ name: e.target.value })} /></label><label>跳板机主机<input aria-label="跳板机主机" value={jumpConfig.host} onChange={e => updateJump({ host: e.target.value })} /></label><label>跳板机端口<input aria-label="跳板机端口" type="number" value={jumpConfig.port} onChange={e => updateJump({ port: Number(e.target.value) })} /></label><label>跳板机用户名<input aria-label="跳板机用户名" value={jumpConfig.username} onChange={e => updateJump({ username: e.target.value })} /></label><label>跳板机认证方式<select aria-label="跳板机认证方式" value={jumpConfig.auth} onChange={e => updateJump({ auth: e.target.value })}><option value="password">密码</option><option value="key">私钥</option><option value="agent">SSH Agent</option></select></label>{jumpConfig.auth === 'password' && <><label>跳板机密码<input aria-label="跳板机密码" type="password" value={jumpConfig.password || ''} onChange={e => updateJump({ password: e.target.value })} /></label><label className="jump-enable"><input type="checkbox" aria-label="保存跳板机密码" checked={jumpConfig.rememberPassword ?? true} onChange={e => updateJump({ rememberPassword: e.target.checked })} />保存跳板机密码</label></>}{jumpConfig.auth === 'key' && <><label>跳板机私钥<div className="inline"><input aria-label="跳板机私钥" value={jumpConfig.keyPath} onChange={e => updateJump({ keyPath: e.target.value })} /><button onClick={() => void run(async () => { const file = await api.chooseKey(); if (file) updateJump({ keyPath: file }); })}>选择私钥</button></div></label><label>跳板机私钥口令<input aria-label="跳板机私钥口令" type="password" value={jumpConfig.passphrase || ''} onChange={e => updateJump({ passphrase: e.target.value })} /></label></>}<p className="hint">不勾选保存密码时，密码仅用于当前会话，重启后需重新输入。主界面的主机、端口、用户名和认证信息用于目标机器。已有反向隧道时，目标主机填 127.0.0.1、端口填跳板机上的监听端口。此功能连接已有隧道，目标机器仍需先建立反向隧道。</p>{error && <p className="settings-error">{error}</p>}<div className="inline"><button className="primary" onClick={() => void run(async () => { await saveJumpCurrent(); setJumpSettings(false); })}>保存并使用</button><button onClick={() => setJumpSettings(false)}>关闭</button></div></section></div>}
    {fontSettings && <div className="settings-backdrop" onClick={() => !fontSaving && setFontSettings(false)}><form className="directory-settings font-settings" role="dialog" aria-label="日志字体设置" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); setFontSaving(true); void run(async () => { const saved = await api.saveLogFont(fontDraft); setFont(saved); setFontSettings(false); }).finally(() => setFontSaving(false)); }}><div className="panel-title">日志字体设置<button type="button" aria-label="关闭字体设置" disabled={fontSaving} onClick={() => setFontSettings(false)}>×</button></div><label>字体名称<input aria-label="日志字体" list="log-font-options" maxLength={100} required value={fontDraft.family} onChange={e => setFontDraft({ ...fontDraft, family: e.target.value })} /></label><datalist id="log-font-options">{['Cascadia Code', 'Consolas', 'DejaVu Sans Mono', 'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', 'Microsoft YaHei'].map(family => <option key={family} value={family} />)}</datalist><label>字号（px）<input aria-label="日志字号" type="number" min={10} max={32} step={1} required value={Number.isNaN(fontDraft.size) ? '' : fontDraft.size} onChange={e => setFontDraft({ ...fontDraft, size: e.target.valueAsNumber })} /></label><p className="hint">可选择或输入本机已安装的字体名称；未安装的字体会使用备用字体。应用后日志正文和搜索结果同步生效，重启后保留。</p><div className="font-preview" style={{ fontFamily: logFontFamily(fontDraft.family), fontSize: `${Number.isFinite(fontDraft.size) ? Math.max(10, Math.min(32, fontDraft.size)) : 12}px` }}>2026-10-13 12:34:56 INFO 日志字体预览<br />连接成功 · ERROR 0123456789 AaBb</div>{error && <p className="settings-error">{error}</p>}<div className="inline"><button type="button" disabled={fontSaving} onClick={() => setFontDraft({ ...defaultLogFont })}>恢复默认</button><button className="primary" disabled={fontSaving}>{fontSaving ? '保存中…' : '应用并保存'}</button><button type="button" disabled={fontSaving} onClick={() => setFontSettings(false)}>取消</button></div></form></div>}
    {directorySettings && <div className="settings-backdrop" onClick={() => setDirectorySettings(false)}><section className="directory-settings" role="dialog" aria-label="默认下载与解压目录" onClick={e => e.stopPropagation()}><div className="panel-title">默认目录<button aria-label="关闭目录设置" onClick={() => setDirectorySettings(false)}>×</button></div>{(['download', 'extract'] as const).map(kind => <label key={kind}>{kind === 'download' ? '下载目录' : '解压目录'}<div className="inline"><input aria-label={kind === 'download' ? '默认下载目录' : '默认解压目录'} readOnly value={directories[kind]} /><button onClick={() => void run(async () => setDirectories(await api.chooseDirectory(kind)))}>选择目录</button></div></label>)}<p className="hint">选择后自动保存。下载文件名自动附加来源设备标识，同名文件保留已有文件；解压创建独立子目录，完成后自动打开日志。</p></section></div>}
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
