// net.fetch cancels manual redirects instead of returning a 3xx Response.
// Probe headers through net.request, expose each redirect to the updater for
// validation, then stream the final GET through net.fetch with redirects denied.
// Both requests use Chromium's system proxy configuration.
function createUpdateFetch(net) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(signal.reason || new Error('更新请求已取消')); return; }
    let settled = false, request;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const abort = () => { fail(signal.reason || new Error('更新请求已取消')); request?.abort(); };
    try {
      request = net.request({ url, method: 'HEAD', redirect: 'manual' });
      for (const [name, value] of Object.entries(options.headers || {})) request.setHeader(name, value);
      request.on('error', fail);
      request.on('redirect', (status, _method, location) => {
        if (settled) return;
        settled = true; cleanup();
        resolve(new Response(null, { status, headers: { location } }));
        request.abort();
      });
      request.on('response', response => {
        response.on('error', () => {});
        if (settled) return;
        settled = true; cleanup();
        request.abort();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          resolve(new Response(null, { status: response.statusCode }));
          return;
        }
        resolve(net.fetch(url, { ...options, redirect: 'error' }));
      });
      signal?.addEventListener('abort', abort, { once: true });
      request.end();
    } catch (error) { fail(error); request?.abort(); }
  });
}
module.exports = { createUpdateFetch };
