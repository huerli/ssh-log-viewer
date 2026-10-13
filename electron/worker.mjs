import { parentPort, workerData } from 'node:worker_threads';
import { buildIndex, searchFile } from './log-core.mjs';
try {
  const report = data => parentPort.postMessage({ type: 'progress', data });
  const result = workerData.kind === 'index'
    ? await buildIndex(workerData.file, report)
    : await searchFile(workerData.file, workerData.query, workerData.options, report);
  parentPort.postMessage({ type: 'result', result }, result.positions ? [result.positions.buffer] : []);
} catch (error) { parentPort.postMessage({ type: 'error', error: error.message }); }
