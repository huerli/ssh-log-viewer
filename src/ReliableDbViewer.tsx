import React, { useEffect, useMemo, useRef, useState } from 'react';
import { businessNames, bytesHex, formatReliableDbTime, hex, parseReliableDb, reliableDbSlotSize, stateName } from '../shared/reliable-db.mjs';

import { decodeReliableBody, describeReliableTail } from '../shared/reliable-db-body.mjs';
import { alarmTypes, wholeRecordTypes, transportTypes, enumDescription, recordTypeDescription } from '../shared/reliable-db-enums.mjs';
import { useViewer } from './session-context';
import type { Doc } from './types';

type DbSource = { name: string; bytes: Uint8Array };
export function InlineReliableDbViewer({ doc }: { doc: Doc }) {
  const api = useViewer();
  const [source, setSource] = useState<DbSource>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (doc.ready) void api.documentBytes(doc.id).then(bytes => {
      if (!cancelled) setSource({ name: doc.name, bytes: new Uint8Array(bytes) });
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [api, doc.id, doc.name, doc.ready]);
  if (error) return <p role="alert">解析失败：{error}</p>;
  if (!source) return <p role="status">正在缓存、解压并解析可靠传输 DB…</p>;
  return <ReliableDbViewer initialSource={source} embedded />;
}

export function ReliableDbViewer({ onClose, initialSource, embedded = false }: { onClose?: () => void; initialSource?: DbSource; embedded?: boolean }) {
  const [source, setSource] = useState<DbSource | undefined>(initialSource);
  const [slot, setSlot] = useState(initialSource ? reliableDbSlotSize(initialSource.name) || 128 : 128);
  const [little, setLittle] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number>();
  const [error, setError] = useState('');
  const token = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  async function load(file: File) {
    const current = ++token.current;
    setError('');
    if (file.size > 16 * 1024 * 1024) { setError('文件超过 16 MiB，请选择可靠传输 DB 文件'); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (current !== token.current) return;
      setSource({ name: file.name, bytes });
      setSlot(reliableDbSlotSize(file.name) || 128);
      setSelected(undefined); setFilter('all'); setQuery('');
    } catch (e) { if (current === token.current) setError(`读取失败：${String(e)}`); }
  }
  const parsed = useMemo(() => parseReliableDb(source?.bytes || new Uint8Array(), slot, little), [source, slot, little]);
  const records = useMemo(() => parsed.records.filter(r =>
    (filter === 'all' || (filter === 'pending' ? r.state === 254 : filter === 'invalid' ? r.issues.length > 0 : filter === 'ok' ? r.state === 0 : r.state !== undefined && r.state >= 1 && r.state <= 250)) &&
    (!query.trim() || [r.dbSeq, r.seq, r.serial, recordTypeDescription(r.type, r.body), r.time, formatReliableDbTime(r.time), hex(r.offset), r.uniq, r.type === undefined ? '' : businessNames[r.type]].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  ).sort((a, b) => (b.time ?? -1) - (a.time ?? -1) || a.offset - b.offset), [parsed, filter, query]);
  const detail = parsed.records.find(r => r.offset === selected);
  const bodyDetail = useMemo(() => detail ? decodeReliableBody(detail.type, detail.body, little) : undefined, [detail, little]);
  const tailDetail = useMemo(() => describeReliableTail(bodyDetail?.remaining, little), [bodyDetail, little]);
  return <div className={embedded ? "reliable-inline" : "settings-backdrop"}><section className="reliable-db" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label="可靠传输 DB 查看器" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void load(file); }}>
    <div className="panel-title">可靠传输 DB 查看器{!embedded && <button aria-label="关闭可靠传输查看器" onClick={onClose}>×</button>}</div>
    <div className="reliable-controls">{!embedded && <button className="primary" onClick={() => input.current?.click()}>打开 DB 文件</button>}<input hidden ref={input} type="file" aria-label="可靠传输 DB 文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void load(file); }} />
      <label>槽位<select aria-label="DB 槽位大小" value={slot} onChange={e => { setSlot(Number(e.target.value)); setSelected(undefined); }}><option value={128}>128 B（告警 / 事件 / 防溜动作）</option><option value={256}>256 B（全程记录）</option></select></label>
      <label>字节序<select aria-label="DB 字节序" value={little ? 'le' : 'be'} onChange={e => setLittle(e.target.value === 'le')}><option value="le">小端</option><option value="be">大端</option></select></label>
      <select aria-label="DB 状态筛选" value={filter} onChange={e => { setFilter(e.target.value); }}><option value="all">全部记录</option><option value="pending">待确认</option><option value="ok">成功回复</option><option value="error">错误回复</option><option value="invalid">异常记录</option></select>
      <input aria-label="搜索 DB 记录" placeholder="序号、设备序列号、业务、标识…" value={query} onChange={e => { setQuery(e.target.value); }} /></div>
    <p className="hint">打开或拖入 alarm、event、wholercd、oob_action 文件（最大 16 MiB）。默认小端，可手动切换；wholercd 文件名自动选择 256 B 槽位。点击记录行查看业务字段及原始数据。</p>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {source && <p role="status" className="reliable-summary">{source.name} · {source.bytes.length} B · {parsed.slots} 个槽位 · 空槽 {parsed.empty} · 待确认 {parsed.records.filter(r => r.state === 254).length} · 异常 {parsed.records.filter(r => r.issues.length).length} · 匹配 {records.length} 条</p>}
    <div className={`reliable-records${detail ? " with-detail" : ""}`}><div className="reliable-table"><table><thead><tr>{['地址', '本地序号', '业务', 'type 类型', '状态', '传输序号', '设备/单板序列号', '原始时间值', '转换后的时间（本地）', '数据长度', '异常'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{records.map(r => <tr key={r.offset} onClick={() => setSelected(r.offset)} className={selected === r.offset ? 'selected' : ''}><td><button aria-label={`查看槽位 ${hex(r.offset)}`} onClick={() => setSelected(r.offset)}>{hex(r.offset)}</button></td><td>{r.dbSeq ?? '—'}</td><td>{r.type === undefined ? '—' : businessNames[r.type] || `未知 (${r.type})`}</td><td>{recordTypeDescription(r.type, r.body)}</td><td>{r.state === undefined ? '—' : stateName(r.state)}</td><td>{r.seq ?? '—'}</td><td>{r.serial === undefined ? '—' : hex(r.serial)}</td><td>{r.time === undefined ? '—' : hex(r.time)}</td><td>{formatReliableDbTime(r.time)}</td><td>{r.length ?? '—'}</td><td>{r.issues.join('；')}</td></tr>)}</tbody></table>{!records.length && <p>{source ? '没有匹配的记录（全 FF 空槽不列出）' : '请选择本地可靠传输 DB 文件'}</p>}</div>
    {detail && <div className="reliable-detail" role="region" aria-label="记录详情"><div className="reliable-detail-heading"><strong>槽位 {hex(detail.offset)} · 唯一标识（12 字节）：{detail.uniq || '不可解析'}</strong><button aria-label="关闭记录详情" onClick={() => setSelected(undefined)}>关闭详情</button></div><p>传输头 errcode：{detail.errcode === undefined ? '—' : hex(detail.errcode)}；确认结果以本地 state 字段为准。</p>{bodyDetail && <><h3>实际记录内容</h3><p>传输类型：{detail.type === undefined ? '—' : enumDescription(transportTypes, detail.type)}</p>{bodyDetail.error && <p role="alert">{bodyDetail.error}</p>}<dl className="reliable-fields">{bodyDetail.fields.map(field => <div key={`${field.section}.${field.key}`}><dt title={`${field.section} · ${field.key} · +${field.offset}${field.key === "event_type" ? " · EN_WRCD_TYPE" : field.key === "alm_type" ? " · EN_ALMTYPE" : ""}`}>{field.label}</dt><dd>{field.key === 'event_type' && typeof field.value === 'number' ? enumDescription(wholeRecordTypes, field.value) : field.key === 'alm_type' && typeof field.value === 'number' ? enumDescription(alarmTypes, field.value) : String(field.value) || '（空）'}{['time', 'start_seq_time'].includes(field.key) && typeof field.value === 'number' && <small>{formatReliableDbTime(field.value)}</small>}</dd></div>)}</dl>{!!bodyDetail.remaining?.length && <section className="reliable-tail" aria-label="尾部数据详情"><h4>尾部数据详情（{bodyDetail.remaining.length} B）</h4>{tailDetail?.firstValue !== undefined && <p>首个 32 位值：{tailDetail.firstValue} · 按 Unix 秒转换：{formatReliableDbTime(tailDetail.firstValue)}</p>}<p>字符串（{tailDetail?.encoding}，控制字符转义）：</p><pre>{tailDetail?.text}</pre><details><summary>原始十六进制</summary><pre>{bytesHex(bodyDetail.remaining)}</pre></details></section>}</>}<details open><summary>业务体（{detail.body?.length ?? 0} B）</summary><pre>{detail.body ? bytesHex(detail.body) || '空' : '长度异常，未解析'}</pre></details><details><summary>完整原始槽位</summary><pre>{bytesHex(detail.raw)}</pre></details></div>}
    </div>
    <p className="hint">非零错误回复也会结束重发；待确认数量是文件中的记录数，不是内存待发列表数量。原始时间值保留；转换列按 Unix 秒时间戳显示为本机时区时间（含 UTC 偏移）。全部匹配记录直接展示，无需翻页。</p>
  </section></div>;
}
