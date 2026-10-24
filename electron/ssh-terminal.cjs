const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');

async function createSshLog(root, target, now = new Date()) {
  const part = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`;
  const host = String(target).trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_') || '_';
  const folder = path.join(root, 'ssh', date, host);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const time = `${part(now.getHours())}-${part(now.getMinutes())}-${part(now.getSeconds())}`;
  const file = path.join(folder, `${time}-${randomUUID()}.log`);
  await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
  return file;
}

function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) throw new Error('终端尺寸无效');
  return { cols, rows };
}

function createSshTerminal({ getClient, getTarget, getRoot, getLogMode, emit, onLogFile = () => {}, createLog = createSshLog, fileSystem = fs, shellTimeout = 20000 }) {
  let current, outputFile, outputTarget = '', queue = Promise.resolve();
  const setups = new Set();
  const logError = error => emit({ type: 'ssh-terminal-log-error', message: 'SSH 终端日志失败：' + error.message });
  const enqueue = work => {
    const result = queue.then(work);
    queue = result.catch(logError);
    return result;
  };
  function close() {
    const previous = current;
    current = undefined;
    if (!previous) return;
    previous.cancel(new Error('SSH 命令终端连接已取消'));
    previous.channel?.destroy();
    emit({ type: 'ssh-terminal-status', message: '已断开' });
  }
  function open(cols = 80, rows = 24) {
    const size = terminalSize(cols, rows);
    const client = getClient();
    if (!client) throw new Error('请先连接 SSH，再打开 SSH 命令终端');
    close();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const own = { cancel: error => { clearTimeout(own.timeout); reject(error); }, channel: undefined, timeout: undefined };
    current = own;
    outputFile = undefined;
    outputTarget = String(getTarget());
    const target = outputTarget;
    const setup = (async () => {
      // Flush the previous session before allocating this session's independent file.
      await queue;
      if (current !== own) return;
      try {
        const file = await createLog(getRoot(), target);
        onLogFile(file);
        if (current !== own) return;
        outputFile = file;
      } catch (error) { if (current === own) logError(error); }
      if (current !== own) return;
      own.timeout = setTimeout(() => {
        if (current !== own) return;
        const error = new Error('SSH 命令终端连接超时，请重试');
        emit({ type: 'ssh-terminal-status', message: error.message });
        reject(error);
        close();
      }, shellTimeout);
      client.shell({ term: 'xterm-256color', ...size }, (error, channel) => {
        clearTimeout(own.timeout);
        if (current !== own) { channel?.destroy(); return; }
        if (error) {
          current = undefined;
          emit({ type: 'ssh-terminal-status', message: 'SSH 命令终端连接失败：' + error.message });
          reject(error);
          return;
        }
        own.channel = channel;
        const data = message => {
          if (current !== own) return;
          const text = String(message);
          emit({ type: 'ssh-terminal-data', message: text });
          const file = outputFile;
          const mode = getLogMode() || 'printable';
          if (!file || mode === 'none') return;
          const recorded = mode === 'printable' ? stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') : text;
          enqueue(() => fileSystem.appendFile(file, recorded, { mode: 0o600 })).catch(() => {});
        };
        channel.setEncoding('utf8');
        channel.on('data', data);
        channel.stderr?.setEncoding('utf8');
        channel.stderr?.on('data', data);
        channel.on('error', error => {
          if (current !== own) return;
          emit({ type: 'ssh-terminal-status', message: 'SSH 命令终端错误：' + error.message });
          close();
        });
        channel.on('close', () => { if (current === own) close(); });
        emit({ type: 'ssh-terminal-status', message: '已连接', file: outputFile });
        resolve(true);
      });
    })().catch(error => {
      if (current === own) {
        current = undefined;
        clearTimeout(own.timeout);
        emit({ type: 'ssh-terminal-status', message: 'SSH 命令终端连接失败：' + error.message });
        reject(error);
      }
    });
    setups.add(setup);
    setup.finally(() => setups.delete(setup));
    return promise;
  }
  return {
    open, close,
    write(text) {
      if (!current?.channel) throw new Error('SSH 命令终端未连接');
      if (typeof text !== 'string' || text.length > 65536) throw new Error('输入过长');
      current.channel.write(text);
    },
    resize(cols, rows) {
      const size = terminalSize(cols, rows);
      if (current?.channel) current.channel.setWindow(size.rows, size.cols, 0, 0);
    },
    get outputFile() { return outputFile; },
    get outputTarget() { return outputTarget; },
    overwrite() {
      const file = outputFile;
      return file ? enqueue(() => fileSystem.writeFile(file, '', { mode: 0o600 })) : Promise.resolve();
    },
    copyOutput(destination, file = outputFile) {
      if (!file) throw new Error('尚无 SSH 命令终端会话输出');
      return enqueue(() => fileSystem.copyFile(file, destination));
    },
    async drain() { await Promise.allSettled([...setups]); await queue; },
  };
}

module.exports = { createSshTerminal, createSshLog, terminalSize };
