import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { isCaptureFile, loadCapture, queryCapture, captureDetail } = createRequire(import.meta.url)('../electron/pcap-reader.cjs');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pcap-reader-'));
test.after(() => fs.rm(temporary, { recursive: true, force: true }));
let serial = 0;
async function file(bytes) { const name = path.join(temporary, `${serial++}.bin`); await fs.writeFile(name, bytes); return name; }
function pcap(packets = [], { little = true, nano = false, link = 1 } = {}) {
  const head = Buffer.alloc(24);
  const u16 = (b, value, at) => little ? b.writeUInt16LE(value, at) : b.writeUInt16BE(value, at);
  const u32 = (b, value, at) => little ? b.writeUInt32LE(value, at) : b.writeUInt32BE(value, at);
  u32(head, nano ? 0xa1b23c4d : 0xa1b2c3d4, 0); u16(head, 2, 4); u16(head, 4, 6); u32(head, 262144, 16); u32(head, link, 20);
  return Buffer.concat([head, ...packets.flatMap((packet, i) => {
    const data = Buffer.isBuffer(packet) ? packet : packet.data, record = Buffer.alloc(16);
    u32(record, packet.seconds ?? i + 1, 0); u32(record, packet.fraction ?? 0, 4); u32(record, data.length, 8); u32(record, packet.length ?? data.length, 12);
    return [record, data];
  })]);
}
function ethernet(payload, type = 0x0800) {
  const header = Buffer.from('00112233445566778899aabb0000', 'hex'); header.writeUInt16BE(type, 12); return Buffer.concat([header, payload]);
}
function ip(payload, protocol = 6, fragment = 0) {
  const header = Buffer.alloc(20); header[0] = 0x45; header.writeUInt16BE(20 + payload.length, 2); header.writeUInt16BE(fragment, 6); header[8] = 64; header[9] = protocol;
  Buffer.from([10, 0, 0, 1, 10, 0, 0, 2]).copy(header, 12); return Buffer.concat([header, payload]);
}
function tcp(payload = Buffer.from('GET /hello HTTP/1.1\r\nHost: example.test\r\n\r\n'), src = 12345, dst = 80, options = {}) {
  const header = Buffer.alloc(20); header.writeUInt16BE(src); header.writeUInt16BE(dst, 2); header[12] = 0x50; header[13] = options.flags ?? 0x18; header.writeUInt32BE(options.sequence ?? 0, 4); header.writeUInt32BE(options.acknowledgment ?? 0, 8); header.writeUInt16BE(options.window ?? 65535, 14); return Buffer.concat([header, payload]);
}
function udp(payload, src = 23456, dst = 53) { const header = Buffer.alloc(8); header.writeUInt16BE(src); header.writeUInt16BE(dst, 2); header.writeUInt16BE(payload.length + 8, 4); return Buffer.concat([header, payload]); }
function block(type, body, little = true) {
  const result = Buffer.alloc(12 + Math.ceil(body.length / 4) * 4), write = (value, at) => little ? result.writeUInt32LE(value, at) : result.writeUInt32BE(value, at);
  write(type, 0); write(result.length, 4); body.copy(result, 8); write(result.length, result.length - 4); return result;
}
function section(little = true) {
  const body = Buffer.alloc(16); little ? body.writeUInt32LE(0x1a2b3c4d) : body.writeUInt32BE(0x1a2b3c4d);
  little ? body.writeUInt16LE(1, 4) : body.writeUInt16BE(1, 4); body.fill(255, 8); return block(0x0a0d0d0a, body, little);
}
function iface(little = true, resolution = 6, timeOffset = 0n, snap = 65535, link = 1) {
  const body = Buffer.alloc(32), w16 = (v, at) => little ? body.writeUInt16LE(v, at) : body.writeUInt16BE(v, at), w32 = (v, at) => little ? body.writeUInt32LE(v, at) : body.writeUInt32BE(v, at);
  w16(link, 0); w32(snap, 4); w16(9, 8); w16(1, 10); body[12] = resolution;
  w16(14, 16); w16(8, 18); little ? body.writeBigInt64LE(timeOffset, 20) : body.writeBigInt64BE(timeOffset, 20); return block(1, body, little);
}
function enhanced(data, little = true, ticks = 1500000n, id = 0) {
  const body = Buffer.alloc(20 + Math.ceil(data.length / 4) * 4), w32 = (v, at) => little ? body.writeUInt32LE(v, at) : body.writeUInt32BE(v, at);
  w32(id, 0); w32(Number(ticks >> 32n), 4); w32(Number(ticks & 0xffffffffn), 8); w32(data.length, 12); w32(data.length, 16); data.copy(body, 20); return block(6, body, little);
}
const httpPacket = ethernet(ip(tcp()));
test('all four PCAP magic values, real timestamps, paging and details', async () => {
  for (const little of [true, false]) for (const nano of [true, false]) {
    const name = await file(pcap([{ data: httpPacket, seconds: 0, fraction: nano ? 125000000 : 125000 }, { data: httpPacket, seconds: 2 }], { little, nano }));
    assert.equal(await isCaptureFile(name), true);
    const capture = await loadCapture(name), page = queryCapture(capture, { limit: 1 });
    assert.equal(capture.summary.format, 'PCAP'); assert.equal(capture.summary.byteOrder, little ? 'little-endian' : 'big-endian');
    assert.equal(capture.summary.timeResolution, nano ? 'nanoseconds' : 'microseconds');
    assert.equal(page.total, 2); assert.equal(page.rows[0].time, .125); assert.equal(page.rows[0].relativeTime, 0); assert.equal(page.hasMore, true);
    assert.equal(capture.summary.duration, 1.875); assert.equal(capture.summary.protocols.HTTP, 2);
    assert.equal(page.rows[0].source, '10.0.0.1'); assert.equal(page.rows[0].sourcePort, 12345);
    assert.equal(queryCapture(capture, { offset: 1 }).rows[0].number, 2);
    const detail = captureDetail(capture, 1);
    assert.deepEqual(detail.layers.map(x => x.name), ['Frame', 'Ethernet', 'IPv4', 'TCP', 'HTTP']);
    assert.match(detail.hex, /^00000000  00 11 22/); assert.match(detail.ascii, /GET \/hello HTTP\/1.1/); assert.equal(detail.truncated, false);
  }
});
test('metadata and explicit full-frame byte search; validated bounded inputs', async () => {
  const capture = await loadCapture(await file(pcap([httpPacket, ethernet(ip(udp(Buffer.from('secretPayload'), 10, 20), 17))])));
  assert.equal(queryCapture(capture, { query: 'HTTP/1.1' }).total, 1);
  assert.equal(queryCapture(capture, { query: '10.0.0.1' }).total, 2);
  assert.equal(queryCapture(capture, { query: 'secretPayload' }).total, 0);
  assert.equal(queryCapture(capture, { query: 'ascii:SECRETPAYLOAD' }).total, 1);
  assert.equal(queryCapture(capture, { query: 'hex:73 65 63 72 65 74' }).total, 1);
  assert.equal(queryCapture(capture, { protocol: 'udp', query: '20' }).total, 1);
  assert.equal(queryCapture(capture, { offset: 10 }).hasMore, false);
  for (const options of [{ offset: -1 }, { limit: 10001 }, { offset: NaN }, { query: 4 }, { query: 'x'.repeat(2049) }, { query: 'hex:abc' }, { query: 'hex:zz' }, null]) assert.throws(() => queryCapture(capture, options));
  for (const number of [0, -1, 3, 1.5]) assert.throws(() => captureDetail(capture, number));
});
test('DNS query, TLS record, VLAN, ARP and ICMP decoding', async () => {
  const dns = Buffer.concat([Buffer.from('abcd01000001000000000000', 'hex'), Buffer.from([3]), Buffer.from('www'), Buffer.from([7]), Buffer.from('example'), Buffer.from([3]), Buffer.from('com'), Buffer.from([0, 0, 1, 0, 1])]);
  const vlan = Buffer.concat([httpPacket.subarray(0, 12), Buffer.from('8100002a0800', 'hex'), httpPacket.subarray(14)]);
  const arp = ethernet(Buffer.from('000108000604000166778899aabb0a0000010000000000000a000002', 'hex'), 0x0806);
  const capture = await loadCapture(await file(pcap([ethernet(ip(udp(dns), 17)), ethernet(ip(tcp(Buffer.from('160303000401000000', 'hex'), 10, 443))), vlan, arp, ethernet(ip(Buffer.from('0800000000010001', 'hex'), 1))])));
  const rows = queryCapture(capture).rows;
  assert.deepEqual(rows.map(x => x.protocol), ['DNS', 'TLS', 'HTTP', 'ARP', 'ICMP']);
  assert.match(rows[0].info, /www.example.com/); assert.match(rows[3].info, /Who has 10.0.0.2/);
  assert.equal(captureDetail(capture, 3).layers[2].fields[0].value, '42');
});
test('fragmented IPv4 and IPv6 never become false TCP/UDP packets', async () => {
  const v6 = Buffer.alloc(40); v6[0] = 0x60; v6[6] = 44; v6[7] = 64; v6.writeUInt16BE(28, 4); v6[23] = 1; v6[39] = 2;
  const frag = Buffer.alloc(8); frag[0] = 6; frag.writeUInt16BE(9, 2);
  const capture = await loadCapture(await file(pcap([ethernet(ip(tcp(), 6, 0x2000)), ethernet(ip(tcp(), 6, 1)), ethernet(Buffer.concat([v6, frag, tcp(Buffer.alloc(0))]), 0x86dd)])));
  const rows = queryCapture(capture).rows;
  assert.deepEqual(rows.map(x => x.protocol), ['IPv4', 'IPv4', 'IPv6']);
  assert.equal(rows[2].source, '::1'); assert.ok(rows.every(x => x.sourcePort === undefined));
});
test('unknown links remain raw; incomplete protocol bytes do not crash; detail cap', async () => {
  const data = Buffer.alloc(17000, 65), capture = await loadCapture(await file(pcap([data], { link: 999 })));
  assert.equal(queryCapture(capture).rows[0].protocol, 'RAW'); assert.deepEqual(capture.summary.linkTypes, ['LINKTYPE_999']);
  const detail = captureDetail(capture, 1); assert.equal(detail.ascii.length, 16384); assert.equal(detail.truncated, true);
  for (let size = 0; size < httpPacket.length; size++) {
    const partial = await loadCapture(await file(pcap([httpPacket.subarray(0, size)])));
    assert.doesNotThrow(() => captureDetail(partial, 1));
  }
});
test('PCAPNG sections change byte order, interface resolution and signed offsets', async () => {
  const capture = await loadCapture(await file(Buffer.concat([section(true), iface(true, 9, -2n), enhanced(httpPacket, true, 3125000000n), section(false), iface(false, 0x8a, 4n), enhanced(httpPacket, false, 1024n)])));
  assert.equal(capture.summary.format, 'PCAPNG'); assert.equal(capture.summary.byteOrder, 'mixed'); assert.equal(capture.summary.timeResolution, 'mixed');
  assert.deepEqual(queryCapture(capture).rows.map(x => x.time), [1.125, 5]); assert.equal(capture.summary.duration, 3.875);
});
test('PCAPNG SPB has no fabricated timestamp, honors snapshot length and padding', async () => {
  const body = Buffer.alloc(4 + 12); body.writeUInt32LE(100); httpPacket.copy(body, 4, 0, 10);
  const capture = await loadCapture(await file(Buffer.concat([section(), iface(true, 6, 0n, 10), block(3, body)])));
  assert.equal(capture.summary.startTime, null); assert.equal(capture.summary.duration, 0); assert.equal(queryCapture(capture).rows[0].capturedLength, 10); assert.equal(queryCapture(capture).rows[0].relativeTime, null);
  assert.match(capture.summary.warnings.join(' '), /没有时间戳/);
});
test('malformed/truncated containers reject clearly, including bad options and interface IDs', async () => {
  const valid = pcap([httpPacket]);
  const badFraction = Buffer.from(valid); badFraction.writeUInt32LE(1000000, 28);
  const invalidBlock = Buffer.from(section()); invalidBlock.writeUInt32LE(100, 4);
  const mismatch = Buffer.from(section()); mismatch.writeUInt32LE(24, mismatch.length - 4);
  const badOption = Buffer.from(iface()); badOption.writeUInt16LE(65535, 18);
  const cases = [Buffer.from('nope'), valid.subarray(0, 23), valid.subarray(0, 30), valid.subarray(0, -1), badFraction, invalidBlock, mismatch,
    Buffer.concat([section(), enhanced(httpPacket)]), Buffer.concat([section(), iface(), enhanced(httpPacket, true, 1n, 1)]), Buffer.concat([section(), badOption])];
  for (const bytes of cases) await assert.rejects(loadCapture(await file(bytes)), /抓包文件无效/);
  assert.equal(await isCaptureFile(await file(Buffer.from('pcap'))), false);
  const oversized = await file(Buffer.alloc(0)); await fs.truncate(oversized, 256 * 1024 * 1024 + 1);
  await assert.rejects(loadCapture(oversized), /256 MiB/);
});
test('extreme PCAPNG timestamps are unavailable and empty captures have numeric duration', async () => {
  const capture = await loadCapture(await file(Buffer.concat([section(), iface(true, 6, 9223372036854775807n), enhanced(httpPacket)])));
  assert.equal(queryCapture(capture).rows[0].time, null); assert.equal(capture.summary.startTime, null); assert.equal(capture.summary.duration, 0);
  assert.match(capture.summary.warnings.join(' '), /日期范围/);
  const empty = await loadCapture(await file(pcap())); assert.equal(empty.summary.packetCount, 0); assert.equal(empty.summary.duration, 0);
});
test('relative times follow first timestamp in capture order while summary spans min/max', async () => {
  const capture = await loadCapture(await file(pcap([{ data: httpPacket, seconds: 10 }, { data: httpPacket, seconds: 8 }, { data: httpPacket, seconds: 12 }])));
  assert.deepEqual(queryCapture(capture).rows.map(row => row.relativeTime), [0, -2, 2]);
  assert.equal(capture.summary.startTime, 8); assert.equal(capture.summary.endTime, 12); assert.equal(capture.summary.duration, 4);
});
function segment(sequence, length = 0, options = {}) {
  const body = ip(tcp(options.payload ?? Buffer.alloc(length, 65), options.reverse ? 80 : 12345, options.reverse ? 12345 : 80, { ...options, sequence }));
  if (options.reverse) { Buffer.from([10, 0, 0, 2, 10, 0, 0, 1]).copy(body, 12); }
  return ethernet(body);
}
const codes = row => row.issues.map(issue => issue.code);
test('TCP tracks directional byte intervals, gaps, delayed segments and retransmissions', async () => {
  const capture = await loadCapture(await file(pcap([segment(100, 10), segment(120, 10), segment(110, 10), segment(100, 10)])));
  const rows = queryCapture(capture).rows;
  assert.deepEqual(rows.map(codes), [[], ['tcp-sequence-gap'], ['tcp-out-of-order'], ['tcp-retransmission']]);
  assert.equal(rows[3].issues[0].relatedPacket, 1);
  assert.match(rows[1].issues[0].message, /不能据此确认网络丢包/);
  assert.deepEqual(capture.summary.analysis, { total: 3, errors: 0, warnings: 3, counts: { 'tcp-sequence-gap': 1, 'tcp-out-of-order': 1, 'tcp-retransmission': 1 } });
  assert.deepEqual(captureDetail(capture, 4).packet.issues, rows[3].issues);
  assert.equal(captureDetail(capture, 4).layers.at(-1).name, 'Analysis');
});
test('TCP wraparound and mid-capture first observations do not invent missing handshakes', async () => {
  const capture = await loadCapture(await file(pcap([segment(0xfffffffc, 4), segment(0, 4), segment(4, 4), segment(0xfffffffc, 4)])));
  assert.deepEqual(queryCapture(capture).rows.map(codes), [[], [], [], ['tcp-retransmission']]);
  const applicationCapture = await loadCapture(await file(pcap([segment(900, 0, { payload: Buffer.from('GET / HTTP/1.1\r\n\r\n') }), segment(900, 0, { payload: Buffer.from('GET / HTTP/1.1\r\n\r\n') })])));
  assert.equal(queryCapture(applicationCapture).rows[0].protocol, 'HTTP');
  assert.deepEqual(codes(queryCapture(applicationCapture).rows[1]), ['tcp-retransmission']);
});
test('duplicate ACK requires outstanding reverse-direction data; idle repeated pure ACK is quiet', async () => {
  const capture = await loadCapture(await file(pcap([
    segment(100, 10), segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16 }),
    segment(120, 10), segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16 }),
    segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16 }),
    segment(130, 0, { acknowledgment: 500, flags: 16 }), segment(130, 0, { acknowledgment: 500, flags: 16 }),
  ])));
  const rows = queryCapture(capture).rows;
  assert.deepEqual(codes(rows[3]), ['tcp-duplicate-ack']);
  assert.equal(rows[3].issues[0].relatedPacket, 2);
  assert.deepEqual(codes(rows[4]), []); assert.deepEqual(codes(rows[5]), []); assert.deepEqual(codes(rows[6]), []);
});
test('keepalives, zero-window probes and their ACKs do not become retransmission or duplicate ACK alerts', async () => {
  const capture = await loadCapture(await file(pcap([
    segment(100, 10), segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16 }),
    segment(109, 1), segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16 }),
    segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16, window: 0 }),
    segment(110, 1), segment(500, 0, { reverse: true, acknowledgment: 110, flags: 16, window: 0 }),
    segment(110, 1), segment(110, 10),
  ])));
  const rows = queryCapture(capture).rows;
  assert.equal(capture.summary.analysis.counts['tcp-zero-window'], 2);
  assert.ok(rows.every(row => codes(row).every(code => code === 'tcp-zero-window')));
});
test('fresh handshake and post-reset reuse isolate TCP sequence history', async () => {
  const capture = await loadCapture(await file(pcap([
    segment(100, 10), segment(9000, 0, { flags: 2 }), segment(9001, 4),
    segment(9005, 0, { flags: 20 }), segment(40, 4), segment(44, 4),
  ])));
  assert.deepEqual(queryCapture(capture).rows.map(codes), [[], [], [], ['tcp-reset'], [], []]);
});
test('snap-truncated TCP payload uses declared sequence length, fragments never enter TCP analysis', async () => {
  const full = segment(100, 100), capture = await loadCapture(await file(pcap([
    { data: full.subarray(0, -50), length: full.length }, segment(200, 10), ethernet(ip(tcp(Buffer.alloc(20)), 6, 0x2000)),
  ])));
  assert.deepEqual(queryCapture(capture).rows.map(codes), [['truncated'], [], []]);
});
test('malformed headers and DNS/ICMP errors are flagged without checksum guesses', async () => {
  const badTCP = segment(100); badTCP[14 + 20 + 12] = 0x10;
  const badIPv4 = segment(100); badIPv4[14] = 0x41;
  const dns = Buffer.from('abcd81830000000000000000', 'hex');
  const capture = await loadCapture(await file(pcap([badTCP, badIPv4, ethernet(ip(udp(dns), 17)), ethernet(ip(Buffer.from('0303000000000000', 'hex'), 1)), ethernet(ip(Buffer.from('0800000000000000', 'hex'), 1))])));
  const rows = queryCapture(capture).rows;
  assert.deepEqual(rows.map(codes), [['malformed'], ['malformed'], ['dns-error'], ['icmp-error'], []]);
  assert.equal(capture.summary.analysis.errors, 4); assert.equal(capture.summary.analysis.warnings, 0);
});
test('issue filters, labels/messages search, larger result windows and single-cache replacement', async () => {
  const packets = Array.from({ length: 1200 }, (_, index) => segment(index * 2, 1));
  const capture = await loadCapture(await file(pcap(packets)));
  assert.equal(queryCapture(capture, { limit: 10000 }).rows.length, 1200);
  const page = queryCapture(capture, { issue: 'warning', limit: 400 });
  assert.equal(page.total, 1199); assert.equal(page.rows[0].number, 2);
  const cacheProof = capture.packets[0].row.issues;
  // No scan when only pagination changes: accessor would throw during a scan.
  Object.defineProperty(capture.packets[0].row, 'issues', { get() { throw new Error('unexpected rescan'); }, configurable: true });
  assert.equal(queryCapture(capture, { issue: 'warning', offset: 400, limit: 400 }).rows[0].number, 402);
  Object.defineProperty(capture.packets[0].row, 'issues', { value: cacheProof, configurable: true, writable: true });
  assert.equal(queryCapture(capture, { issue: 'tcp-sequence-gap', query: '疑似' }).total, 1199);
  assert.equal(queryCapture(capture, { issue: 'any', query: '抓包遗漏' }).total, 1199);
  assert.equal(queryCapture(capture, { issue: 'error' }).total, 0);
  assert.equal(queryCapture(capture, { issue: '', query: '' }).total, 1200);
  assert.throws(() => queryCapture(capture, { issue: 'unknown' }), /无效异常/);
  assert.throws(() => queryCapture(capture, { issue: {} }), /无效异常/);
  page.rows[0].issues[0].label = 'mutated';
  assert.notEqual(captureDetail(capture, 2).packet.issues[0].label, 'mutated');
});
test('summary counts unique packets once and separately counts each severity and issue code', async () => {
  const capture = await loadCapture(await file(pcap([{ data: segment(100, 0, { window: 0 }), length: 10 }])));
  assert.deepEqual(capture.summary.analysis, { total: 1, errors: 1, warnings: 1, counts: { malformed: 1, 'tcp-zero-window': 1 } });
  assert.equal(queryCapture(capture, { issue: 'any' }).total, 1);
  assert.equal(queryCapture(capture, { issue: 'error' }).total, 1);
  assert.equal(queryCapture(capture, { issue: 'warning' }).total, 1);
});

test('packet gaps keep original capture order after filtering and stop at missing timestamps', async () => {
  const capture = await loadCapture(await file(pcap([
    { data: httpPacket, seconds: 2, fraction: 100 },
    { data: httpPacket, seconds: 2, fraction: 297 },
    { data: httpPacket, seconds: 1, fraction: 500000 },
  ])));
  const rows = queryCapture(capture).rows;
  assert.equal(rows[0].deltaTime, null);
  assert.ok(Math.abs(rows[1].deltaTime - .000197) < 1e-12);
  assert.ok(rows[2].deltaTime < 0, 'out-of-order timestamps retain their signed gap');
  assert.equal(queryCapture(capture, { query: '1.5' }).rows[0].deltaTime, rows[2].deltaTime);
  const body = Buffer.alloc(4 + Math.ceil(httpPacket.length / 4) * 4);
  body.writeUInt32LE(httpPacket.length); httpPacket.copy(body, 4);
  const missing = await loadCapture(await file(Buffer.concat([section(), iface(), enhanced(httpPacket), block(3, body), enhanced(httpPacket, true, 2500000n)])));
  assert.deepEqual(queryCapture(missing).rows.map(row => row.deltaTime), [null, null, null]);
});
