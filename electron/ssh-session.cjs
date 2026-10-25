const { Client } = require('ssh2');
const fs = require('node:fs/promises');

async function connectSession(profile, { signal, verify, report = () => {}, onError = () => {}, onClose = () => {} }) {
  const clients = [], streams = [];
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    signal.removeEventListener('abort', abort);
    // Release every owned connection even when another resource fails to close.
    for (const resource of [...clients].reverse().concat(streams)) {
      try { resource.destroy(); } catch {}
    }
  };
  const abort = () => close();
  signal.addEventListener('abort', abort, { once: true });
  const cancelled = () => { if (signal.aborted) throw new Error('连接已取消'); };
  function request(client, invoke, label) {
    cancelled();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) { value?.destroy?.(); return; }
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop); client.removeListener('close', stop);
        if (error) reject(error); else resolve(value);
      };
      const stop = () => finish(new Error(`${label}已关闭或取消`));
      const timer = setTimeout(() => finish(new Error(`${label}超时，请检查地址、隧道端口和 SSH 权限`)), 20000);
      signal.addEventListener('abort', stop, { once: true }); client.once('close', stop);
      try { invoke(finish); } catch (error) { finish(error); }
    });
  }
  async function endpoint(value, identity, role, sock) {
    cancelled();
    if (!value.host || !value.username) throw new Error(`${role}主机和用户名不能为空`);
    const port = Number(value.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${role}端口无效`);
    const options = { host: value.host, port, username: value.username, sock, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3, hostHash: 'sha256', hostVerifier: (fingerprint, callback) => signal.aborted ? callback(false) : verify(identity, role, fingerprint, callback) };
    if (value.auth === 'key') { options.privateKey = await fs.readFile(value.keyPath); if (value.passphrase) options.passphrase = value.passphrase; }
    else if (value.auth === 'agent') { options.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined); if (!options.agent) throw new Error(`${role}未找到 SSH Agent`); }
    else if (value.auth === 'password' || !value.auth) {
      if (!value.password) throw new Error(`${role}未填写密码，请输入本次密码或保存密码后重新选择配置`);
      options.password = value.password; options.tryKeyboard = true;
    }
    else throw new Error(`${role}认证方式无效`);
    cancelled();
    const client = new Client(); clients.push(client);
    let interactiveHint = '';
    client.on('keyboard-interactive', (name, instructions, language, prompts, finish) => {
      if (signal.aborted) return finish(prompts.map(() => ''));
      if (!prompts.length) return finish([]);
      if (options.password && prompts.length === 1 && !prompts[0].echo && /(password|密码|口令)/i.test(prompts[0].prompt) && !/(otp|code|token|验证码|动态|verification|one.time)/i.test(prompts[0].prompt)) return finish([options.password]);
      interactiveHint = '服务器要求额外交互认证或验证码，当前不能自动回答；请核对终端使用的认证方式';
      finish(prompts.map(() => ''));
    });
    report(`正在连接${role} · ${identity}`);
    await new Promise((resolve, reject) => {
      let ready = false;
      client.once('ready', () => { ready = true; resolve(); });
      client.on('error', error => { if (!ready) {
          const authFailure = error.level === 'client-authentication' || /All configured authentication methods failed/i.test(error.message);
          const method = value.auth === 'key' ? '私钥' : value.auth === 'agent' ? 'SSH Agent' : '密码';
          reject(new Error(authFailure ? `${role}认证失败（${value.username}@${value.host}:${port}，${method}）。${interactiveHint || '请检查账号、密码/私钥，以及服务器允许的认证方式'}` : `${role}连接失败：${error.message}`));
        } else if (!closing) onError(`${role}：${error.message}`); });
      client.on('close', () => { if (!ready) reject(new Error(`${role}连接已关闭`)); else if (!closing) onClose(); });
      client.connect(options);
    });
    cancelled(); return client;
  }
  try {
    let sock, jump;
    const targetAddress = `${profile.host}:${Number(profile.port || 22)}`;
    const jumpAddress = profile.jump?.enabled ? `${profile.jump.username}@${profile.jump.host}:${Number(profile.jump.port || 22)}` : '';
    const identity = jumpAddress ? `via ${jumpAddress} → ${targetAddress}` : targetAddress;
    if (profile.jump?.enabled) {
      jump = await endpoint(profile.jump, `${profile.jump.host}:${Number(profile.jump.port || 22)}`, '跳板机');
      report(`正在转发至目标 · ${targetAddress}`);
      sock = await request(jump, done => jump.forwardOut('127.0.0.1', 0, profile.host, Number(profile.port || 22), (error, stream) => {
        if (error) done(new Error(`跳板机转发失败：${error.message}。请检查目标地址、反向隧道端口和 SSH 转发权限`));
        else done(null, stream);
      }), '跳板机转发');
      streams.push(sock);

    }
    const client = await endpoint(profile, identity, '目标机器', sock);
    const sftp = await request(client, done => client.sftp((error, channel) => done(error ? new Error(`目标机器 SFTP 不可用：${error.message}`) : null, channel)), '目标机器 SFTP');
    cancelled();
    return {
      client, jump, sftp, identity,
      async releaseJumpPort() {
        const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(profile.host).trim().toLowerCase());
        const tunneled = Boolean(jump && loopback);
        const port = Number(profile.port || 22);
        if (tunneled && port === Number(profile.jump.port || 22)) throw new Error('目标端口与跳板机 SSH 登录端口相同，无法释放');
        report('正在停止设备上的持久或手动反向 SSH 隧道…');
        let worker, workerError;
        try {
          worker = await require('./reverse-ssh-worker.cjs').stopReverseSshWorker(client, tunneled
            ? { port, host: profile.jump.host, sshPort: Number(profile.jump.port || 22), tunneled: true, onProgress: report }
            : { onProgress: report });
        } catch (error) { workerError = error; }
        let result = { released: false, message: 'SSH 连接已断开' };
        let releaseError;
        if (tunneled) {
          report(`正在释放跳板机 localhost:${port} 监听端口…`);
          try { result = await require('./jump-port.cjs').releaseJumpPort(jump, port); } catch (error) { releaseError = error; }
        }
        if (workerError || releaseError) throw new Error([workerError && '设备反向 SSH 清理失败：' + workerError.message, releaseError && '跳板机端口释放失败：' + releaseError.message].filter(Boolean).join('；'));
        if (worker?.stopped) result.message = (worker.verificationPending ? '已停止持久隧道的重连进程，隧道关闭后无法核验其余进程；' : '已停止匹配的持久或手动反向 SSH 隧道；') + result.message;
        else if (worker?.stopRequested) result.message = '已提交反向 SSH 停止请求，隧道关闭后无法核验设备进程；' + result.message;
        return result;
      },
      close: () => { signal.removeEventListener('abort', abort); close(); },
    };
  } catch (error) { signal.removeEventListener('abort', abort); close(); throw error; }
}
module.exports = { connectSession };
