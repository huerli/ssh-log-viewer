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
      const raw = Buffer.from(text);
      if (raw.length > 117) throw new Error('Web Telnet 单次输入最多 117 字节');
      socket.volatile.emit('userInput', crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, raw).toString('base64'));
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
const deviceCatalogs = new WeakMap();
async function searchDevices(address, login, keyword) {
  const query = String(keyword || '').trim().toLowerCase();
  if (!query) return [];
  // Use the backend's lightweight fuzzy device-number endpoint while typing.
  if (/^\d+$/.test(query)) {
    const t = String(Math.floor(Date.now() / 1000));
    const url = new URL(normalizeWebAddress(address) + '/common/device/match/' + encodeURIComponent(query));
    url.search = new URLSearchParams({ t }).toString();
    const signature = crypto.createHash('md5').update('/device/match/' + query + '?t=' + t).digest('hex');
    const headers = { Authorization: 'Bearer ' + login.token, appCode: 'teee', Signature: signature };
    if (login.tenantId != null) headers.tenant_id = String(login.tenantId);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error('设备搜索请求失败'); });
    if (!response.ok) throw new Error('设备搜索 HTTP ' + response.status);
    const result = await response.json();
    if (result.code !== 0) throw new Error('设备搜索失败，请重新登录');
    if (!Array.isArray(result.data)) throw new Error('设备列表格式无效');
    const matches = result.data.filter(item => item?.value != null).map(item => ({ number: String(item.value), name: '', online: false })).slice(0, 50);
    // The lightweight match endpoint only returns device numbers. Enrich a
    // small result set with the exact terminal-device records so short input
    // such as "3311" also shows the actual online state.
    if (matches.length > 0 && matches.length <= 20) {
      await Promise.all(matches.map(async match => {
        try {
          const statusUrl = new URL(normalizeWebAddress(address) + '/jdf/terminal-device/page');
          statusUrl.search = new URLSearchParams({ t: String(Math.floor(Date.now() / 1000)), pageNum: '1', pageSize: '10', deviceNumber: match.number, matter: 'false' }).toString();
          const statusSignature = crypto.createHash('md5').update('/terminal-device/page' + statusUrl.search).digest('hex');
          const statusHeaders = { Authorization: 'Bearer ' + login.token, appCode: 'teee', Signature: statusSignature };
          if (login.tenantId != null) statusHeaders.tenant_id = String(login.tenantId);
          const statusResponse = await fetch(statusUrl, { headers: statusHeaders, signal: AbortSignal.timeout(30000) });
          if (statusResponse.ok) {
            const statusResult = await statusResponse.json();
            const record = statusResult.code === 0 && statusResult.data?.records?.[0];
            if (record) match.online = Number(record.state) === 1;
          }
        } catch {
          // Keep the match result usable if optional status enrichment fails.
        }
      }));
    }
    return matches;
  }
  let cached = deviceCatalogs.get(login);
  if (!cached || cached.expires < Date.now()) {
    const promise = (async () => {
      const devices = new Map();
      const fetchPage = async page => {
        const url = new URL(normalizeWebAddress(address) + '/jdf/terminal-device/page');
        url.search = new URLSearchParams({ t: String(Math.floor(Date.now() / 1000)), matter: 'false', pageNum: String(page), pageSize: '500' }).toString();
        const signature = crypto.createHash('md5').update('/terminal-device/page' + url.search).digest('hex');
        const headers = { Authorization: 'Bearer ' + login.token, appCode: 'teee', Signature: signature };
        if (login.tenantId != null) headers.tenant_id = String(login.tenantId);
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error('设备搜索请求失败'); });
        if (!response.ok) throw new Error('设备搜索 HTTP ' + response.status);
        const result = await response.json();
        if (result.code !== 0) throw new Error('设备搜索失败，请重新登录');
        const records = result.data?.records;
        if (!Array.isArray(records)) throw new Error('设备列表格式无效');
        return { records, pages: Number(result.data.pages) };
      };
      const first = await fetchPage(1);
      const pages = first.pages > 0 ? first.pages : (first.records.length < 500 ? 1 : 0);
      const results = [first];
      if (pages > 1) {
        for (let start = 2; start <= pages; start += 6) {
          const batch = await Promise.all(Array.from({ length: Math.min(6, pages - start + 1) }, (_, index) => fetchPage(start + index)));
          results.push(...batch);
        }
      }
      for (const result of results) {
        for (const item of result.records) {
          if (item.deviceNumber == null) continue;
          const number = String(item.deviceNumber);
          devices.set(number, { number, name: String(item.locoNumber || item.nameplate || item.name || ''), online: item.state === 1 });
        }
      }
      return [...devices.values()];
    })();
    cached = { promise, expires: Date.now() + 60000 };
    deviceCatalogs.set(login, cached);
    promise.catch(() => { if (deviceCatalogs.get(login) === cached) deviceCatalogs.delete(login); });
  }
  return (await cached.promise).filter(item => item.number.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)).slice(0, 50);
}

module.exports = { createWebTelnet, webLogin, getTelnetToken, normalizeWebAddress, searchDevices };
