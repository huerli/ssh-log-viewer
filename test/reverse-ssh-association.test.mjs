import fixtureLock from './worker-fixture-lock.cjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, copyFile, rm, mkdir, symlink, readlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import workerModule from '../electron/reverse-ssh-worker.cjs';

const { buildStopWorkerCommand } = workerModule;
const linuxOnly = { skip: process.platform !== 'linux' };
const destination = { port: 29281, host: 'socket-alias-fixture.invalid', sshPort: 2222, tunneled: true };
const busyboxBinary = '/usr/bin/busybox';
let directory, binary, busyboxDirectory, compilerUnavailable = false, commandNumber = 0;

let releaseFixtureLock;
before(async () => {
  if (process.platform !== 'linux') return;
  releaseFixtureLock = await fixtureLock.acquireWorkerFixtureLock();
  directory = await mkdtemp(path.join(os.tmpdir(), 'viewer-worker-socket-'));
  binary = path.join(directory, 'reverse-ssh-worker');
  try {
    await promisify(execFile)(busyboxBinary, ['true']);
    busyboxDirectory = path.join(directory, 'busybox-bin');
    await mkdir(busyboxDirectory);
    for (const applet of ['sh', 'awk', 'readlink', 'tr', 'sleep']) {
      await symlink(busyboxBinary, path.join(busyboxDirectory, applet));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = path.join(directory, 'fixture.c');
  // /proc/exe, direct parentage and socket inodes are real: argv0 is only used
  // for the production worker's script path, matching deployed shell workers.
  await writeFile(source, String.raw`
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int endpoint(int family, int port, int listening) {
  int fd = socket(family, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_storage storage;
  memset(&storage, 0, sizeof storage);
  socklen_t size;
  if (family == AF_INET6) {
    struct sockaddr_in6 *address = (struct sockaddr_in6 *)&storage;
    address->sin6_family = AF_INET6;
    address->sin6_addr = in6addr_loopback;
    address->sin6_port = htons(port);
    size = sizeof *address;
  } else {
    struct sockaddr_in *address = (struct sockaddr_in *)&storage;
    address->sin_family = AF_INET;
    address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address->sin_port = htons(port);
    size = sizeof *address;
  }
  int result = listening ? bind(fd, (struct sockaddr *)&storage, size)
                         : connect(fd, (struct sockaddr *)&storage, size);
  if (result < 0) { close(fd); return -1; }
  if (!listening) return fd;
  if (listen(fd, 4) < 0 || getsockname(fd, (struct sockaddr *)&storage, &size) < 0) {
    close(fd); return -1;
  }
  int bound_port = family == AF_INET6
    ? ntohs(((struct sockaddr_in6 *)&storage)->sin6_port)
    : ntohs(((struct sockaddr_in *)&storage)->sin_port);
  printf("PORT %d\n", bound_port);
  fflush(stdout);
  return fd;
}

static pid_t worker_child;
static void stop_worker(int signal_number) {
  if (worker_child > 0) kill(worker_child, SIGTERM);
  _exit(0);
}

int main(int argc, char **argv) {
  char executable[4096];
  ssize_t length = readlink("/proc/self/exe", executable, sizeof executable - 1);
  if (length < 0) return 1;
  executable[length] = 0;
  const char *name = strrchr(executable, '/');
  name = name ? name + 1 : executable;
  if (!strcmp(name, "sshd") || !strcmp(name, "sshd-session")) {
    int family = atoi(getenv("ASSOCIATION_FAMILY")) == 6 ? AF_INET6 : AF_INET;
    int listener = endpoint(family, 0, 1);
    if (listener < 0) { perror("listen"); return family == AF_INET6 ? 77 : 2; }
    int connection = accept(listener, NULL, NULL);
    if (connection < 0) return 3;
    close(listener);
    puts("CONNECTED");
    fflush(stdout);
    char *script = NULL;
    size_t size = 0;
    while (getline(&script, &size, stdin) > 0) {
      script[strcspn(script, "\r\n")] = 0;
      pid_t child = fork();
      if (child < 0) return 4;
      if (!child) {
        if (getenv("ASSOCIATION_DROP_ON_EOF")) setpgid(0, 0);
        close(connection);
        const char *shell = getenv("ASSOCIATION_SHELL");
        execl(shell ? shell : "/bin/sh", "sh", script, (char *)NULL);
        _exit(5);
      }
      pid_t watcher = -1;
      if (getenv("ASSOCIATION_DROP_ON_EOF")) {
        setpgid(child, child);
        watcher = fork();
        if (watcher < 0) return 13;
        if (!watcher) {
          // Avoid an orphaned blocked reader if a failed test kills the server.
          prctl(PR_SET_PDEATHSIG, SIGKILL);
          if (getppid() == 1) _exit(0);
          char byte;
          ssize_t received;
          do { received = read(connection, &byte, 1); }
          while (received > 0 || (received < 0 && errno == EINTR));
          if (received == 0) {
            puts("TRANSPORT_HUP_SENT");
            fflush(stdout);
            kill(-child, SIGHUP);
          }
          _exit(0);
        }
      }
      int status;
      if (waitpid(child, &status, 0) < 0) return 6;
      if (watcher > 0) {
        kill(watcher, SIGKILL);
        waitpid(watcher, NULL, 0);
      }
      printf("RESULT %d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
      fflush(stdout);
    }
    free(script);
    close(connection);
    return 0;
  }
  if (!strcmp(name, "ssh")) {
    int family = atoi(getenv("ASSOCIATION_FAMILY")) == 6 ? AF_INET6 : AF_INET;
    int connection = endpoint(family, atoi(getenv("ASSOCIATION_SERVER_PORT")), 0);
    if (connection < 0) return 7;
    const char *ready_text = getenv("ASSOCIATION_READY_FD");
    if (ready_text) {
      int ready = atoi(ready_text);
      if (write(ready, "r", 1) != 1) return 8;
      close(ready);
    } else {
      printf("SSH %d\n", getpid());
      fflush(stdout);
    }
    for (;;) pause();
  }
  int ready[2];
  if (pipe(ready) < 0) return 9;
  pid_t child = fork();
  if (child < 0) return 10;
  if (!child) {
    close(ready[0]);
    char fd[24], forward[128], target[512];
    snprintf(fd, sizeof fd, "%d", ready[1]);
    setenv("ASSOCIATION_READY_FD", fd, 1);
    snprintf(forward, sizeof forward, "%s:localhost:22", argv[1]);
    snprintf(target, sizeof target, "%s@%s", getenv("ASSOCIATION_USER"), argv[2]);
    execl(getenv("ASSOCIATION_SSH_BINARY"), "ssh", "-fCNR", forward,
          target, "-p", argv[3], (char *)NULL);
    _exit(11);
  }
  close(ready[1]);
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 12;
  close(ready[0]);
  worker_child = child;
  if (getenv("ASSOCIATION_TERM_CHILD")) signal(SIGTERM, stop_worker);
  printf("SSH %d\n", child);
  fflush(stdout);
  for (;;) pause();
}
`);
  try { await promisify(execFile)('cc', ['-O0', '-o', binary, source]); }
  catch (error) {
    if (error.code === 'ENOENT') { compilerUnavailable = true; return; }
    throw error;
  }
  for (const name of ['ssh', 'sshd', 'sshd-session']) await copyFile(binary, path.join(directory, name));
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function processLines(child) {
  const queue = [];
  let pending, closed = false, stderr = '';
  const input = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { stderr += chunk; });
  input.on('line', line => {
    if (pending) { const resolve = pending.resolve; pending = undefined; resolve(line); }
    else queue.push(line);
  });
  child.on('error', error => {
    closed = true;
    if (pending) { const reject = pending.reject; pending = undefined; reject(error); }
  });
  child.on('close', () => {
    closed = true;
    if (pending) { const reject = pending.reject; pending = undefined; reject(new Error(`Socket fixture exited: ${stderr}`)); }
  });
  return {
    get stderr() { return stderr; },
    async next() {
      if (queue.length) return queue.shift();
      if (closed) throw new Error(`Socket fixture is closed: ${stderr}`);
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => { pending = undefined; reject(new Error(`Socket fixture timed out: ${stderr}`)); }, 10000);
        });
      } finally { clearTimeout(timer); }
    },
  };
}

async function alive(pid) {
  try { return !/^State:\s+[ZX]/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
}

function kill(pid) {
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function fixture(t, { kind = 'worker', user = 'root', terminateChild = false, dropOnEof = false, forceChildScan = false, busybox = false, family = 4, serverName = 'sshd', serverTitle = 'sshd: fixture@notty', port = destination.port, host = 'worker-canonical-fixture.invalid', sshPort = 22 } = {}) {
  if (compilerUnavailable) { t.skip('C compiler is unavailable for isolated socket fixtures'); return; }
  if (busybox && !busyboxDirectory) { t.skip('BusyBox is unavailable for embedded shell fixtures'); return; }
  const server = spawn(path.join(directory, serverName), [], {
    argv0: serverName === 'sshd' ? serverTitle : 'sshd-session',
    env: {
      ...process.env, ASSOCIATION_FAMILY: String(family),
      ...(dropOnEof ? { ASSOCIATION_DROP_ON_EOF: '1' } : {}),
      ...(busybox ? { PATH: busyboxDirectory, ASSOCIATION_SHELL: path.join(busyboxDirectory, 'sh') } : {}),
    },
  });
  const serverOutput = processLines(server);
  let worker, sshPid;
  t.after(async () => {
    if (worker?.pid) kill(worker.pid);
    if (sshPid) kill(sshPid);
    if (server.pid) kill(server.pid);
    await Promise.all([worker, server].filter(Boolean).map(child =>
      child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('close', resolve))));
  });
  let listen;
  try { listen = await serverOutput.next(); }
  catch (error) {
    if (family === 6 && /Address family not supported|Cannot assign requested address|Protocol not supported/.test(serverOutput.stderr)) {
      t.skip('IPv6 loopback is unavailable'); return;
    }
    throw error;
  }
  assert.match(listen, /^PORT \d+$/);
  const serverPort = Number(listen.split(' ')[1]);
  const standalone = kind === 'forward';
  worker = spawn(standalone ? path.join(directory, 'ssh') : binary,
    standalone ? ['-fCNR', `${port}:localhost:22`, user === '-' ? host : `${user}@${host}`, '-p', String(sshPort)] : [String(port), host, String(sshPort)], {
      argv0: standalone ? 'ssh' : '/usr/local/sbin/reverse-ssh-worker',
      env: {
        ...process.env, ASSOCIATION_SSH_BINARY: path.join(directory, 'ssh'), ASSOCIATION_FAMILY: String(family),
        ASSOCIATION_SERVER_PORT: String(serverPort), ASSOCIATION_USER: user,
        ...(terminateChild ? { ASSOCIATION_TERM_CHILD: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const ready = await processLines(worker).next();
  assert.match(ready, /^SSH \d+$/);
  sshPid = Number(ready.split(' ')[1]);
  assert.equal(await serverOutput.next(), 'CONNECTED');
  return {
    worker, sshPid, server, kind,
    async cleanup(options = destination) {
      const script = path.join(directory, `cleanup-${++commandNumber}.sh`);
      let command = buildStopWorkerCommand(options);
      if (forceChildScan) {
        const kernelChildrenCheck = 'if [ -r "/proc/$1/task/$1/children" ]; then';
        assert.ok(command.includes(kernelChildrenCheck), 'the fallback fixture must replace the real kernel-children branch');
        command = command.replace(kernelChildrenCheck, 'if false; then');
      }
      await writeFile(script, `${command}\n`);
      server.stdin.write(`${script}\n`);
      let output = '';
      for (;;) {
        const line = await serverOutput.next();
        if (line.startsWith('RESULT ')) return { code: Number(line.slice(7)), output, errors: serverOutput.stderr };
        output += `${line}\n`;
      }
    },
  };
}

async function assertAlive(pair, expected) {
  assert.equal(await alive(pair.worker.pid), expected, 'worker survival');
  assert.equal(await alive(pair.sshPid), expected, 'direct SSH child survival');
  assert.equal(await alive(pair.server.pid), true, 'cleanup SSH server ancestor survives');
}

test('a tunneled IPv4 socket proves the current worker despite host alias and NAT port differences', linuxOnly, async t => {
  const current = await fixture(t);
  if (!current) return;
  const other = await fixture(t, { host: 'other-canonical-fixture.invalid', sshPort: 2200 });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(other, true);
});

test('IPv6 socket association recognizes an sshd-session ancestor', linuxOnly, async t => {
  const current = await fixture(t, { family: 6, serverName: 'sshd-session' });
  if (!current) return;
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
});

test('a unique same-port worker with no current-session socket match is refused unchanged', linuxOnly, async t => {
  const current = await fixture(t, { port: destination.port + 1 });
  if (!current) return;
  const unrelated = await fixture(t);
  const result = await current.cleanup();
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /REVERSE_WORKER_STOP_REQUESTED|REVERSE_WORKER_PARENT_STOPPED|REVERSE_WORKER_STOPPED/);
  await assertAlive(current, true);
  await assertAlive(unrelated, true);
});

test('direct cleanup refuses endpoint mismatch even when the SSH ancestor socket matches', linuxOnly, async t => {
  const current = await fixture(t);
  if (!current) return;
  const result = await current.cleanup({ ...destination, tunneled: false });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /REVERSE_WORKER_STOP_REQUESTED|REVERSE_WORKER_PARENT_STOPPED|REVERSE_WORKER_STOPPED/);
  await assertAlive(current, true);
});


test('a listener sshd ancestor cannot establish the current worker association', linuxOnly, async t => {
  const current = await fixture(t, { serverTitle: 'sshd: fixture [listener]' });
  if (!current) return;
  const result = await current.cleanup();
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /REVERSE_WORKER_STOP_REQUESTED|REVERSE_WORKER_PARENT_STOPPED|REVERSE_WORKER_STOPPED/);
  await assertAlive(current, true);
});


test('the active alias carrier wins over an unrelated exact endpoint worker', linuxOnly, async t => {
  const current = await fixture(t);
  if (!current) return;
  const unrelated = await fixture(t, { host: destination.host, sshPort: destination.sshPort });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(unrelated, true);
});

test('an sshd daemon title containing @ plus daemon arguments cannot prove association', linuxOnly, async t => {
  const current = await fixture(t, { serverTitle: 'sshd: fixture@notty -D' });
  if (!current) return;
  const result = await current.cleanup();
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /REVERSE_WORKER_STOP_REQUESTED|REVERSE_WORKER_PARENT_STOPPED|REVERSE_WORKER_STOPPED/);
  await assertAlive(current, true);
});


for (const family of [4, 6]) {
  test(`BusyBox ash and applets stop only the associated IPv${family} alias worker`, linuxOnly, async t => {
    const current = await fixture(t, { busybox: true, family });
    if (!current) return;
    const other = await fixture(t, { host: 'other-busybox-fixture.invalid' });
    // PATH contains only BusyBox applets, including the nested generated sh.
    // Its readlink intentionally rejects multiple operands unlike GNU readlink.
    for (const applet of ['sh', 'awk', 'readlink', 'tr', 'sleep']) {
      assert.equal(await readlink(path.join(busyboxDirectory, applet)), busyboxBinary);
    }
    await assert.rejects(promisify(execFile)(path.join(busyboxDirectory, 'readlink'), ['/proc/self/exe', '/proc/self/cwd']),
      error => error.code !== 0 && /BusyBox/.test(error.stderr));
    const result = await current.cleanup();
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /REVERSE_WORKER_STOPPED/);
    await assertAlive(current, false);
    await assertAlive(other, true);
  });
}


test('a manually started dedicated SSH reverse forward can be the active tunnel', linuxOnly, async t => {
  const current = await fixture(t, { kind: 'forward', host: 'teeechina.xicp.net', sshPort: 10022 });
  if (!current) return;
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
});

test('an active manual forward stops its matching persistent worker while other endpoints survive', linuxOnly, async t => {
  const current = await fixture(t, { kind: 'forward' });
  if (!current) return;
  const persistent = await fixture(t);
  const otherPort = await fixture(t, { kind: 'forward', port: destination.port + 1 });
  const otherHost = await fixture(t, { kind: 'forward', host: 'other-manual-fixture.invalid' });
  const otherSshPort = await fixture(t, { kind: 'forward', sshPort: 10022 });
  const otherUser = await fixture(t, { kind: 'forward', user: 'other-account' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(persistent, false);
  for (const other of [otherPort, otherHost, otherSshPort, otherUser]) await assertAlive(other, true);
});

test('an active persistent worker also stops matching manually started SSH forwards', linuxOnly, async t => {
  const current = await fixture(t);
  if (!current) return;
  const manual = await fixture(t, { kind: 'forward' });
  const otherUser = await fixture(t, { kind: 'forward', user: 'other-account' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(manual, false);
  await assertAlive(otherUser, true);
});

test('a worker TERM handler that closes the active SSH child still permits other matching forwards to stop', linuxOnly, async t => {
  const current = await fixture(t, { terminateChild: true });
  if (!current) return;
  const manual = await fixture(t, { kind: 'forward' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(manual, false);
});

for (const family of [4, 6]) {
  test(`BusyBox stops an active IPv${family} manual SSH forward and its matching worker`, linuxOnly, async t => {
    const current = await fixture(t, { kind: 'forward', busybox: true, family });
    if (!current) return;
    const persistent = await fixture(t);
    const unrelated = await fixture(t, { kind: 'forward', host: 'other-busybox-manual-fixture.invalid' });
    const result = await current.cleanup();
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /REVERSE_WORKER_STOPPED/);
    await assertAlive(current, false);
    await assertAlive(persistent, false);
    await assertAlive(unrelated, true);
  });
}


test('the complete cleanup transaction survives transport HUP when the worker TERM trap closes its carrier', linuxOnly, async t => {
  const current = await fixture(t, { terminateChild: true, dropOnEof: true });
  if (!current) return;
  const manual = await fixture(t, { kind: 'forward' });
  const unrelated = await fixture(t, { kind: 'forward', port: destination.port + 1 });
  const result = await current.cleanup();
  assert.match(result.output, /REVERSE_WORKER_STOP_REQUESTED/);
  assert.match(result.output, /TRANSPORT_HUP_SENT/);
  assert.notEqual(result.code, 0, 'the foreground cleanup channel must actually close on HUP');
  // The foreground shell may exit with SIGHUP before the detached transaction
  // emits its final marker. Verify actual process state after channel closure.
  const deadline = Date.now() + 10000;
  while (await alive(current.worker.pid) || await alive(current.sshPid) || await alive(manual.sshPid)) {
    assert.ok(Date.now() < deadline, `Detached cleanup did not finish after transport closure: ${result.errors}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await assertAlive(current, false);
  await assertAlive(manual, false);
  await assertAlive(unrelated, true);
});


test('an active root manual forward preserves a same-endpoint worker using a different SSH account', linuxOnly, async t => {
  const current = await fixture(t, { kind: 'forward', user: 'root' });
  if (!current) return;
  const rootWorker = await fixture(t, { user: 'root' });
  const adminWorker = await fixture(t, { user: 'admin' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(rootWorker, false);
  await assertAlive(adminWorker, true);
});

test('an active root worker preserves a same-endpoint worker using a different SSH account', linuxOnly, async t => {
  const current = await fixture(t, { user: 'root' });
  if (!current) return;
  const rootManual = await fixture(t, { kind: 'forward', user: 'root' });
  const adminWorker = await fixture(t, { user: 'admin' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(rootManual, false);
  await assertAlive(adminWorker, true);
});


test('a manual SSH forward with an implicit account survives root-account cleanup at the same endpoint', linuxOnly, async t => {
  const current = await fixture(t, { kind: 'forward', user: 'root' });
  if (!current) return;
  const rootWorker = await fixture(t, { user: 'root' });
  const implicitManual = await fixture(t, { kind: 'forward', user: '-' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(rootWorker, false);
  await assertAlive(implicitManual, true);
});

test('BusyBox cleanup finds SSH children by scanning process status when kernel children files are unavailable', linuxOnly, async t => {
  const current = await fixture(t, { busybox: true, forceChildScan: true });
  if (!current) return;
  const manual = await fixture(t, { kind: 'forward' });
  const adminWorker = await fixture(t, { user: 'admin' });
  const result = await current.cleanup();
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /REVERSE_WORKER_STOPPED/);
  await assertAlive(current, false);
  await assertAlive(manual, false);
  await assertAlive(adminWorker, true);
});

after(async () => { await releaseFixtureLock?.(); });
