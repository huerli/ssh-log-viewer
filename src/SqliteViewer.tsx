import React, { useEffect, useState } from 'react';
import type { Doc, SqliteResult } from './types';
import { useViewer } from './session-context';
import { fileTypeDescription } from '../shared/file-type.mjs';
function displayCell(name: string, value: string | number | null | undefined) {
  if (value === null) return 'NULL';
  const text = String(value ?? '');
  if (name.toLowerCase() !== 'md5') return text;
  const match = /^(?:BLOB \(16 B\): )?([0-9a-f]{32})$/i.exec(text);
  return match ? match[1].toLowerCase() : text;
}
const emptySearch = { field: '', query: '', mode: 'contains' };
export function SqliteViewer({ doc }: { doc: Doc }) {
  const api = useViewer();
  const [data, setData] = useState<SqliteResult>();
  const [table, setTable] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(emptySearch);
  const [search, setSearch] = useState(emptySearch);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError('');
    api.sqliteRead(doc.id, table || undefined, offset, search).then(result => {
      if (cancelled) return;
      setData(result);
      if (!table && result.tables.length) setTable(result.tables[0].name);
    }).catch(e => { if (!cancelled) { setError(String(e)); setData(previous => previous ? { ...previous, rows: [], hasMore: false } : undefined); } }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [api, doc.id, table, offset, search]);
  const columns = data?.columns || [];
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 100));
  return <section className="sqlite-viewer" aria-label="SQLite 数据库查看器">
    <header className="sqlite-heading"><div><strong>SQLite 数据库</strong><span className="sqlite-readonly">只读</span><small title={doc.name}>{doc.name.split(/[\\/]/).pop()}</small></div><span className="sqlite-count">{busy ? '读取中…' : `${data?.total ?? 0} 条记录`}</span></header>
    <div className="sqlite-toolbar"><label className="sqlite-table-picker">表 / 视图<select aria-label="SQLite 表" value={table} disabled={busy} onChange={e => { setTable(e.target.value); setOffset(0); setDraft(emptySearch); setSearch(emptySearch); }}><option value="">选择表…</option>{data?.tables.map(t => <option key={t.name} value={t.name}>{t.name} ({t.type})</option>)}</select></label>
    <form className="sqlite-search" onSubmit={e => { e.preventDefault(); setSearch({ ...draft }); setOffset(0); }}><select aria-label="SQLite 搜索字段" value={draft.field} onChange={e => setDraft({ ...draft, field: e.target.value })}><option value="">全部字段</option>{columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select><select aria-label="SQLite 搜索方式" value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value })}><option value="contains">包含</option><option value="exact">等于</option></select><input aria-label="SQLite 搜索内容" maxLength={2048} placeholder="输入字段内容，搜索整个表…" value={draft.query} onChange={e => setDraft({ ...draft, query: e.target.value })} /><button className="primary" disabled={busy || !table}>搜索</button><button type="button" disabled={busy || (!draft.query && !search.query)} onClick={() => { setDraft(emptySearch); setSearch(emptySearch); setOffset(0); }}>清除</button></form></div>
    {error && <p role="alert" className="settings-error">读取失败：{error}</p>}
    {!busy && !error && !data?.tables.length && <p>数据库中没有用户表或视图。</p>}
    <details className="sqlite-schema"><summary>表结构与建表 SQL <span>{columns.length} 个字段</span></summary><pre>{data?.tables.find(t => t.name === table)?.sql}</pre><table><thead><tr><th>字段</th><th>类型</th><th>主键</th><th>非空</th><th>默认值</th></tr></thead><tbody>{columns.map(c => <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{c.pk || '—'}</td><td>{c.notnull ? '是' : '否'}</td><td>{c.dflt_value ?? 'NULL'}</td></tr>)}</tbody></table></details>
    <div className={`reliable-table sqlite-data${busy ? ' sqlite-loading' : ''}`} aria-busy={busy}><table><thead><tr><th className="sqlite-rowno">#</th>{columns.map(c => <React.Fragment key={c.name}><th className={c.name.toLowerCase() === 'md5' ? 'sqlite-md5-heading' : undefined}>{c.name}</th>{c.name.toLowerCase() === 'fileid' && <th title="GET_FILETYPE(fileid) = (fileid >> 16) & 0xff">文件类型（EN_FILETYPE）</th>}</React.Fragment>)}</tr></thead><tbody>{data?.rows?.map((row, i) => <tr key={offset + i}><td className="sqlite-rowno">{offset + i + 1}</td>{columns.map(c => <React.Fragment key={c.name}><td className={c.name.toLowerCase() === 'md5' ? 'sqlite-md5' : undefined} title={c.name.toLowerCase() === 'md5' ? String(row[c.name] ?? 'NULL') : undefined}><span className={row[c.name] === null ? 'sqlite-null' : ''}>{displayCell(c.name, row[c.name])}</span></td>{c.name.toLowerCase() === 'fileid' && <td className="sqlite-filetype">{fileTypeDescription(row[c.name])}</td>}</React.Fragment>)}</tr>)}</tbody></table>{!busy && table && data?.rows?.length === 0 && <p className="sqlite-empty">{search.query ? '未找到匹配记录，请调整字段或搜索内容。' : '此页没有记录。'}</p>}</div>
    <footer className="sqlite-footer"><span>{search.query ? `筛选结果 · ${data?.total ?? 0} 条` : `共 ${data?.total ?? 0} 条`} · 每页 100 条</span><div><button disabled={busy || offset === 0} onClick={() => setOffset(offset - 100)}>上一页</button><span>第 {offset / 100 + 1} / {pages} 页</span><button disabled={busy || !data?.hasMore} onClick={() => setOffset(offset + 100)}>下一页</button></div></footer>
    <p className="hint sqlite-hint">字段搜索覆盖整个表；BLOB 按十六进制搜索。大整数完整显示，长文本和 BLOB 仅显示摘要。</p>
  </section>;
}
