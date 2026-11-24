import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { createCaptureSession } = createRequire(import.meta.url)('../electron/pcap-session.cjs');

test('capture worker handles queries, invalid packets, and disposal', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pcap-session-'));
  let session;
  try {
    const file = path.join(temp, 'empty.pcap');
    await fs.writeFile(file, Buffer.from('d4c3b2a1020004000000000000000000ffff000001000000', 'hex'));
    session = createCaptureSession(file);
    assert.equal((await session.ready).packetCount, 0);
    const results = await Promise.all([session.query({}), session.query({ query: 'missing' })]);
    assert.deepEqual(results.map(item => item.total), [0, 0]);
    await assert.rejects(session.detail(1), /编号/);
    const pending = session.query({});
    const rejection = assert.rejects(pending, /已关闭/);
    await session.dispose(); await rejection;
    await assert.rejects(session.query({}), /已关闭/);
  } finally { await session?.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
});

test('capture worker returns malformed-file errors and closes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pcap-session-bad-'));
  let session;
  try {
    const file = path.join(temp, 'invalid.pcap'); await fs.writeFile(file, 'invalid');
    session = createCaptureSession(file);
    await assert.rejects(session.ready, /抓包|PCAP|pcap/);
    await assert.rejects(session.query({}), /已关闭/);
  } finally { await session?.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
});
