'use strict';
// Conservative capture-order heuristics, informed by Wireshark's documented rules:
// https://www.wireshark.org/docs/wsug_html_chunked/ChAdvTCPAnalysis.html
// This is not Wireshark's full analysis: no RTT estimation, SACK, reassembly or checksum
// verification (checksum offloading makes the latter misleading in local captures).
const ISSUE_DEFINITIONS = Object.freeze({
  truncated: { label: '捕获截断', severity: 'warning' },
  malformed: { label: '报文格式异常', severity: 'error' },
  'tcp-reset': { label: 'TCP 连接重置', severity: 'warning' },
  'tcp-zero-window': { label: 'TCP 零窗口', severity: 'warning' },
  'tcp-retransmission': { label: '疑似 TCP 重传', severity: 'warning' },
  'tcp-duplicate-ack': { label: '疑似 TCP 重复确认', severity: 'warning' },
  'tcp-out-of-order': { label: '疑似 TCP 乱序', severity: 'warning' },
  'tcp-sequence-gap': { label: '疑似 TCP 序号缺口', severity: 'warning' },
  'icmp-error': { label: 'ICMP 错误报告', severity: 'error' },
  'dns-error': { label: 'DNS 错误响应', severity: 'error' },
});
function addIssue(row, code, message, relatedPacket) {
  if (row.issues.some(issue => issue.code === code)) return;
  row.issues.push({ code, ...ISSUE_DEFINITIONS[code], message, ...(relatedPacket === undefined ? {} : { relatedPacket }) });
}
const unwrap = (raw, reference) => reference + ((raw - (reference >>> 0)) | 0);
const direction = () => ({ top: null, ranges: [], syn: null, last: null, lastPacket: undefined, dataSerial: 0, lastAckPeerSerial: 0, window: null, fin: false });
const newFlow = () => ({ directions: [direction(), direction()], closed: false });
function recordRange(state, start, end, number) {
  // Retain actual packet intervals so relatedPacket really overlaps these bytes.
  // Bounded history loses evidence of old retransmissions, rather than inventing it.
  state.ranges.push({ start, end, number });
  if (state.ranges.length > 256) state.ranges.shift();
}
function analyzeCapture(capture) {
  const flows = new Map();
  for (const packet of capture.packets) {
    const row = packet.row, tcp = packet.tcp;
    if (!tcp) continue;
    const endpoints = [JSON.stringify([row.source, row.sourcePort]), JSON.stringify([row.destination, row.destinationPort])];
    const forward = endpoints[0] < endpoints[1], key = `${packet.flowScope || ''}|${forward ? `${endpoints[0]}|${endpoints[1]}` : `${endpoints[1]}|${endpoints[0]}`}`, index = forward ? 0 : 1;
    let flow = flows.get(key);
    if (!flow) { flow = newFlow(); flows.set(key, flow); }
    const syn = !!(tcp.flags & 2), ack = !!(tcp.flags & 16), rst = !!(tcp.flags & 4), fin = !!(tcp.flags & 1);
    let state = flow.directions[index];
    // A fresh handshake or traffic following reset/bilateral FIN starts a new epoch.
    // Repeated SYNs with the same ISN remain in the existing epoch.
    if (flow.closed || (syn && state.top !== null && state.syn !== tcp.sequence)) {
      flow = newFlow(); flows.set(key, flow); state = flow.directions[index];
    }
    const peer = flow.directions[1 - index], sequence = state.top === null ? tcp.sequence : unwrap(tcp.sequence, state.top), length = tcp.payloadLength + Number(syn) + Number(fin), end = sequence + length;
    const pureAck = ack && !syn && !fin && !rst && tcp.payloadLength === 0;
    const keepalive = !syn && !fin && !rst && tcp.payloadLength <= 1 && state.top !== null && sequence === state.top - 1;
    const probe = !syn && !fin && !rst && tcp.payloadLength === 1 && peer.window === 0 && state.top !== null && (sequence === state.top || sequence === state.top - 1);
    const peerMaintenance = peer.last?.maintenance;
    if (rst) addIssue(row, 'tcp-reset', '该报文设置 RST，连接被重置；也可能是关闭端口、主动中止或正常拒绝连接。');
    if (tcp.window === 0 && !syn && !fin && !rst) addIssue(row, 'tcp-zero-window', '接收端通告窗口为 0，要求对端暂停发送；可能是接收缓冲区或应用处理暂时受限。');
    if (!rst && !keepalive && !probe && length > 0 && state.top !== null) {
      if (sequence > state.top) {
        addIssue(row, 'tcp-sequence-gap', `相同方向的序号比已观察到的下一序号超前 ${sequence - state.top} 字节；可能存在抓包遗漏、乱序或网络丢包，不能据此确认网络丢包。`, state.lastPacket);
      } else if (sequence < state.top) {
        const overlap = state.ranges.find(range => sequence < range.end && end > range.start);
        if (overlap) addIssue(row, 'tcp-retransmission', '该序号区间与先前捕获的报文重叠，疑似重传；重复抓包、镜像或乱序也可能产生相同现象。', overlap.number);
        else addIssue(row, 'tcp-out-of-order', '该序号早于已观察到的最高序号且未与保留的已见区间重叠，疑似迟到的乱序报文；也可能是重传或抓包遗漏。', state.lastPacket);
      }
    }
    // Require newly observed data in the reverse direction, unchanged ACK/SEQ/window
    // and outstanding bytes. Repeated idle ACKs and keepalive/probe replies stay quiet.
    if (pureAck && tcp.window > 0 && !keepalive && !peerMaintenance && state.last?.pureAck &&
        state.last.sequence === tcp.sequence && state.last.acknowledgment === tcp.acknowledgment && state.last.window === tcp.window &&
        peer.top !== null && peer.dataSerial > state.lastAckPeerSerial && unwrap(tcp.acknowledgment, peer.top) < peer.top) {
      addIssue(row, 'tcp-duplicate-ack', 'ACK、序号和窗口未变化，且对向新观察到的数据仍未被此 ACK 确认，疑似重复确认；可能与乱序、重传或抓包遗漏有关。', state.lastPacket);
    }
    if (state.top === null) { state.top = sequence; }
    if (!keepalive && !probe && !rst && length) {
      recordRange(state, sequence, end, row.number);
      state.top = Math.max(state.top, end);
      if (tcp.payloadLength) state.dataSerial++;
    }
    if (syn) state.syn = tcp.sequence;
    if (fin) state.fin = true;
    state.window = tcp.window;
    state.last = { pureAck, sequence: tcp.sequence, acknowledgment: tcp.acknowledgment, window: tcp.window, maintenance: keepalive || probe };
    if (ack) state.lastAckPeerSerial = peer.dataSerial;
    state.lastPacket = row.number;
    flow.closed = rst || (state.fin && peer.fin);
    // A bounded number of flow states avoids pathological one-packet tuple files.
    // Eviction only drops historical evidence; it cannot create an alert.
    if (flows.size > 100000) flows.delete(flows.keys().next().value);
  }
  const analysis = { total: 0, errors: 0, warnings: 0, counts: {} };
  for (const { row } of capture.packets) {
    if (!row.issues.length) continue;
    analysis.total++;
    if (row.issues.some(issue => issue.severity === 'error')) analysis.errors++;
    if (row.issues.some(issue => issue.severity === 'warning')) analysis.warnings++;
    for (const issue of row.issues) analysis.counts[issue.code] = (analysis.counts[issue.code] || 0) + 1;
  }
  capture.summary.analysis = analysis;
}
module.exports = { ISSUE_DEFINITIONS, addIssue, analyzeCapture };
