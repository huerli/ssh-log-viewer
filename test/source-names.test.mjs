import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import names from '../electron/source-names.cjs';
const { sourceIdentity, sourceFilename, downloadPath, extractionPath } = names;

test('download names identify target, account, port, label and jump endpoint', () => {
  const profile = { name: '设备A', username: 'root', host: '192.168.1.10', port: 2220 };
  const source = sourceIdentity(profile);
  assert.equal(source.tag, '设备A--root@192.168.1.10_2220');
  assert.equal(sourceFilename(source.tag, 'signal.log.gz'), '设备A--root@192.168.1.10_2220__signal.log.gz');
  assert.notEqual(source.tag, sourceIdentity({ ...profile, port: 2221 }).tag);
  assert.notEqual(source.tag, sourceIdentity({ ...profile, username: 'tester' }).tag);
  const hopped = sourceIdentity({ ...profile, host: 'localhost', jump: { enabled: true, username: 'jumper', host: '10.0.0.1', port: 22 } });
  assert.match(hopped.tag, /root@localhost_2220--via-jumper@10\.0\.0\.1_22$/);
  assert.match(hopped.label, /经 jumper@10\.0\.0\.1:22/);
});

test('long and IPv6 names stay portable, preserve archive extensions and leave room for collisions', () => {
  const profile = { name: '设备'.repeat(70), username: 'root', host: '::1', port: 22 };
  const source = sourceIdentity(profile);
  assert.ok(Buffer.byteLength(source.tag) <= 96);
  assert.notEqual(source.tag, sourceIdentity({ ...profile, host: '::2' }).tag);
  const original = '日志'.repeat(90) + '.tar.gz';
  const file = sourceFilename(source.tag, original, '12345678');
  assert.ok(Buffer.byteLength(file) <= 255);
  assert.ok(file.endsWith('.tar.gz'));
  assert.ok(!/[<>:"/\\|?*\x00-\x1f\uFFFD]/.test(file));
  assert.ok(file.startsWith(source.tag + '__12345678-'));
});


test('download directories group by local hour, with zero padding and distinct hours', () => {
  const root = path.resolve('downloads');
  const remote = '/data/log/signal.log.gz';
  assert.equal(downloadPath(root, '127.0.0.1', remote, new Date(2026, 9, 22, 9, 59)), path.join(root, '127.0.0.1', 'log', '2026-10-22_09', 'signal.log.gz'));
  assert.equal(downloadPath(root, '127.0.0.1', remote, new Date(2026, 9, 22, 10, 0)), path.join(root, '127.0.0.1', 'log', '2026-10-22_10', 'signal.log.gz'));
  assert.equal(downloadPath(root, '127.0.0.1', remote, new Date(2026, 9, 23, 0, 0), '12345678'), path.join(root, '127.0.0.1', 'log', '2026-10-23_00', 'signal.log-12345678.gz'));
});


test('remote extraction paths use the same hourly hierarchy and readable archive names', () => {
  const root = path.resolve('extracted');
  const date = new Date(2026, 9, 22, 9);
  assert.equal(extractionPath(root, '127.0.0.1', '/system/log/monitor.log.gz', date), path.join(root, '127.0.0.1', 'log', '2026-10-22_09', 'monitor.log'));
  assert.equal(extractionPath(root, '127.0.0.1', '/logs.tar.gz', date), path.join(root, '127.0.0.1', 'root', '2026-10-22_09', 'logs'));
});

test('jump downloads and extractions belong to the saved jump profile', () => {
  const base = { host: '127.0.0.1', jumpName: '客户A跳板机', jump: { enabled: true, name: '旧名称', host: '10.0.0.1' } };
  assert.equal(names.archiveOwner(base), '客户A跳板机');
  assert.equal(names.archiveOwner({ ...base, jumpName: undefined }), '旧名称');
  assert.equal(names.archiveOwner({ host: '127.0.0.1', jump: { enabled: true, host: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(names.archiveOwner({ ...base, jump: { enabled: false } }), '127.0.0.1');
  const root = path.resolve('downloads');
  const date = new Date(2026, 9, 23, 18);
  assert.equal(downloadPath(root, names.archiveOwner(base), '/system/log/app.log', date), path.join(root, '客户A跳板机', 'log', '2026-10-23_18', 'app.log'));
  assert.equal(extractionPath(root, names.archiveOwner(base), '/system/log/app.log.gz', date), path.join(root, '客户A跳板机', 'log', '2026-10-23_18', 'app.log'));
});


test('terminal logs identify locomotives, devices, endpoints and preserve Chinese labels', () => {
  const direct = { name: '机车 HXD3-1234', host: '192.168.20.7', port: 23 };
  assert.equal(names.telnetLogTarget(direct), '机车_HXD3-1234--192.168.20.7_23');
  assert.notEqual(names.telnetLogTarget(direct), names.telnetLogTarget({ ...direct, port: 2323 }));
  const web = { device: '2098267890303311', deviceName: '机车1234', name: '成都', address: 'http://10.0.0.1:8080' };
  const target = names.telnetLogTarget(web);
  assert.ok(target.startsWith('机车1234--设备-2098267890303311--成都--'));
  assert.notEqual(target, names.telnetLogTarget({ ...web, device: '2098267890303312' }));
  assert.notEqual(target, names.telnetLogTarget({ ...web, address: 'http://10.0.0.2:8080' }));
  assert.ok(names.terminalLogTarget('设备A--root@127.0.0.1_2220').includes('设备A'));
  for (const value of ['../../outside', '..', 'CON', '机车'.repeat(200)]) {
    const safe = names.terminalLogTarget(value);
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(safe));
    assert.ok(!['.', '..', 'CON'].includes(safe));
    assert.ok(Buffer.byteLength(safe) <= 160);
  }
  assert.notEqual(names.terminalLogTarget('机车'.repeat(200) + 'A'), names.terminalLogTarget('机车'.repeat(200) + 'B'));
});
