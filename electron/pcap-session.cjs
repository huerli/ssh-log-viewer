const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createCaptureSession(file) {
  const worker = new Worker(path.join(__dirname, 'pcap-worker.cjs'), { workerData: { file } });
  const pending = new Map();
  let sequence = 0, stopped = false;
  function stop(error = new Error('抓包文件已关闭')) {
    if (stopped) return;
    stopped = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    return worker.terminate();
  }
  function request(method, args, initial = false) {
    if (stopped) return Promise.reject(new Error('抓包文件已关闭，请重新打开'));
    const id = initial ? 0 : ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('抓包读取超过 30 秒，请重新打开较小的文件')), 30000);
      pending.set(id, { resolve, reject, timer });
      if (!initial) worker.postMessage({ id, method, args });
    });
  }
  const ready = request(undefined, undefined, true);
  worker.on('message', ({ id, result, error }) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (error) { item.reject(new Error(error)); if (id === 0) stop(); }
    else item.resolve(result);
  });
  worker.on('error', error => stop(error));
  worker.on('exit', () => stop(new Error('抓包读取线程已退出，请重新打开')));
  return { ready, query: options => request('query', options), detail: number => request('detail', number), dispose: () => stop() };
}
module.exports = { createCaptureSession };
