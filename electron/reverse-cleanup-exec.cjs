const { StringDecoder } = require('node:string_decoder');

const DISCOVERY_TIMEOUT_MS = 20000;
const STOP_TIMEOUT_MS = 6000;
const FAILURE_DRAIN_TIMEOUT_MS = 250;
const MAX_OUTPUT_BYTES = 16384;

// A completed operation can leave its channel alive until SSH delivers close.
// This guard deliberately retains no operation/client state and adds no timer.
function guardChannelErrors(channel) {
  if (!channel?.on || !channel?.once) return;
  const ignoreLateError = () => {};
  channel.on('error', ignoreLateError);
  channel.once('close', () => channel.removeListener?.('error', ignoreLateError));
}

// The exec channel may travel over the very reverse connection being stopped.
// A full completion line is sufficient; waiting for channel EOF can hang even
// after the remote script has successfully finished its work.
function runReverseCleanup(client, command, options = {}) {
  return new Promise((resolve, reject) => {
    let stream, timer, settled = false, requested = false, parentStopped = false, channelClosed = false, failedExit = false;
    let errors = '', partialLine = '', outputBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const listeners = [];
    const listen = (target, event, handler) => {
      if (!target?.on) return;
      target.on(event, handler);
      listeners.push([target, event, handler]);
    };
    const progress = message => {
      // UI observers must not affect whether the remote operation succeeds.
      try { options.onProgress?.(message); } catch {}
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [target, event, handler] of listeners) target.removeListener?.(event, handler);
      if (!channelClosed) guardChannelErrors(stream);
      if (error) {
        try { stream?.close?.(); } catch {}
        reject(error);
      } else {
        // In particular, keep REQUESTED channels alive: their script may still
        // have delayed termination signals to deliver to the reverse SSH child.
        resolve(result);
      }
    };
    const failure = fallback => new Error(errors.trim() || fallback);
    const pending = () => options.tunneled === true && requested && !failedExit && !errors.trim();
    const disconnected = () => {
      if (pending()) {
        progress('停止请求已确认，反向连接已关闭，等待后续核验');
        finish(null, { stopped: parentStopped, stopRequested: true, verificationPending: true });
      } else finish(failure(failedExit ? '停止反向 SSH 失败' : '设备连接提前关闭，无法确认反向 SSH 是否停止'));
    };
    const armTimeout = (duration, stopping) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending()) {
          progress('停止请求已确认，设备尚未返回最终结果，等待后续核验');
          finish(null, { stopped: parentStopped, stopRequested: true, verificationPending: true });
        } else finish(failure(`停止反向 SSH 超时（${stopping ? 6 : 20} 秒）`));
      }, duration);
    };
    const handleLine = line => {
      if (failedExit) return;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === 'REVERSE_WORKER_STOP_REQUESTED' || line === 'REVERSE_SSH_STOP_REQUESTED' || line === 'REVERSE_WORKER_PARENT_STOPPED') {
        if (!requested) {
          requested = true;
          armTimeout(STOP_TIMEOUT_MS, true);
          progress('已找到目标进程，正在请求停止反向 SSH');
        }
        if (line === 'REVERSE_WORKER_PARENT_STOPPED' && !parentStopped) {
          parentStopped = true;
          progress('reverse-ssh-worker 已停止，正在结束反向 SSH 子进程');
        }
      } else if (line === 'REVERSE_WORKER_STOPPED' || line === 'REVERSE_SSH_STOPPED') {
        if (errors.trim()) return finish(failure('停止反向 SSH 失败'));
        progress('反向 SSH 已停止');
        finish(null, { stopped: true });
      } else if (line === 'REVERSE_WORKER_ABSENT' || line === 'REVERSE_SSH_ABSENT') {
        if (errors.trim()) return finish(failure('停止反向 SSH 失败'));
        progress('未发现需要停止的反向 SSH 进程');
        finish(null, { stopped: false });
      }
    };
    const collect = (chunk, stderr) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += data.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return finish(new Error('停止反向 SSH 的输出异常（超过 16 KiB）'));
      if (stderr) {
        errors += stderrDecoder.write(data);
        return;
      }
      partialLine += stdoutDecoder.write(data);
      let newline;
      while (!settled && (newline = partialLine.indexOf('\n')) !== -1) {
        const line = partialLine.slice(0, newline);
        partialLine = partialLine.slice(newline + 1);
        handleLine(line);
      }
    };

    armTimeout(DISCOVERY_TIMEOUT_MS, false);
    listen(client, 'close', disconnected);
    listen(client, 'error', error => pending() ? disconnected() : finish(error));
    progress('正在设备上查找反向 SSH 进程');
    try {
      client.exec(command, (error, channel) => {
        if (settled) { guardChannelErrors(channel); try { channel?.close?.(); } catch {} return; }
        if (error) return finish(new Error('无法在设备上停止反向 SSH：' + error.message));
        if (!channel?.on) return finish(new Error('设备未返回有效的 SSH 命令通道'));
        stream = channel;
        listen(stream, 'data', chunk => collect(chunk, false));
        listen(stream.stderr, 'data', chunk => collect(chunk, true));
        listen(stream, 'error', error => pending() ? disconnected() : finish(error));
        listen(stream, 'exit', (code, signal) => {
          if (((code != null && code !== 0) || signal) && !failedExit) {
            // ssh2 can emit exit before Readable delivers buffered stderr.
            // Remember the failure immediately, but let diagnostics drain.
            failedExit = true;
            clearTimeout(timer);
            timer = setTimeout(() => finish(failure('停止反向 SSH 失败')), FAILURE_DRAIN_TIMEOUT_MS);
          }
        });
        listen(stream, 'close', code => {
          channelClosed = true;
          if (failedExit) return finish(failure('停止反向 SSH 失败'));
          if (code == null) return disconnected();
          if (code !== 0) return finish(failure('停止反向 SSH 失败'));
          finish(failure('设备未返回有效的反向 SSH 停止结果'));
        });
      });
    } catch (error) { finish(error); }
  });
}

module.exports = { runReverseCleanup };
