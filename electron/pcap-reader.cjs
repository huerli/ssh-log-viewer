'use strict';
const fs = require('node:fs/promises');
const { ISSUE_DEFINITIONS, addIssue, analyzeCapture } = require('./pcap-analysis.cjs');

// Container layouts: https://www.ietf.org/archive/id/draft-ietf-opsawg-pcap-05.html
// https://www.ietf.org/archive/id/draft-tuexen-opsawg-pcapng-05.html
// No payload execution, stream reassembly, decompression, or network requests.
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PACKETS = 1000000;
const DETAIL_BYTES = 16 * 1024;
const MAGICS = new Map([
  ['a1b2c3d4', { little: false, scale: 1e6, resolution: 'microseconds' }],
  ['d4c3b2a1', { little: true, scale: 1e6, resolution: 'microseconds' }],
  ['a1b23c4d', { little: false, scale: 1e9, resolution: 'nanoseconds' }],
  ['4d3cb2a1', { little: true, scale: 1e9, resolution: 'nanoseconds' }],
]);
const LINK_NAMES = { 0: 'NULL', 1: 'Ethernet', 101: 'Raw IP', 108: 'Loopback', 113: 'Linux cooked', 228: 'IPv4', 229: 'IPv6', 276: 'Linux cooked v2' };
const linkName = type => LINK_NAMES[type] || `LINKTYPE_${type}`;
const fail = message => { throw new Error(`抓包文件无效：${message}`); };
const align4 = size => Math.ceil(size / 4) * 4;
function reader(buffer, little) {
  return { bytes: buffer, u16: offset => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset),
    u32: offset => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset),
    i64: offset => little ? buffer.readBigInt64LE(offset) : buffer.readBigInt64BE(offset) };
}
async function isCaptureFile(file) {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && (MAGICS.has(head.toString('hex')) || head.toString('hex') === '0a0d0d0a');
  } finally { await handle.close(); }
}
async function loadCapture(file) {
  const handle = await fs.open(file, 'r');
  let buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('请选择普通文件');
    if (stat.size > MAX_BYTES) fail('文件超过 256 MiB 限制');
    // Bounded reads also protect against a file growing between stat and read.
    buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (!result.bytesRead) fail('读取时文件已截断');
      read += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, read)).bytesRead) fail('读取时文件大小已改变，请重新打开');
  } finally { await handle.close(); }
  if (buffer.length < 4) fail('文件头不完整');
  const magic = buffer.subarray(0, 4).toString('hex');
  const capture = { buffer, packets: [], summary: { format: '', byteOrder: '', timeResolution: '', linkTypes: [], packetCount: 0,
    capturedBytes: 0, wireBytes: 0, startTime: null, endTime: null, duration: 0, protocols: {}, warnings: [] } };
  const warn = message => { if (!capture.summary.warnings.includes(message) && capture.summary.warnings.length < 32) capture.summary.warnings.push(message); };
  function add(offset, capturedLength, length, time, linkType, flowScope = 'pcap') {
    if (capture.packets.length >= MAX_PACKETS) fail('数据包超过 1,000,000 条限制');
    if (capturedLength > length) warn('部分数据包捕获长度大于原始长度');
    if (capturedLength < length) warn('包含被截短捕获的数据包；仅解析已捕获字节');
    if (time !== null && (!Number.isFinite(time) || Math.abs(time) > 8640000000000)) {
      warn('部分时间戳超出可显示的日期范围，已标记为不可用'); time = null;
    }
    const decoded = decodePacket(buffer.subarray(offset, offset + capturedLength), linkType);
    const row = { number: capture.packets.length + 1, time, relativeTime: null, ...decoded.row, length, capturedLength };
    if (capturedLength < length) addIssue(row, 'truncated', `仅捕获 ${capturedLength} / ${length} 字节，缺失部分不可解析。`);
    if (capturedLength > length) addIssue(row, 'malformed', '捕获长度大于文件记录的原始报文长度。');
    capture.packets.push({ offset, linkType, flowScope, row, ...(decoded.tcp ? { tcp: decoded.tcp } : {}) });
    const summary = capture.summary;
    summary.capturedBytes += capturedLength;
    summary.wireBytes += length;
    summary.protocols[row.protocol] = (summary.protocols[row.protocol] || 0) + 1;
    if (!summary.linkTypes.includes(linkName(linkType))) summary.linkTypes.push(linkName(linkType));
    if (time !== null) {
      summary.startTime = summary.startTime === null ? time : Math.min(summary.startTime, time);
      summary.endTime = summary.endTime === null ? time : Math.max(summary.endTime, time);
    }
  }
  if (MAGICS.has(magic)) {
    if (buffer.length < 24) fail('PCAP 文件头不完整');
    const config = MAGICS.get(magic), r = reader(buffer, config.little);
    if (r.u16(4) !== 2 || r.u16(6) !== 4) fail('不支持的 PCAP 版本（需要 2.4）');
    capture.summary.format = 'PCAP';
    capture.summary.byteOrder = config.little ? 'little-endian' : 'big-endian';
    capture.summary.timeResolution = config.resolution;
    const snapLength = r.u32(16), linkType = r.u32(20) & 0xffff;
    capture.summary.linkTypes.push(linkName(linkType));
    let offset = 24;
    while (offset < buffer.length) {
      if (buffer.length - offset < 16) fail(`偏移 ${offset} 的数据包头不完整`);
      const seconds = r.u32(offset), fraction = r.u32(offset + 4), capturedLength = r.u32(offset + 8), length = r.u32(offset + 12);
      if (fraction >= config.scale) fail(`数据包 ${capture.packets.length + 1} 的时间戳小数超出范围`);
      if (snapLength && capturedLength > snapLength) warn('部分数据包长度超过文件声明的快照长度');
      offset += 16;
      if (capturedLength > buffer.length - offset) fail(`数据包 ${capture.packets.length + 1} 的内容不完整`);
      add(offset, capturedLength, length, seconds + fraction / config.scale, linkType);
      offset += capturedLength;
    }
  } else if (magic === '0a0d0d0a') {
    capture.summary.format = 'PCAPNG';
    let offset = 0, r, interfaces = [], sections = 0;
    const orders = new Set(), resolutions = new Set();
    while (offset < buffer.length) {
      if (buffer.length - offset < 12) fail(`偏移 ${offset} 的 PCAPNG 块头不完整`);
      const isSection = buffer.readUInt32BE(offset) === 0x0a0d0d0a;
      if (isSection) {
        const bom = buffer.subarray(offset + 8, offset + 12).toString('hex');
        if (bom !== '1a2b3c4d' && bom !== '4d3c2b1a') fail('PCAPNG 字节序标记无效');
        const little = bom === '4d3c2b1a';
        r = reader(buffer, little); orders.add(little ? 'little-endian' : 'big-endian');
      }
      if (!r) fail('PCAPNG 缺少节头');
      const type = r.u32(offset), size = r.u32(offset + 4);
      if (size < 12 || size % 4 || size > buffer.length - offset) fail(`偏移 ${offset} 的 PCAPNG 块长度无效或内容不完整`);
      if (r.u32(offset + size - 4) !== size) fail(`偏移 ${offset} 的 PCAPNG 块首尾长度不一致`);
      const end = offset + size - 4;
      if (isSection) {
        if (size < 28) fail('PCAPNG 节头不完整');
        if (r.u16(offset + 12) !== 1 || r.u16(offset + 14) !== 0) fail('不支持的 PCAPNG 版本（需要 1.0）');
        interfaces = []; sections++;
        options(offset + 24, end, r, () => {});
      } else if (type === 1) {
        if (size < 20) fail('PCAPNG 接口块不完整');
        const iface = { linkType: r.u16(offset + 8), snapLength: r.u32(offset + 12), resolution: 1e-6, resolutionName: 'microseconds', timeOffset: 0 };
        options(offset + 16, end, r, (code, value) => {
          if (code === 9) {
            if (value.length !== 1) fail('PCAPNG 时间分辨率选项长度无效');
            const exponent = value[0] & 127;
            iface.resolution = (value[0] & 128 ? 2 : 10) ** -exponent;
            iface.resolutionName = value[0] === 6 ? 'microseconds' : value[0] === 9 ? 'nanoseconds' : `${value[0] & 128 ? '2' : '10'}^-${exponent} seconds`;
          } else if (code === 14) {
            if (value.length !== 8) fail('PCAPNG 时间偏移选项长度无效');
            // The option bytes use this section's reader and absolute offset.
            iface.timeOffset = Number(r.i64(value.byteOffset - buffer.byteOffset));
          }
        });
        interfaces.push(iface); resolutions.add(iface.resolutionName);
        if (!capture.summary.linkTypes.includes(linkName(iface.linkType))) capture.summary.linkTypes.push(linkName(iface.linkType));
      } else if (type === 6) {
        if (size < 32) fail('PCAPNG 增强数据包块不完整');
        const iface = interfaces[r.u32(offset + 8)];
        if (!iface) fail('PCAPNG 数据包引用了不存在的接口');
        const capturedLength = r.u32(offset + 20), length = r.u32(offset + 24);
        if (align4(capturedLength) > end - (offset + 28)) fail('PCAPNG 数据包内容不完整');
        const ticks = (BigInt(r.u32(offset + 12)) << 32n) | BigInt(r.u32(offset + 16));
        const time = Number(ticks) * iface.resolution + iface.timeOffset;
        if (!Number.isFinite(time)) fail('PCAPNG 时间戳超出范围');
        if (iface.snapLength && capturedLength > iface.snapLength) warn('部分数据包长度超过接口声明的快照长度');
        add(offset + 28, capturedLength, length, time, iface.linkType, `${sections}:${r.u32(offset + 8)}`);
        options(offset + 28 + align4(capturedLength), end, r, () => {});
      } else if (type === 3) {
        if (size < 16) fail('PCAPNG 简单数据包块不完整');
        const iface = interfaces[0];
        if (!iface) fail('PCAPNG 简单数据包缺少接口');
        const length = r.u32(offset + 8), capturedLength = iface.snapLength ? Math.min(length, iface.snapLength) : length;
        if (align4(capturedLength) !== size - 16) fail('PCAPNG 简单数据包内容长度无效');
        add(offset + 12, capturedLength, length, null, iface.linkType, `${sections}:0`);
        warn('简单数据包块没有时间戳');
      } else if (type === 2) {
        warn('跳过旧版 PCAPNG Packet Block（类型 2）');
      }
      offset += size;
    }
    if (!sections) fail('PCAPNG 缺少节头');
    capture.summary.byteOrder = orders.size === 1 ? [...orders][0] : 'mixed';
    capture.summary.timeResolution = resolutions.size === 1 ? [...resolutions][0] : resolutions.size ? 'mixed' : 'unknown';
  } else fail('不支持的文件标记（需要 PCAP 或 PCAPNG）');
  const summary = capture.summary;
  summary.packetCount = capture.packets.length;
  summary.duration = summary.startTime === null ? 0 : summary.endTime - summary.startTime;
  // Relative time follows capture order; out-of-order timestamps can be negative.
  const timeOrigin = capture.packets.find(packet => packet.row.time !== null)?.row.time;
  let previousTime = null;
  for (const packet of capture.packets) {
    packet.row.relativeTime = packet.row.time === null ? null : packet.row.time - timeOrigin;
    packet.row.deltaTime = packet.row.time === null || previousTime === null ? null : packet.row.time - previousTime;
    previousTime = packet.row.time;
  }
  analyzeCapture(capture);
  return capture;
}
function options(start, end, r, visit) {
  let offset = start;
  while (offset < end) {
    if (end - offset < 4) fail('PCAPNG 选项头不完整');
    const code = r.u16(offset), size = r.u16(offset + 2);
    offset += 4;
    if (code === 0) { if (size) fail('PCAPNG 选项结束标记无效'); return; }
    if (align4(size) > end - offset) fail('PCAPNG 选项内容不完整');
    // r is intentionally closed over the complete buffer by loadCapture.
    visit(code, r.bytes.subarray(offset, offset + size));
    offset += align4(size);
  }
}
const mac = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join(':');
const ipv4 = bytes => [...bytes].join('.');
function ipv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  let bestStart = -1, bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let end = i + 1; while (end < 8 && groups[end] === '0') end++;
    if (end - i > bestLength) { bestStart = i; bestLength = end - i; }
    i = end;
  }
  return bestStart < 0 ? groups.join(':') : `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}
function decodePacket(data, linkType) {
  const row = { source: '', destination: '', protocol: 'RAW', info: '', issues: [] }, layers = [];
  let tcp;
  const layer = (name, fields) => layers.push({ name, fields: Object.entries(fields).map(([name, value]) => ({ name, value: String(value) })) });
  const short = (name, invalid = false) => {
    row.info = `${row.info ? `${row.info}; ` : ''}${name} header ${invalid ? 'invalid' : 'truncated'}`;
    addIssue(row, invalid ? 'malformed' : 'truncated', invalid ? `${name} 首部字段或长度无效。` : `${name} 首部不完整，无法继续解析。`);
  };
  const payloadTruncated = name => addIssue(row, 'truncated', `${name} 声明长度超过已捕获字节，内容被截断。`);
  let offset = 0, etherType;
  if (linkType === 1) {
    if (data.length < 14) { short('Ethernet'); return { row, layers }; }
    row.destination = mac(data.subarray(0, 6)); row.source = mac(data.subarray(6, 12));
    etherType = data.readUInt16BE(12); offset = 14;
    layer('Ethernet', { Source: row.source, Destination: row.destination, EtherType: `0x${etherType.toString(16).padStart(4, '0')}` });
    let tags = 0;
    while ([0x8100, 0x88a8, 0x9100].includes(etherType)) {
      if (data.length < offset + 4) { short('VLAN'); return { row, layers }; }
      if (tags++ >= 8) { row.info = 'VLAN nesting exceeds decoder limit'; return { row, layers }; }
      const tci = data.readUInt16BE(offset);
      layer('802.1Q VLAN', { ID: tci & 4095, Priority: tci >> 13, 'Drop eligible': !!(tci & 0x1000) });
      etherType = data.readUInt16BE(offset + 2); offset += 4;
    }
  } else if (linkType === 113 || linkType === 276) {
    offset = linkType === 113 ? 16 : 20;
    if (data.length < offset) { short('Linux cooked'); return { row, layers }; }
    etherType = data.readUInt16BE(linkType === 113 ? 14 : 0);
    layer(linkName(linkType), { Protocol: `0x${etherType.toString(16)}` });
  } else if (linkType === 101 || linkType === 228 || linkType === 229) {
    etherType = linkType === 228 ? 0x0800 : linkType === 229 ? 0x86dd : data.length && data[0] >> 4 === 4 ? 0x0800 : data.length && data[0] >> 4 === 6 ? 0x86dd : undefined;
  } else if (linkType === 0 || linkType === 108) {
    if (data.length < 4) { short('Loopback'); return { row, layers }; }
    const family = linkType === 108 ? data.readUInt32BE(0) : [2, 10, 24, 28, 30].includes(data.readUInt32LE(0)) ? data.readUInt32LE(0) : data.readUInt32BE(0);
    etherType = family === 2 ? 0x0800 : [10, 24, 28, 30].includes(family) ? 0x86dd : undefined;
    offset = 4; layer('Loopback', { Family: family });
  }
  let transport, end = data.length, declaredEnd = data.length;
  if (etherType === 0x0806) {
    row.protocol = 'ARP';
    if (data.length < offset + 8) { short('ARP'); return { row, layers }; }
    const hw = data.readUInt16BE(offset), proto = data.readUInt16BE(offset + 2), hlen = data[offset + 4], plen = data[offset + 5], op = data.readUInt16BE(offset + 6);
    if (data.length < offset + 8 + 2 * (hlen + plen)) { short('ARP'); return { row, layers }; }
    let cursor = offset + 8;
    const senderMAC = mac(data.subarray(cursor, cursor + hlen)); cursor += hlen;
    const senderIP = proto === 0x0800 && plen === 4 ? ipv4(data.subarray(cursor, cursor + plen)) : data.subarray(cursor, cursor + plen).toString('hex'); cursor += plen;
    const targetMAC = mac(data.subarray(cursor, cursor + hlen)); cursor += hlen;
    const targetIP = proto === 0x0800 && plen === 4 ? ipv4(data.subarray(cursor, cursor + plen)) : data.subarray(cursor, cursor + plen).toString('hex');
    row.source = senderIP; row.destination = targetIP;
    row.info = op === 1 ? `Who has ${targetIP}? Tell ${senderIP}` : op === 2 ? `${senderIP} is at ${senderMAC}` : `ARP operation ${op}`;
    layer('ARP', { 'Hardware type': hw, 'Protocol type': `0x${proto.toString(16)}`, Operation: op, 'Sender MAC': senderMAC, 'Sender IP': senderIP, 'Target MAC': targetMAC, 'Target IP': targetIP });
    return { row, layers };
  } else if (etherType === 0x0800) {
    row.protocol = 'IPv4';
    if (data.length < offset + 20) { short('IPv4'); return { row, layers }; }
    if (data[offset] >> 4 !== 4) { short('IPv4', true); return { row, layers }; }
    const header = (data[offset] & 15) * 4, length = data.readUInt16BE(offset + 2);
    if (header < 20 || length < header) { short('IPv4', true); return { row, layers }; }
    if (data.length < offset + header) { short('IPv4'); return { row, layers }; }
    declaredEnd = offset + length;
    if (declaredEnd > data.length) payloadTruncated('IPv4');
    row.source = ipv4(data.subarray(offset + 12, offset + 16)); row.destination = ipv4(data.subarray(offset + 16, offset + 20));
    transport = data[offset + 9];
    const fragment = data.readUInt16BE(offset + 6), fragmentOffset = (fragment & 8191) * 8;
    const fragmented = !!(fragment & 0x3fff);
    layer('IPv4', { Source: row.source, Destination: row.destination, 'Header length': header, 'Total length': length, Protocol: transport, TTL: data[offset + 8], 'Fragment offset': fragmentOffset, 'More fragments': !!(fragment & 0x2000) });
    if (fragmented) { row.info = `IPv4 fragment, offset ${fragmentOffset}${fragment & 0x2000 ? ', more fragments' : ''}`; return { row, layers }; }
    end = Math.min(end, offset + length); offset += header;
  } else if (etherType === 0x86dd) {
    row.protocol = 'IPv6';
    if (data.length < offset + 40) { short('IPv6'); return { row, layers }; }
    if (data[offset] >> 4 !== 6) { short('IPv6', true); return { row, layers }; }
    const length = data.readUInt16BE(offset + 4);
    transport = data[offset + 6]; row.source = ipv6(data.subarray(offset + 8, offset + 24)); row.destination = ipv6(data.subarray(offset + 24, offset + 40));
    layer('IPv6', { Source: row.source, Destination: row.destination, 'Payload length': length, 'Next header': transport, 'Hop limit': data[offset + 7] });
    if (length === 0 && data.length > offset + 40 && transport === 0) {
      row.info = 'Possible IPv6 jumbo payload (not decoded)'; return { row, layers };
    }
    declaredEnd = offset + 40 + length;
    if (declaredEnd > data.length) payloadTruncated('IPv6');
    end = Math.min(end, declaredEnd); offset += 40;
    // Traverse bounded extension headers. Fragmented datagrams are never decoded as transport.
    let extensions = 0;
    while ([0, 43, 44, 51, 60].includes(transport)) {
      if (++extensions > 16) { row.info = 'IPv6 extension nesting exceeds decoder limit'; return { row, layers }; }
      if (end < offset + 2) { short('IPv6 extension'); return { row, layers }; }
      const next = data[offset], size = transport === 44 ? 8 : transport === 51 ? (data[offset + 1] + 2) * 4 : (data[offset + 1] + 1) * 8;
      if (end < offset + size) { short('IPv6 extension'); return { row, layers }; }
      if (transport === 44) {
        const fragment = data.readUInt16BE(offset + 2);
        layer('IPv6 Fragment', { 'Fragment offset': fragment & 0xfff8, 'More fragments': !!(fragment & 1), Identification: data.readUInt32BE(offset + 4) });
        if (fragment & 0xfff9) { row.info = `IPv6 fragment, offset ${fragment & 0xfff8}`; return { row, layers }; }
      } else layer('IPv6 extension', { Type: transport, Length: size, 'Next header': next });
      transport = next; offset += size;
    }
  } else {
    row.info = etherType === undefined ? `Undecoded ${linkName(linkType)}` : `EtherType 0x${etherType.toString(16).padStart(4, '0')}`;
    layer('Raw data', { 'Link type': linkName(linkType), Bytes: data.length });
    return { row, layers };
  }
  if (transport === 6) {
    row.protocol = 'TCP';
    if (declaredEnd < offset + 20) { short('TCP', true); return { row, layers }; }
    if (end < offset + 20) { short('TCP'); return { row, layers }; }
    row.sourcePort = data.readUInt16BE(offset); row.destinationPort = data.readUInt16BE(offset + 2);
    const size = (data[offset + 12] >> 4) * 4;
    if (size < 20 || declaredEnd < offset + size) { short('TCP', true); return { row, layers }; }
    if (end < offset + size) { short('TCP'); return { row, layers }; }
    const flags = data[offset + 13], flagNames = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG', 'ECE', 'CWR'].filter((_, i) => flags & 1 << i).join(', '), payload = data.subarray(offset + size, end);
    row.info = `${row.sourcePort} → ${row.destinationPort} [${flagNames}] Seq=${data.readUInt32BE(offset + 4)} Ack=${data.readUInt32BE(offset + 8)} Len=${payload.length}`;
    layer('TCP', { 'Source port': row.sourcePort, 'Destination port': row.destinationPort, Sequence: data.readUInt32BE(offset + 4), Acknowledgment: data.readUInt32BE(offset + 8), 'Header length': size, Flags: flagNames, Window: data.readUInt16BE(offset + 14), 'Payload bytes': payload.length });
    tcp = { sequence: data.readUInt32BE(offset + 4), acknowledgment: data.readUInt32BE(offset + 8), flags, window: data.readUInt16BE(offset + 14), payloadLength: declaredEnd - offset - size };
    application(payload, row, layer, true);
  } else if (transport === 17) {
    row.protocol = 'UDP';
    if (declaredEnd < offset + 8) { short('UDP', true); return { row, layers }; }
    if (end < offset + 8) { short('UDP'); return { row, layers }; }
    row.sourcePort = data.readUInt16BE(offset); row.destinationPort = data.readUInt16BE(offset + 2);
    const length = data.readUInt16BE(offset + 4);
    if (length < 8 || offset + length > declaredEnd) { short('UDP', true); return { row, layers }; }
    if (offset + length > end) payloadTruncated('UDP');
    const payload = data.subarray(offset + 8, Math.min(end, offset + length));
    row.info = `${row.sourcePort} → ${row.destinationPort} Len=${payload.length}`;
    layer('UDP', { 'Source port': row.sourcePort, 'Destination port': row.destinationPort, Length: length, 'Payload bytes': payload.length });
    application(payload, row, layer, false);
  } else if (transport === 1 || transport === 58) {
    row.protocol = transport === 1 ? 'ICMP' : 'ICMPv6';
    if (end < offset + 4) { short(row.protocol); return { row, layers }; }
    const type = data[offset], code = data[offset + 1];
    const labels = transport === 1 ? { 0: 'Echo reply', 3: 'Destination unreachable', 5: 'Redirect', 8: 'Echo request', 11: 'Time exceeded' } : { 1: 'Destination unreachable', 2: 'Packet too big', 3: 'Time exceeded', 128: 'Echo request', 129: 'Echo reply', 133: 'Router solicitation', 134: 'Router advertisement', 135: 'Neighbor solicitation', 136: 'Neighbor advertisement' };
    row.info = `${labels[type] || `Type ${type}`} (code ${code})`;
    if (transport === 1 ? [3, 4, 11, 12].includes(type) : type >= 1 && type <= 4) addIssue(row, 'icmp-error', `${row.protocol} 报告 ${labels[type] || `类型 ${type}`}（代码 ${code}）；这是控制报文报告的错误，需结合原始通信分析。`);
    layer(row.protocol, { Type: type, Code: code, Description: labels[type] || 'Unknown' });
  } else row.info = `IP protocol ${transport}${transport === 50 ? ' (ESP encrypted)' : transport === 59 ? ' (No next header)' : ''}`;
  return { row, layers, ...(tcp ? { tcp } : {}) };
}
function application(payload, row, layer, tcp) {
  if (row.sourcePort === 53 || row.destinationPort === 53) {
    const dns = tcp ? payload.subarray(2, payload.length >= 2 ? Math.min(payload.length, payload.readUInt16BE(0) + 2) : 0) : payload;
    if (dns.length >= 12) {
      const flags = dns.readUInt16BE(2), question = dnsName(dns, 12);
      row.protocol = 'DNS';
      if ((flags & 0x8000) && (flags & 15)) {
        const names = { 1: '格式错误', 2: '服务器失败', 3: '域名不存在', 4: '不支持的请求', 5: '拒绝查询' };
        addIssue(row, 'dns-error', `DNS 响应 RCODE=${flags & 15}（${names[flags & 15] || '错误响应'}）；域名不存在等响应也可能是正常查询结果。`);
      }
      row.info = `${flags & 0x8000 ? 'Response' : 'Query'} 0x${dns.readUInt16BE(0).toString(16).padStart(4, '0')}${question ? ` ${question}` : ''}${flags & 15 ? ` RCODE=${flags & 15}` : ''}`;
      layer('DNS', { 'Transaction ID': `0x${dns.readUInt16BE(0).toString(16).padStart(4, '0')}`, Response: !!(flags & 0x8000), Questions: dns.readUInt16BE(4), Answers: dns.readUInt16BE(6), 'Question name': question || '(unavailable)' });
      return;
    }
  }
  if (!tcp || !payload.length) return;
  const firstLine = payload.subarray(0, 512).toString('latin1').split(/[\r\n]/, 1)[0];
  if (/^(?:GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH) \S+ HTTP\/1\.[01]$/.test(firstLine) || /^HTTP\/1\.[01] \d{3}(?: |$)/.test(firstLine)) {
    row.protocol = 'HTTP'; row.info = firstLine.replace(/[\x00-\x1f\x7f-\x9f]/g, '.');
    layer('HTTP', { 'Start line': row.info });
  } else if (payload.length >= 5 && payload[0] >= 20 && payload[0] <= 24 && payload[1] === 3 && payload[2] <= 4) {
    const names = { 20: 'Change cipher spec', 21: 'Alert', 22: 'Handshake', 23: 'Application data', 24: 'Heartbeat' };
    row.protocol = 'TLS'; row.info = `TLS ${names[payload[0]]}, record length ${payload.readUInt16BE(3)}`;
    layer('TLS record', { 'Content type': names[payload[0]], 'Legacy version': `0x${payload.readUInt16BE(1).toString(16)}`, 'Record length': payload.readUInt16BE(3), Note: 'Record header only; no decryption or reassembly' });
  }
}
function dnsName(data, start) {
  let offset = start, labels = [], seen = new Set(), bytes = 0;
  while (offset < data.length && seen.size < 128 && bytes <= 255) {
    if (seen.has(offset)) return ''; seen.add(offset);
    const size = data[offset++];
    if (!size) return labels.join('.') || '.';
    if ((size & 0xc0) === 0xc0) {
      if (offset >= data.length) return '';
      offset = ((size & 0x3f) << 8) | data[offset]; continue;
    }
    if (size > 63 || offset + size > data.length) return '';
    labels.push(data.subarray(offset, offset + size).toString('latin1').replace(/[^a-zA-Z0-9_*-]/g, '.')); bytes += size + 1; offset += size;
  }
  return '';
}
// Search uses a case-insensitive literal substring across all row metadata.
// `ascii:text` searches ALL captured packet bytes as Latin-1 (case-insensitive).
// `hex:de ad be ef` searches ALL captured bytes; hex must contain complete byte pairs.
// These explicit byte modes search the entire frame, including protocol headers.
// Metadata search includes anomaly labels/messages. `issue` is any/error/warning/a
// supported issue code; only the latest protocol/query/issue index set is cached.
const queryCache = new WeakMap();
const publicRow = row => ({ ...row, issues: row.issues.map(issue => ({ ...issue })) });
function queryCapture(capture, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('无效的抓包查询参数');
  const { offset = 0, limit = 100, protocol = '', query = '', issue = '' } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PACKETS) throw new Error('无效分页位置');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('每页数据包数量必须为 1–10000');
  if (typeof protocol !== 'string' || protocol.length > 64 || typeof query !== 'string' || query.length > 2048) throw new Error('搜索内容不得超过 2048 字符，协议不得超过 64 字符');
  if (typeof issue !== 'string' || !['', 'any', 'error', 'warning', ...Object.keys(ISSUE_DEFINITIONS)].includes(issue)) throw new Error('无效异常筛选条件');
  const term = query.toLowerCase(), wanted = protocol.toUpperCase();
  let mode = 'metadata', needle = term;
  if (term.startsWith('ascii:')) { mode = 'ascii'; needle = term.slice(6); }
  else if (term.startsWith('hex:')) {
    mode = 'hex'; const hex = term.slice(4).replace(/\s/g, '');
    if (!hex.length || hex.length % 2 || !/^[a-f0-9]+$/.test(hex)) throw new Error('十六进制搜索需要完整的字节对，例如 hex:de ad be ef');
    needle = Buffer.from(hex, 'hex');
  }
  const key = JSON.stringify([wanted, term, issue]);
  let cached = queryCache.get(capture);
  if (!cached || cached.key !== key) {
    const indices = [];
    for (let index = 0; index < capture.packets.length; index++) {
      const packet = capture.packets[index], row = packet.row;
      if (wanted && row.protocol.toUpperCase() !== wanted) continue;
      if (issue && !(issue === 'any' ? row.issues.length : row.issues.some(item => item.severity === issue || item.code === issue))) continue;
      if (query) {
        if (mode === 'metadata' && !`${Object.values(row).join(' ')} ${row.issues.map(item => `${item.code} ${item.label} ${item.message}`).join(' ')}`.toLowerCase().includes(needle)) continue;
        if (mode !== 'metadata') {
          const data = capture.buffer.subarray(packet.offset, packet.offset + row.capturedLength);
          if (mode === 'hex' ? data.indexOf(needle) < 0 : !data.toString('latin1').toLowerCase().includes(needle)) continue;
        }
      }
      indices.push(index);
    }
    // Only the most recent filter survives. Paging/virtual scrolling reuses it.
    cached = { key, indices }; queryCache.set(capture, cached);
  }
  const total = cached.indices.length, rows = cached.indices.slice(offset, offset + limit).map(index => publicRow(capture.packets[index].row));
  return { summary: capture.summary, rows, total, offset, hasMore: offset + rows.length < total };
}
function captureDetail(capture, number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > capture.packets.length) throw new Error('无效数据包编号');
  const packet = capture.packets[number - 1], full = capture.buffer.subarray(packet.offset, packet.offset + packet.row.capturedLength), data = full.subarray(0, DETAIL_BYTES);
  const ascii = bytes => [...bytes].map(value => value >= 32 && value <= 126 ? String.fromCharCode(value) : '.').join('');
  const lines = [];
  for (let i = 0; i < data.length; i += 16) {
    const bytes = data.subarray(i, i + 16);
    lines.push(`${i.toString(16).padStart(8, '0')}  ${[...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  |${ascii(bytes)}|`);
  }
  return { packet: publicRow(packet.row), layers: [{ name: 'Frame', fields: [
    { name: 'Number', value: String(number) }, { name: 'Link type', value: linkName(packet.linkType) },
    { name: 'Captured length', value: String(packet.row.capturedLength) }, { name: 'Original length', value: String(packet.row.length) },
    { name: 'Timestamp (seconds)', value: packet.row.time === null ? 'Unavailable' : String(packet.row.time) },
  ] }, ...decodePacket(full, packet.linkType).layers, ...(packet.row.issues.length ? [{ name: 'Analysis', fields: packet.row.issues.map(issue => ({ name: issue.label, value: `${issue.message}${issue.relatedPacket ? `（关联报文 #${issue.relatedPacket}）` : ''}` })) }] : [])], hex: lines.join('\n'), ascii: ascii(data), truncated: full.length > DETAIL_BYTES };
}
module.exports = { isCaptureFile, loadCapture, queryCapture, captureDetail, ISSUE_DEFINITIONS };
