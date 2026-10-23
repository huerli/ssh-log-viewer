import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createTelnetLog } = createRequire(import.meta.url)('../electron/telnet-log.cjs');

test('Telnet session logs are dated, unique and persist previous output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telnet-log-'));
  try {
    const now = new Date(2026, 9, 23, 12, 34, 56);
    const first = await createTelnetLog(root, '2098267890303311', now);
    await appendFile(first, '设备输出\r\n');
    const next = await createTelnetLog(root, '2098267890303311', now);
    assert.notEqual(first, next);
    assert.equal(path.dirname(first), path.join(root, 'telnet', '2026-10-23', '2098267890303311'));
    assert.equal(await readFile(first, 'utf8'), '设备输出\r\n');
    assert.equal(await readFile(next, 'utf8'), '');
    const local = await createTelnetLog(root, '192.168.20.7', now);
    assert.equal(path.dirname(local), path.join(root, 'telnet', '2026-10-23', '192.168.20.7'));
    const unsafe = await createTelnetLog(root, '../../outside', now);
    assert.ok(unsafe.startsWith(path.join(root, 'telnet', '2026-10-23') + path.sep));
  } finally { await rm(root, { recursive: true, force: true }); }
});
