import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { searchDevices } = createRequire(import.meta.url)('../electron/web-telnet.cjs');
const login = { token: 'test', tenantId: 7 };
const address = 'http://example.test';
const response = data => ({ ok: true, json: async () => ({ code: 0, data }) });
function mockFetch(t, handler) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test');
    assert.equal(options.headers.tenant_id, '7');
    assert.equal(options.headers.Signature, createHash('md5').update(url.pathname.replace(/^\/(?:common|jdf)/, '') + url.search).digest('hex'));
    return handler(url);
  });
}

test('both searches start together and locomotive IDs resolve through bindId before merging devices', async t => {
  const seen = [];
  let releaseDevice;
  const locomotiveStarted = new Promise(resolve => { releaseDevice = resolve; });
  mockFetch(t, async url => {
    seen.push(url);
    if (url.pathname === '/common/device/match/33') {
      await locomotiveStarted;
      return response([{ value: '9001' }, { value: '9001' }]);
    }
    if (url.pathname === '/jdf/locomotive/allPage4queryForFaultReport') {
      assert.equal(url.searchParams.get('locoNumber'), '33');
      releaseDevice();
      return response([{ id: 1816, locoNumber: '3301' }]);
    }
    assert.equal(url.pathname, '/jdf/terminal-device/page');
    assert.equal(url.searchParams.get('matter'), 'false');
    assert.equal(url.searchParams.get('pageSize'), '10');
    if (url.searchParams.has('bindId')) {
      assert.equal(url.searchParams.get('bindId'), '1816');
      return response({ records: [{ deviceNumber: '9001', state: '1' }, { deviceNumber: '9002', state: 0 }], pages: 1 });
    }
    assert.equal(url.searchParams.get('deviceNumber'), '9001');
    return response({ records: [{ deviceNumber: 'other', state: 1 }, { deviceNumber: '9001', state: 0 }], pages: 1 });
  });
  assert.deepEqual(await searchDevices(address, login, ' 33 '), [
    { number: '9001', name: '3301', online: true }, { number: '9002', name: '3301', online: false }
  ]);
  assert.equal(seen.filter(url => url.searchParams.has('deviceNumber')).length, 1);
});

test('locomotive search follows terminal pages and deduplicates repeated vehicle bindings', async t => {
  const pages = [];
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) return response([]);
    if (url.pathname.includes('/locomotive/')) return response({ records: [{ id: 1816, locoNumber: '3301' }, { id: 1816, locoNumber: '3301' }] });
    const page = Number(url.searchParams.get('pageNum'));
    pages.push(page);
    return response({ records: [{ deviceNumber: String(9000 + page), state: page === 2 ? 1 : 0 }], pages: 2 });
  });
  assert.deepEqual(await searchDevices(address, login, '33'), [
    { number: '9001', name: '3301', online: false }, { number: '9002', name: '3301', online: true }
  ]);
  assert.deepEqual(pages, [1, 2]);
});

test('a failed source preserves usable results from the other source', async t => {
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) throw new Error('offline');
    if (url.pathname.includes('/locomotive/')) return response([{ id: 1816, locoNumber: '33' }]);
    return response({ records: [{ deviceNumber: '9001', state: 1 }], pages: 1 });
  });
  assert.deepEqual(await searchDevices(address, login, '33'), [{ number: '9001', name: '33', online: true }]);
});

test('vehicle IDs are never returned as connection numbers and device matches survive vehicle lookup errors', async t => {
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) return response([{ value: '9001' }]);
    if (url.pathname.includes('/locomotive/')) return { ok: false, status: 503 };
    throw new Error('state lookup offline');
  });
  assert.deepEqual(await searchDevices(address, login, '33'), [{ number: '9001', name: '', online: false }]);
});

test('empty results, malformed binding data, and HTTP failures remain distinguishable', async t => {
  mockFetch(t, () => response([]));
  assert.deepEqual(await searchDevices(address, login, ''), []);
  assert.deepEqual(await searchDevices(address, login, '33'), []);
  mockFetch(t, url => response(url.pathname.startsWith('/common/') ? [] : [{ locoNumber: '33', deviceNumber: '1816' }]));
  await assert.rejects(searchDevices(address, login, '33'), /缺少绑定 ID/);
  mockFetch(t, url => url.pathname.startsWith('/common/') ? response([]) : { ok: false, status: 503 });
  await assert.rejects(searchDevices(address, login, '33'), /车号搜索 HTTP 503/);
});

test('alphanumeric keywords still call both search endpoints and are URL encoded', async t => {
  const paths = [];
  mockFetch(t, url => {
    paths.push(url.pathname);
    if (url.pathname.includes('/locomotive/')) assert.equal(url.searchParams.get('locoNumber'), 'HXD/33');
    return response([]);
  });
  assert.deepEqual(await searchDevices(address, login, 'HXD/33'), []);
  assert.deepEqual(paths, ['/common/device/match/HXD%2F33', '/jdf/locomotive/allPage4queryForFaultReport']);
});

test('device-number-only hits resolve locomotive names by bindId and share vehicle detail requests', async t => {
  const detailPaths = [];
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) return response([{ value: '9001' }, { value: '9002' }]);
    if (url.pathname.includes('/allPage4queryForFaultReport')) return response([]);
    if (url.pathname === '/jdf/terminal-device/page') {
      return response({ records: [{ deviceNumber: url.searchParams.get('deviceNumber'), bindId: 1816, nameplate: '设备铭牌', name: '终端名称', state: '1' }], pages: 1 });
    }
    detailPaths.push(url.pathname);
    assert.equal(url.pathname, '/jdf/locomotive/1816');
    return response({ id: 1816, locoNumber: 'SS8-0163' });
  });
  assert.deepEqual(await searchDevices(address, login, '900'), [
    { number: '9001', name: 'SS8-0163', online: true },
    { number: '9002', name: 'SS8-0163', online: true }
  ]);
  assert.equal(detailPaths.length, 1);
});

test('device records with locomotive numbers need no extra detail lookup', async t => {
  const paths = [];
  mockFetch(t, url => {
    paths.push(url.pathname);
    if (url.pathname.startsWith('/common/')) return response([{ value: '9001' }]);
    if (url.pathname.includes('/allPage4queryForFaultReport')) return response([]);
    assert.equal(url.pathname, '/jdf/terminal-device/page');
    return response({ records: [{ deviceNumber: '9001', locoNumber: '00163', bindId: 1816, state: 1 }], pages: 1 });
  });
  assert.deepEqual(await searchDevices(address, login, '9001'), [{ number: '9001', name: '00163', online: true }]);
  assert.equal(paths.length, 3);
});

test('device hits reuse names from the simultaneous locomotive search for the same binding', async t => {
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) return response([{ value: '9001' }]);
    if (url.pathname.includes('/allPage4queryForFaultReport')) return response([{ id: 1816, locoNumber: '00163' }]);
    assert.equal(url.pathname, '/jdf/terminal-device/page');
    return response({ records: [{ deviceNumber: '9001', bindId: 1816, state: 1 }], pages: 1 });
  });
  assert.deepEqual(await searchDevices(address, login, '163'), [{ number: '9001', name: '00163', online: true }]);
});

test('failed or unbound vehicle details preserve actual device state without using device names as car numbers', async t => {
  const details = [];
  mockFetch(t, url => {
    if (url.pathname.startsWith('/common/')) return response([{ value: '9001' }, { value: '9002' }]);
    if (url.pathname.includes('/allPage4queryForFaultReport')) return response([]);
    if (url.pathname === '/jdf/terminal-device/page') {
      const number = url.searchParams.get('deviceNumber');
      return response({ records: [{ deviceNumber: number, bindId: number === '9001' ? 1816 : 0, nameplate: '铭牌', name: '设备名称', state: 1 }], pages: 1 });
    }
    details.push(url.pathname);
    return { ok: false, status: 503 };
  });
  assert.deepEqual(await searchDevices(address, login, '900'), [
    { number: '9001', name: '', online: true }, { number: '9002', name: '', online: true }
  ]);
  assert.deepEqual(details, ['/jdf/locomotive/1816']);
});
