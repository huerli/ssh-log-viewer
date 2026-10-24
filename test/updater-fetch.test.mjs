import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdateFetch } from '../electron/updater-fetch.cjs';

function fixture() {
  const requests = [], fetches = [];
  const net = {
    request(options) {
      const request = new EventEmitter();
      Object.assign(request, { options, headers: {}, aborted: false,
        setHeader(name, value) { this.headers[name] = value; },
        end() {}, abort() { this.aborted = true; this.emit('error', new Error('Redirect was cancelled')); },
      });
      requests.push(request); return request;
    },
    fetch(url, options) { fetches.push({ url, options }); return Promise.resolve(new Response('verified body')); },
  };
  return { requests, fetches, fetch: createUpdateFetch(net) };
}

test('exposes manual Chromium redirects without following the destination', async () => {
  const f = fixture();
  const pending = f.fetch('https://github.com/example', { redirect: 'manual' });
  f.requests[0].emit('redirect', 302, 'HEAD', 'https://release-assets.githubusercontent.com/asset');
  const response = await pending;
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://release-assets.githubusercontent.com/asset');
  assert.equal(f.fetches.length, 0, 'updater must validate the redirect before any destination request');
  assert.equal(f.requests[0].aborted, true);
});

test('streams the final GET natively, denying a redirect race and preserving cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.fetch('https://github.com/file', { signal: controller.signal, headers: { Accept: 'application/octet-stream' } });
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  f.requests[0].emit('response', response);
  assert.equal(await (await pending).text(), 'verified body');
  assert.equal(f.requests[0].options.method, 'HEAD');
  assert.equal(f.requests[0].headers.Accept, 'application/octet-stream');
  assert.equal(f.fetches[0].options.redirect, 'error');
  assert.equal(f.fetches[0].options.signal, controller.signal);
  assert.equal(f.requests[0].aborted, true);
});

test('cancels an outstanding header request without issuing the download', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.fetch('https://github.com/file', { signal: controller.signal });
  controller.abort(new Error('cancelled by user'));
  await assert.rejects(pending, /cancelled by user/);
  assert.equal(f.requests[0].aborted, true);
  assert.equal(f.fetches.length, 0);
});

test('reports HTTP failures without starting a second request', async () => {
  const f = fixture();
  const pending = f.fetch('https://github.com/file');
  f.requests[0].emit('response', Object.assign(new EventEmitter(), { statusCode: 503 }));
  assert.equal((await pending).status, 503);
  assert.equal(f.fetches.length, 0);
});
