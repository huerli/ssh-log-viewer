import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import parserModule from '../electron/reverse-ssh-parse.cjs';

const run = promisify(execFile);
const { reverseSshParserScript } = parserModule;
const host = 'teeechina.xicp.net';
const destination = `root@${host}`;
const forward = '29281:localhost:22';
const expected = `29281 ${host} 10022 root\n`;
let directory, sequence = 0;
const shells = [];

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'viewer-ssh-parser-'));
  try {
    await run('/bin/dash', ['-c', ':']);
    shells.push({ name: 'dash/system awk', binary: '/bin/dash', args: ['-c'], env: process.env });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const binary of ['/usr/bin/busybox', '/bin/busybox']) {
    try {
      await run(binary, ['ash', '-c', ':']);
      const bin = path.join(directory, 'busybox-bin');
      await mkdir(bin);
      for (const applet of ['awk', 'od']) await symlink(binary, path.join(bin, applet));
      shells.push({ name: 'BusyBox ash/awk', binary, args: ['ash', '-c'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function parse(shell, argv) {
  const filename = path.join(directory, `argv ${++sequence}`);
  await writeFile(filename, `${argv.join('\0')}\0`);
  try {
    return { ok: true, ...(await run(shell.binary, [...shell.args, `${reverseSshParserScript}\nssh_forward "$1"`, 'parser', filename], { env: shell.env })) };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { ok: false, stdout: error.stdout, stderr: error.stderr };
  }
}

test('parses dedicated reverse forwards from exact NUL-separated argv', async t => {
  const cases = [
    ['user command with options after hostname', ['/usr/bin/ssh', '-fCNR', forward, destination, '-p', '10022'], expected],
    ['attached forward and SSH port', ['ssh', `-fCNR${forward}`, '-p10022', destination], expected],
    ['separated flags', ['ssh', '-f', '-C', '-N', '-T', '-R', forward, '-p', '10022', destination], expected],
    ['default destination port', ['ssh', '-NR', forward, destination], `29281 ${host} 22 root\n`],
    ['attached option port', ['ssh', '-NR', forward, '-oPort=10022', destination], expected],
    ['separate option port', ['ssh', '-NR', forward, '-o', 'Port=10022', destination], expected],
    ['whitespace option separator', ['ssh', '-NR', forward, '-o', 'Port 10022', destination], expected],
    ['first SSH port wins', ['ssh', '-NR', forward, '-p10022', '-oPort=3333', '-p4444', destination], expected],
    ['SessionType none', ['ssh', '-R', forward, '-oSessionType=none', '-p10022', destination], expected],
    ['localhost bind', ['ssh', '-NR', `localhost:${forward}`, '-p10022', destination], expected],
    ['IPv4 bind and target', ['ssh', '-NR', '127.0.0.1:29281:127.0.0.1:22', '-p10022', destination], expected],
    ['IPv6 bind and target', ['ssh', '-NR', '[::1]:29281:[::1]:22', '-p10022', destination], expected],
    ['port boundaries', ['ssh', '-NR', '65535:localhost:22', '-p1', destination], `65535 ${host} 1 root\n`],
    ['identity filename retains whitespace and flags', ['ssh', '-N', '-i', 'key with -R 9999:localhost:22 -p 2222', '-R', forward, '-p10022', destination], expected],
    ['option value retains whitespace and flags', ['ssh', '-NR', forward, '-o', 'IdentityFile=/keys/path -R 9999:localhost:22', '-p10022', destination], expected],
    ['common options', ['ssh', '-NR', forward, '-oExitOnForwardFailure=yes', '-oServerAliveInterval=15', '-oStrictHostKeyChecking=no', '-oUserKnownHostsFile=/dev/null', '-p10022', destination], expected],
    ['safe hostname alphabet', ['ssh', '-NR', forward, '-p10022', 'root@jump_host-2.example'], '29281 jump_host-2.example 10022 root\n'],
    ['IPv6 destination', ['ssh', '-NR', forward, '-p10022', 'root@[2001:db8::1]'], '29281 [2001:db8::1] 10022 root\n'],
    ['separate login option', ['ssh', '-NR', forward, '-p10022', '-l', 'tunnel', host], `29281 ${host} 10022 tunnel\n`],
    ['attached login option', ['ssh', '-NR', forward, '-p10022', '-ltunnel', host], `29281 ${host} 10022 tunnel\n`],
    ['login configuration option', ['ssh', '-NR', forward, '-p10022', '-oUser=tunnel', host], `29281 ${host} 10022 tunnel\n`],
    ['first login wins before destination', ['ssh', '-NR', forward, '-p10022', '-ltunnel', destination], `29281 ${host} 10022 tunnel\n`],
    ['destination login wins before later options', ['ssh', '-NR', forward, destination, '-p10022', '-ltunnel', '-oUser=other'], expected],
    ['unspecified login', ['ssh', '-NR', forward, '-p10022', host], `29281 ${host} 10022 -\n`],
    ['identity preserves newlines and all regex punctuation', ['ssh', '-NR', forward, '-p10022', '-i', 'line\n^$()[]{}+?.*|\\\tend', destination], expected],
  ];
  assert.ok(shells.length > 0, 'a compatible POSIX shell is available');
  for (const shell of shells) for (const [name, argv, output] of cases) {
    await t.test(`${shell.name}: ${name}`, async () => {
      const result = await parse(shell, argv);
      assert.equal(result.ok, true, result.stderr);
      assert.equal(result.stdout, output);
    });
  }
});

test('rejects other sessions and ambiguous or unsafe argv', async t => {
  const base = ['ssh', '-N', '-R', forward, '-p10022', destination];
  const cases = [
    ['non-ssh executable', ['sshd', '-NR', forward, destination]],
    ['ordinary SSH session', ['ssh', destination]],
    ['interactive reverse forward', ['ssh', '-R', forward, destination]],
    ['remote command', [...base, 'echo', 'hello']],
    ['command hidden in one argv', [...base, 'sleep 60']],
    ['second reverse forward', [...base, '-R30000:localhost:22']],
    ['local forward', [...base, '-L30000:localhost:22']],
    ['dynamic local forward', [...base, '-D1080']],
    ['dynamic remote forward', ['ssh', '-NR', '29281', destination]],
    ['remote Unix socket forward', ['ssh', '-NR', '/tmp/forward.sock:/tmp/target.sock', destination]],
    ['non-local target', ['ssh', '-NR', '29281:192.0.2.1:22', destination]],
    ['different target port', ['ssh', '-NR', '29281:localhost:2222', destination]],
    ['wildcard bind', ['ssh', '-NR', '*:29281:localhost:22', destination]],
    ['zero forward port', ['ssh', '-NR', '0:localhost:22', destination]],
    ['overflow forward port', ['ssh', '-NR', '65536:localhost:22', destination]],
    ['zero SSH port', ['ssh', '-NR', forward, '-p0', destination]],
    ['overflow SSH option port', ['ssh', '-NR', forward, '-oPort=65536', destination]],
    ['nonnumeric SSH port', ['ssh', '-NR', forward, '-ptwenty', destination]],
    ['missing forward value', ['ssh', '-N', destination, '-R']],
    ['missing identity value', [...base, '-i']],
    ['missing option value', [...base, '-o']],
    ['empty value', [...base, '-i', '']],
    ['master operation', [...base, '-O', 'exit']],
    ['master connection', [...base, '-M']],
    ['control socket', [...base, '-S', '/tmp/control']],
    ['attached proxy jump', [...base, '-Jjump.invalid']],
    ['separate proxy jump', [...base, '-J', 'jump.invalid']],
    ['extra forward via option', [...base, '-oRemoteForward=3333 localhost:22']],
    ['clear forwarding', [...base, '-oClearAllForwardings=yes']],
    ['destination override', [...base, '-oHostName=other.invalid']],
    ['unknown option', [...base, '-oUnknownFutureOption=yes']],
    ['unknown flag', [...base, '-z']],
    ['custom configuration', [...base, '-F', '/tmp/custom.conf']],
    ['subsystem session', [...base, '-s']],
    ['non-none session option', [...base, '-oSessionType=subsystem']],
    ['TTY session option', [...base, '-oRequestTTY=force']],
    ['spaces inside host argv', ['ssh', '-NR', forward, 'root@host -p 10022']],
    ['shell syntax inside host argv', ['ssh', '-NR', forward, 'root@host;echo']],
    ['newline inside host argv', ['ssh', '-NR', forward, 'root@host\nother']],
    ['multiple users', ['ssh', '-NR', forward, 'root@other@host']],
    ['empty user', ['ssh', '-NR', forward, '@host']],
    ['empty host', ['ssh', '-NR', forward, 'root@']],
    ['multiple destinations', [...base, 'other.invalid']],
    ['unsafe login option', [...base, '-l', 'root user']],
    ['unsafe login configuration', [...base, '-oUser=root user']],
    ['non-loopback bind', ['ssh', '-NR', '127.0.0.2:29281:localhost:22', destination]],
    ['empty bind', ['ssh', '-NR', ':29281:localhost:22', destination]],
    ['empty argv record', [...base, '']],
  ];
  for (const shell of shells) for (const [name, argv] of cases) {
    await t.test(`${shell.name}: ${name}`, async () => {
      const result = await parse(shell, argv);
      assert.equal(result.ok, false, result.stdout);
      assert.equal(result.stdout, '');
    });
  }
});
