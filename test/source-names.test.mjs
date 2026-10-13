import test from 'node:test';
import assert from 'node:assert/strict';
import names from '../electron/source-names.cjs';
const { sourceIdentity, sourceFilename } = names;

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
