const { parentPort, workerData } = require('node:worker_threads');
const { loadCapture, queryCapture, captureDetail } = require('./pcap-reader.cjs');

loadCapture(workerData.file).then(capture => {
  parentPort.on('message', ({ id, method, args }) => {
    try {
      const result = method === 'query' ? queryCapture(capture, args) : method === 'detail' ? captureDetail(capture, args) : (() => { throw new Error('抓包操作无效'); })();
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
  parentPort.postMessage({ id: 0, result: capture.summary });
}).catch(error => { parentPort.postMessage({ id: 0, error: error.message }); parentPort.close(); });
