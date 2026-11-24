import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CaptureDetail, CaptureIssue, CaptureResult, CaptureSummary, Doc } from './types';
import { useViewer } from './session-context';
import { captureUtcOffset, formatCaptureTimestamp } from '../shared/capture-time.mjs';
import './CaptureViewer.css';

const rowHeight = 30;
const chunkSize = 1000;
const issueNames: Record<string, string> = {
  truncated: '抓取截短', malformed: '报文格式异常', 'tcp-reset': 'TCP 复位', 'tcp-zero-window': 'TCP 零窗口',
  'tcp-retransmission': '疑似重传', 'tcp-duplicate-ack': '疑似重复 ACK', 'tcp-out-of-order': '疑似乱序',
  'tcp-sequence-gap': '序号缺口', 'icmp-error': 'ICMP 错误', 'dns-error': 'DNS 错误',
};
function timestamp(time: number | null) {
  return time === null ? '无时间戳' : `${formatCaptureTimestamp(time)} ${captureUtcOffset(time)} · UTC ${formatCaptureTimestamp(time, true)} · 原始值 ${time.toFixed(6)} s`;
}
function IssueBadges({ issues }: { issues: CaptureIssue[] }) {
  return <span className="capture-issue-badges">{issues.map(issue => <span key={issue.code} className={`capture-issue ${issue.severity}`} title={issue.message}>{issue.label}</span>)}</span>;
}
export function CaptureViewer({ doc, loadError = '' }: { doc: Doc; loadError?: string }) {
  const api = useViewer();
  const [loaded, setLoaded] = useState<{ key: string; data: CaptureResult }>();
  const [summary, setSummary] = useState<CaptureSummary>();
  const [pageSize, setPageSize] = useState(0);
  const [timeMode, setTimeMode] = useState<'local' | 'utc' | 'relative'>('local');
  const [fileInfo, setFileInfo] = useState(false);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [protocol, setProtocol] = useState('');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<CaptureDetail>();
  const [detailError, setDetailError] = useState('');
  const [detailTab, setDetailTab] = useState<'fields' | 'hex'>('fields');
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [jump, setJump] = useState('');
  const pendingScroll = useRef<{ key: string; index: number } | null>(null);
  const key = JSON.stringify([protocol, query, issue, pageSize, offset]);
  const data = loaded?.key === key ? loaded.data : undefined;
  const count = pageSize ? data?.rows.length || 0 : data?.total || 0;
  const start = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(Math.max(0, top - 32) / rowHeight) - 8));
  const end = Math.min(count, start + Math.ceil(height / rowHeight) + 18);
  const readOffset = pageSize ? offset : Math.floor(start / chunkSize) * chunkSize;
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0; }
    setTop(0); setSelected(null); setDetail(undefined);
  }, [key]);
  useEffect(() => {
    if (!doc.ready) return;
    let cancelled = false;
    setBusy(true); setError('');
    // In continuous mode keep at most two chunks in the renderer; the list still spans every match.
    api.captureRead(doc.id, { offset: readOffset, limit: pageSize || chunkSize * 2, protocol, query, issue }).then(result => {
      if (!cancelled) { setLoaded({ key, data: result }); setSummary(result.summary); }
    }).catch(e => { if (!cancelled) { setError(String(e)); setLoaded(undefined); } }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [api, doc.id, doc.ready, readOffset, pageSize, protocol, query, issue, key]);
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDetail(undefined); setDetailError('');
    api.captureDetail(doc.id, selected).then(result => { if (!cancelled) setDetail(result); }).catch(e => { if (!cancelled) setDetailError(String(e)); });
    return () => { cancelled = true; };
  }, [api, doc.id, selected]);
  useLayoutEffect(() => {
    if (!data || !pendingScroll.current) return;
    if (pendingScroll.current.key === key && viewport.current) {
      viewport.current.scrollTop = pendingScroll.current.index * rowHeight;
      setTop(viewport.current.scrollTop);
    }
    pendingScroll.current = null;
  }, [data, key]);
  function clear() { setDraft(''); setQuery(''); setProtocol(''); setIssue(''); setOffset(0); }
  function jumpToMatch() {
    const position = Math.max(1, Math.min(data?.total || 1, Math.floor(Number(jump) || 1))) - 1;
    if (pageSize) {
      const nextOffset = Math.floor(position / pageSize) * pageSize;
      if (nextOffset !== offset) {
        pendingScroll.current = { key: JSON.stringify([protocol, query, issue, pageSize, nextOffset]), index: position % pageSize };
        setOffset(nextOffset);
      } else if (viewport.current) { viewport.current.scrollTop = (position % pageSize) * rowHeight; setTop(viewport.current.scrollTop); }
    }
    else if (viewport.current) { viewport.current.scrollTop = position * rowHeight; setTop(viewport.current.scrollTop); }
  }
  const analysis = summary?.analysis;
  const visibleIssues = detail?.packet.issues || [];
  return <section className="capture-viewer" aria-label="抓包查看器">
    <header className="capture-heading">
      <div className="capture-identity">
        <div className="capture-title"><strong>抓包查看</strong><span className="capture-readonly">只读</span><button type="button" className={fileInfo ? 'active' : ''} aria-expanded={fileInfo} onClick={() => setFileInfo(value => !value)}>文件信息</button></div>
        <small className="capture-filename" title={doc.name}>{doc.name.split(/[\\/]/).pop()}</small>
      </div>
      <div className="capture-metrics">
        <div><span>数据包</span><strong>{summary?.packetCount.toLocaleString() ?? '—'}</strong></div>
        <div><span>抓包时长</span><strong>{summary ? summary.duration.toFixed(6) : '—'} <small>秒</small></strong></div>
        <button className="capture-metric error" disabled={!doc.ready} aria-pressed={issue === 'error'} onClick={() => { setIssue(issue === 'error' ? '' : 'error'); setOffset(0); }}><span>错误</span><strong>{analysis?.errors.toLocaleString() ?? '—'}</strong></button>
        <button className="capture-metric warning" disabled={!doc.ready} aria-pressed={issue === 'any'} title={`共 ${analysis?.total.toLocaleString() ?? 0} 个报文含诊断提示，错误和提示可能重叠。`} onClick={() => { setIssue(issue === 'any' ? '' : 'any'); setOffset(0); }}><span>需关注</span><strong>{analysis?.total.toLocaleString() ?? '—'}</strong></button>
      </div>
    </header>
    {fileInfo && <section className="capture-file-info" aria-label="抓包文件信息"><div><strong>文件信息</strong><button aria-label="关闭文件信息" onClick={() => setFileInfo(false)}>×</button></div>{summary ? <><dl><dt>文件路径</dt><dd>{doc.name}</dd><dt>文件格式</dt><dd>{summary.format} · {summary.byteOrder} · {summary.timeResolution} · {summary.linkTypes.join(' / ')}</dd><dt>最早时间（本机）</dt><dd>{formatCaptureTimestamp(summary.startTime)} {captureUtcOffset(summary.startTime)}</dd><dt>最晚时间（本机）</dt><dd>{formatCaptureTimestamp(summary.endTime)} {captureUtcOffset(summary.endTime)}</dd><dt>最早 / 最晚（UTC）</dt><dd>{formatCaptureTimestamp(summary.startTime, true)} / {formatCaptureTimestamp(summary.endTime, true)}</dd><dt>抓取 / 原始长度</dt><dd>{summary.capturedBytes.toLocaleString()} / {summary.wireBytes.toLocaleString()} 字节</dd></dl><p>相对时间以首个有时间戳的包为零点。“距上包”使用抓包原始顺序中的前一个包，筛选后仍保持原值。</p>{summary.startTime !== null && new Date(summary.startTime * 1000).getUTCFullYear() === 1970 && <p>文件中的时间戳对应 1970 年，抓包设备时钟可能未设置；显示保留文件原值。</p>}{summary.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</> : <p>正在读取文件信息…</p>}</section>}
    <form className="capture-toolbar" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); setOffset(0); }}>
      <label>协议<select aria-label="抓包协议" value={protocol} disabled={!doc.ready || busy} onChange={e => { setProtocol(e.target.value); setOffset(0); }}><option value="">全部协议</option>{Object.entries(summary?.protocols || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => <option key={name} value={name}>{name} ({count.toLocaleString()})</option>)}</select></label>
      <label>诊断<select aria-label="抓包异常筛选" value={issue} disabled={!doc.ready || busy} onChange={e => { setIssue(e.target.value); setOffset(0); }}><option value="">全部报文</option><option value="any">仅异常 / 需关注</option><option value="error">仅错误（红色）</option><option value="warning">仅提示（黄色）</option>{Object.entries(analysis?.counts || {}).filter(([, value]) => value > 0).map(([code, value]) => <option key={code} value={code}>{issueNames[code] || code} ({value.toLocaleString()})</option>)}</select></label>
      <label className="capture-search-field">搜索内容<input aria-label="抓包搜索" placeholder="地址、端口、摘要；ascii:文本 / hex:字节" maxLength={2048} value={draft} onChange={e => setDraft(e.target.value)} /></label>
      <div className="capture-filter-actions"><button className="primary" disabled={!doc.ready || busy}>筛选</button><button type="button" disabled={busy || (!draft && !query && !protocol && !issue)} onClick={clear}>清除</button></div>
    </form>
    {error && <p className="settings-error" role="alert">读取失败：{error}</p>}
    <div className={`capture-content${selected !== null ? ' with-detail' : ''}`}>
      <div ref={viewport} className="capture-packets" onScroll={e => setTop(e.currentTarget.scrollTop)} aria-busy={busy || (!doc.ready && !loadError)}>
        <table><colgroup>{[56, 220, 94, 184, 162, 162, 70, 88].map((width, i) => <col key={i} style={{ width }} />)}<col /></colgroup>
          <thead><tr><th>编号</th><th className="capture-time-heading"><select aria-label="抓包时间格式" title="切换具体时间或相对时间，不改变包顺序" value={timeMode} onChange={e => setTimeMode(e.target.value as typeof timeMode)}><option value="local">本机时间（{captureUtcOffset(summary?.startTime ?? null)}）</option><option value="utc">UTC 时间</option><option value="relative">相对首包 / s</option></select></th><th title="与原始抓包顺序中前一个包的时间差，不随筛选改变">距上包 / ms</th><th>诊断提示</th><th>源地址</th><th>目标地址</th><th>协议</th><th>长度 / B</th><th>摘要</th></tr></thead>
          <tbody>
            {start > 0 && <tr className="capture-spacer" aria-hidden="true"><td colSpan={9} style={{ height: start * rowHeight }} /></tr>}
            {Array.from({ length: end - start }, (_, i) => {
              const index = start + i, row = data?.rows[index + (pageSize ? 0 : -data.offset)];
              if (!row) return <tr key={`loading-${index}`} className="capture-placeholder"><td colSpan={9}>读取第 {index + (pageSize ? offset : 0) + 1} 条…</td></tr>;
              const severity = row.issues.some(item => item.severity === 'error') ? 'error' : row.issues.length ? 'warning' : '';
              const shownTime = timeMode === 'relative' ? row.relativeTime?.toFixed(6) ?? '—' : formatCaptureTimestamp(row.time, timeMode === 'utc');
              return <tr key={row.number} className={`capture-row ${severity ? `capture-row-${severity}` : ''}${selected === row.number ? ' selected' : ''}`} data-packet={row.number} data-severity={severity || undefined} onClick={() => setSelected(row.number)}>
                <td><button aria-label={`查看数据包 ${row.number}`} onClick={e => { e.stopPropagation(); setSelected(row.number); }}>{row.number}</button></td>
                <td className="capture-packet-time" title={timestamp(row.time)}>{shownTime}</td>
                <td className="capture-packet-delta" title="与原始顺序中前一个包的间隔；首包或无时间戳时不可用">{row.deltaTime === null ? '—' : (row.deltaTime * 1000).toFixed(3)}</td>
                <td title={row.issues.map(item => `${item.label}：${item.message}`).join('\n')}><IssueBadges issues={row.issues} /></td>
                <td title={row.source}>{row.source}{row.sourcePort !== undefined && <small> :{row.sourcePort}</small>}</td>
                <td title={row.destination}>{row.destination}{row.destinationPort !== undefined && <small> :{row.destinationPort}</small>}</td>
                <td><span className="capture-protocol">{row.protocol}</span></td><td title={`抓取 ${row.capturedLength} 字节 / 原始 ${row.length} 字节`}>{row.length}{row.capturedLength < row.length ? ` (${row.capturedLength})` : ''}</td><td title={row.info}>{row.info}</td>
              </tr>;
            })}
            {end < count && <tr className="capture-spacer" aria-hidden="true"><td colSpan={9} style={{ height: (count - end) * rowHeight }} /></tr>}
          </tbody>
        </table>
        {!busy && doc.ready && data?.total === 0 && <p className="capture-empty">{query || protocol || issue ? '没有匹配的数据包，请调整筛选条件。' : '文件中没有数据包。'}</p>}
        {(!doc.ready || (!data && busy)) && <p className="capture-empty" role="status">{loadError ? '解析失败，请重新打开抓包文件。' : '正在后台读取抓包文件…'}</p>}
      </div>
      {selected !== null && <section className="capture-detail" aria-label="数据包详情">
        <div className="capture-detail-heading"><strong>数据包 #{selected}</strong><div role="tablist" aria-label="数据包详情格式"><button role="tab" aria-selected={detailTab === 'fields'} onClick={() => setDetailTab('fields')}>分层字段</button><button role="tab" aria-selected={detailTab === 'hex'} onClick={() => setDetailTab('hex')}>十六进制 / ASCII</button></div><button aria-label="关闭数据包详情" onClick={() => setSelected(null)}>×</button></div>
        {detailError ? <p role="alert">{detailError}</p> : !detail ? <p role="status">读取详情…</p> : <div className="capture-detail-body">
          {!!visibleIssues.length && <div className="capture-issue-details">{visibleIssues.map(item => <p key={item.code} className={item.severity}><strong>{item.label}</strong> {item.message}{item.relatedPacket ? ` · 关联包 #${item.relatedPacket}` : ''}</p>)}</div>}
          {detailTab === 'fields' ? <><dl className="capture-time-detail"><dt>本机时间</dt><dd>{formatCaptureTimestamp(detail.packet.time)} {captureUtcOffset(detail.packet.time)}</dd><dt>UTC 时间</dt><dd>{formatCaptureTimestamp(detail.packet.time, true)}</dd><dt>相对首包 / 距上包</dt><dd>{detail.packet.relativeTime?.toFixed(6) ?? '—'} s / {detail.packet.deltaTime === null ? '—' : (detail.packet.deltaTime * 1000).toFixed(3)} ms</dd><dt>原始时间戳</dt><dd>{detail.packet.time === null ? '无时间戳' : `${detail.packet.time.toFixed(6)} s`}</dd></dl>{detail.layers.map((layer, i) => <details key={i} open><summary>{layer.name}</summary><dl>{layer.fields.map((field, j) => <React.Fragment key={j}><dt>{field.name}</dt><dd>{field.value}</dd></React.Fragment>)}</dl></details>)}</> : <><pre className="capture-hex">{detail.hex}</pre>{detail.truncated && <p>仅显示前 16 KiB，筛选覆盖完整数据包。</p>}</>}
        </div>}
      </section>}
    </div>
    <footer className="capture-footer">
      <div className="capture-footer-summary"><span>{data?.total.toLocaleString() ?? 0} 个{query || protocol || issue ? '匹配' : '数据'}包{busy ? ' · 读取中…' : ''}</span><details className="capture-analysis-note"><summary>诊断说明</summary><p>疑似重传、重复 ACK、乱序和序号缺口为抓包内推断，抓包缺失或位置不同也可能触发。</p></details></div>
      <div className="capture-footer-controls">
        <label className="capture-page-size">显示<select aria-label="抓包显示数量" value={pageSize} disabled={!doc.ready || busy} onChange={e => { setPageSize(Number(e.target.value)); setOffset(0); }}><option value={0}>全部（滚动浏览）</option>{[1000, 5000, 10000].map(size => <option key={size} value={size}>每页 {size.toLocaleString()} 条</option>)}</select></label>
        {pageSize > 0 && <div className="capture-pagination"><button disabled={busy || !data || offset === 0} onClick={() => setOffset(offset - pageSize)}>上一页</button><span>{offset / pageSize + 1} / {Math.max(1, Math.ceil((data?.total || 0) / pageSize))}</span><button disabled={busy || !data?.hasMore} onClick={() => setOffset(offset + pageSize)}>下一页</button></div>}
        <form className="capture-jump" onSubmit={e => { e.preventDefault(); jumpToMatch(); }}><input aria-label="跳转匹配序号" type="number" min={1} max={data?.total || 1} placeholder="结果序号" value={jump} onChange={e => setJump(e.target.value)} /><button disabled={!data?.total}>跳转</button></form>
      </div>
    </footer>
  </section>;
}
