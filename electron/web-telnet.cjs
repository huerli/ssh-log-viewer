const { io } = require('socket.io-client');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const publicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDVYssUsJygcfeDVNpiEzRToyK+Vif2Re/xvYDuJqOyS0GGewWYNNgQDpDHNTs5C+jU4Aqz7spWILEE/pe8Wic1Gb6IDphcYY7Jk+GV3eQb+fthBHZnnVh26v2i9SV6nG7Hkeplv9kzbGEzbNa2v5A/PuxZr2tMWEt1exuYHhmW+wIDAQAB\n-----END PUBLIC KEY-----';
function normalizeWebAddress(value) {
  let address = typeof value === 'string' ? value.trim() : '';
  if (!address) throw new Error('请填写 Web 服务地址，例如 http://192.168.20.7:9002');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) address = 'http://' + address;
  let url;
  try { url = new URL(address); } catch { throw new Error('Web 服务地址格式无效，请使用 http://主机:端口'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Web 服务地址须为 HTTP(S) 地址，不能包含账号、查询参数或片段');
  return url.href.replace(/\/$/, '');
}
function normalizeWebInput(text) {
  if (text === '\x03') return text;
  let command = text.replace(/[\r\n]+$/, '').trim();
  if (command && !/^(?:send|help|history|quit)(?:\s|$)/i.test(command)) command = 'send ' + command;
  return command + '\r\n';
}
function createWebTelnet(emit) {
  let socket, retryTimer, cancelPending;
  const close = () => {
    clearTimeout(retryTimer); retryTimer = undefined;
    const old = socket; socket = undefined;
    old?.disconnect();
    cancelPending?.(); cancelPending = undefined;
  };
  return {
    close,
    connect(address, device, token) {
      address = normalizeWebAddress(address);
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP(S) 服务地址');
      if (!device?.trim() || !token?.trim()) throw new Error('设备编号和 TELNET token 不能为空');
      close();
      return new Promise((resolve, reject) => {
        cancelPending = () => reject(new Error('Web Telnet 连接已取消'));
        const decoder = new StringDecoder('utf8');
        // The public jump-host port forwards WebSocket reliably, but corrupts
        // Socket.IO's initial polling frames. Skip polling and connect directly.
        const own = io(address.replace(/\/$/, '') + '/telnet', { query: { token, devSno: device }, path: '/socket.io', reconnection: false, timeout: 10000, autoConnect: false, transports: ['websocket'], upgrade: false });
        socket = own;
        own.on('connect', () => { if (socket !== own) return; cancelPending = undefined; attempts = 0; clearTimeout(retryTimer); retryTimer = undefined; emit({ type: 'telnet-status', message: '已连接' }); resolve(); });
        let attempts = 0;
        const scheduleRetry = () => {
          if (socket !== own || retryTimer) return;
          const delay = Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4));
          emit({ type: 'telnet-status', message: '连接中断 · ' + (delay / 1000) + ' 秒后自动重试（第 ' + attempts + ' 次）' });
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (socket === own) own.connect();
          }, delay);
        };
        own.on('connect_error', error => { if (socket === own) { emit({ type: 'telnet-connection-log', message: 'Socket.IO connect_error: ' + String(error?.message || error) }); scheduleRetry(); } });
        own.on('echo', data => {
          if (socket !== own) return;
          if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
          emit({ type: 'telnet-data', message: decoder.write(Buffer.from(data, 'base64')) });
        });
        own.on('disconnect', reason => { if (socket === own) { emit({ type: 'telnet-connection-log', message: 'Socket.IO disconnect: ' + String(reason || 'unknown') }); scheduleRetry(); } });
        own.connect();
      });
    },
    write(text) {
      if (!socket?.connected) throw new Error('Web Telnet 未连接');
      if (typeof text !== 'string') throw new Error('命令格式无效');
      const raw = Buffer.from(normalizeWebInput(text));
      if (raw.length > 117) throw new Error('Web Telnet 单次输入最多 117 字节');
      socket.emit('userInput', crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, raw).toString('base64'));
    }
  };
}
async function webLogin(address, username, password) {
  address = normalizeWebAddress(address);
  const url = new URL(address.replace(/\/$/, '') + '/auth/login');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址无效');
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password.trim()) throw new Error('请输入 Web 用户名和密码');
  const value = password.trim();
  const normalizedPassword = /^[a-f0-9]{32}$/i.test(value) ? value.toLowerCase() : crypto.createHash('md5').update(value).digest('hex');
  url.searchParams.set('username', username.trim()); url.searchParams.set('password', normalizedPassword);
  const body = { t: Math.floor(Date.now() / 1000) };
  const signature = crypto.createHash('md5').update(String(body.t)).digest('hex');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', appCode: 'teee', Signature: signature }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error('Web 登录请求失败，请检查服务地址与网络'); });
  if (!response.ok) throw new Error('Web 登录 HTTP ' + response.status);
  const data = await response.json();
  if (data.code !== 0 || !data.token) {
    const message = String(data.msg || data.message || '服务器未返回登录令牌').replace(/[\r\n]/g, ' ').slice(0, 200);
    throw new Error('Web 登录失败（code=' + String(data.code) + '）：' + message.split(password).join('[已隐藏]').split(normalizedPassword).join('[已隐藏]'));
  }
  return { token: data.token, tenantId: data.data?.tenantId };
}
async function getTelnetToken(address, login) {
  address = normalizeWebAddress(address);
  const t = String(Math.floor(Date.now() / 1000));
  const url = new URL(address.replace(/\/$/, '') + '/common/ws/genTelnetWsAuthToken');
  url.searchParams.set('t', t);
  const signature = crypto.createHash('md5').update('/ws/genTelnetWsAuthToken?t=' + t).digest('hex');
  const headers = { Authorization: 'Bearer ' + login.token, appCode: 'teee', Signature: signature };
  if (login.tenantId != null) headers.tenant_id = String(login.tenantId);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error('获取 TELNET 专用令牌失败，请检查网络'); });
  if (!response.ok) throw new Error('获取 TELNET 专用令牌 HTTP ' + response.status);
  const result = await response.json();
  if (result.code !== 0 || typeof result.data !== 'string' || !result.data.trim()) throw new Error('获取 TELNET 专用令牌失败，请重新登录');
  return result.data;
}
async function searchDevices(address, login, keyword) {
  const query = String(keyword || '').trim();
  if (!query) return [];
  address = normalizeWebAddress(address);
  const request = async (path, params, label) => {
    const url = new URL(address + path);
    url.search = new URLSearchParams({ t: String(Math.floor(Date.now() / 1000)), ...params }).toString();
    const signaturePath = path.replace(/^\/(?:common|jdf)/, '') + url.search;
    const headers = { Authorization: 'Bearer ' + login.token, appCode: 'teee', Signature: crypto.createHash('md5').update(signaturePath).digest('hex') };
    if (login.tenantId != null) headers.tenant_id = String(login.tenantId);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error(label + '请求失败'); });
    if (!response.ok) throw new Error(label + ' HTTP ' + response.status);
    const result = await response.json();
    if (result.code !== 0) throw new Error(label + '失败，请重新登录');
    return result.data;
  };
  const terminalDevices = async filter => {
    const records = [];
    let page = 1;
    while (true) {
      const data = await request('/jdf/terminal-device/page', { pageNum: String(page), pageSize: '10', ...filter, matter: 'false' }, '设备搜索');
      if (!Array.isArray(data?.records)) throw new Error('设备列表格式无效');
      records.push(...data.records);
      const pages = Number(data.pages) || Math.ceil(Number(data.total) / 10);
      if (!data.records.length || (pages > 0 ? page >= pages : data.records.length < 10)) break;
      page++;
    }
    return records;
  };
  const locomotiveNames = new Map();
  const locomotiveName = async record => {
    const name = String(record.locoNumber ?? '').trim();
    if (name) return name;
    const bindId = String(record.bindId ?? '').trim();
    if (!bindId || Number(bindId) <= 0) return '';
    let pending = locomotiveNames.get(bindId);
    if (!pending) {
      pending = request('/jdf/locomotive/' + encodeURIComponent(bindId), {}, '车号详情查询')
        .then(data => String(data?.locoNumber ?? '').trim());
      locomotiveNames.set(bindId, pending);
    }
    return pending;
  };
  // Nameplates and device names are not locomotive numbers.
  const toMatch = (record, name = '') => ({ number: String(record.deviceNumber), name: String(name || record.locoNumber || '').trim(), online: Number(record.state) === 1 });
  const byDeviceNumber = async () => {
    const data = await request('/common/device/match/' + encodeURIComponent(query), {}, '设备搜索');
    if (!Array.isArray(data)) throw new Error('设备列表格式无效');
    const matches = [...new Set(data.filter(item => item?.value != null && String(item.value).trim()).map(item => String(item.value)))].slice(0, 50).map(number => ({ number, name: '', online: false }));
    // Bound concurrent lookups while resolving the real state for each device.
    for (let start = 0; start < matches.length; start += 6) {
      await Promise.all(matches.slice(start, start + 6).map(async match => {
        try {
          const records = await terminalDevices({ deviceNumber: match.number });
          const record = records.find(item => String(item?.deviceNumber) === match.number);
          if (record) {
            Object.assign(match, toMatch(record));
            match.name = await locomotiveName(record);
          }
        } catch {
          // Keep the matched number and any resolved state if enrichment fails.
        }
      }));
    }
    return matches;
  };
  const byLocomotive = async () => {
    const data = await request('/jdf/locomotive/allPage4queryForFaultReport', { locoNumber: query }, '车号搜索');
    const locomotives = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(locomotives)) throw new Error('车号列表格式无效');
    const bindings = new Map();
    for (const item of locomotives) {
      // A locomotive ID is the terminal-device endpoint's bindId, never a device number.
      const bindId = item?.id ?? item?.bindId;
      if (bindId == null || !String(bindId).trim()) throw new Error('车号列表缺少绑定 ID');
      const name = String(item.locoNumber ?? '').trim();
      bindings.set(String(bindId), name);
      if (name) locomotiveNames.set(String(bindId), Promise.resolve(name));
    }
    const entries = [...bindings];
    const matches = [];
    for (let start = 0; start < entries.length; start += 6) {
      const results = await Promise.all(entries.slice(start, start + 6).map(async ([bindId, name]) => {
        const records = await terminalDevices({ bindId });
        return records.filter(item => item?.deviceNumber != null && String(item.deviceNumber).trim()).map(item => toMatch(item, name));
      }));
      matches.push(...results.flat());
    }
    return matches;
  };
  // Both interpretations run for every keyword; one unavailable endpoint must
  // not hide usable devices returned by the other search.
  const results = await Promise.allSettled([byDeviceNumber(), byLocomotive()]);
  const matches = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      const previous = matches.get(item.number);
      matches.set(item.number, { ...item, name: item.name || previous?.name || '' });
    }
  }
  if (!matches.size) {
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return [...matches.values()].slice(0, 50);
}

module.exports = { createWebTelnet, webLogin, getTelnetToken, normalizeWebAddress, searchDevices, normalizeWebInput };
