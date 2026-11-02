const { parentPort, workerData } = require('node:worker_threads');
try { parentPort.postMessage({ result: require('./sqlite-reader.cjs').readSqlite(workerData.file, workerData.table, workerData.offset, workerData.search) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
