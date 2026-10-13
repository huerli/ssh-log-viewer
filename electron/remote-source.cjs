const { Readable } = require('node:stream');

// Ordered, bounded prefetch: eight independent 256KB reads, ~2MB resident data.
// This avoids one network round trip per stream chunk on high-latency links.
function remoteSource(sftp, filename, start, size, signal) {
  async function* chunks() {
    let handle; const queue = []; let offset = start;
    const check = () => { if (signal?.aborted) throw new Error('操作已取消'); };
    const invoke = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (e, ...values) => e ? reject(e) : resolve(values)));
    async function block(position, length) {
      const buffer = Buffer.alloc(length); let filled = 0;
      while (filled < length) {
        check();
        const [bytes] = await invoke('read', handle, buffer, filled, length - filled, position + filled);
        if (!bytes) break;
        filled += bytes;
      }
      return buffer.subarray(0, filled);
    }
    function prefetch() {
      while (queue.length < 8 && offset < size) {
        const length = Math.min(256 * 1024, size - offset);
        // Rejections are consumed immediately, including reads cancelled out of order.
        queue.push(block(offset, length).then(buffer => ({ buffer, length }), error => ({ error })));
        offset += length;
      }
    }
    try {
      check(); [handle] = await invoke('open', filename, 'r'); prefetch();
      while (queue.length) {
        const next = await queue.shift(); check();
        if (next.error) throw next.error;
        if (next.buffer.length !== next.length) throw new Error('远程文件读取不完整，可能已被截断');
        yield next.buffer; prefetch();
      }
    } finally {
      await Promise.all(queue);
      if (handle) { try { await invoke('close', handle); } catch {} }
    }
  }
  return Readable.from(chunks(), { objectMode: false, highWaterMark: 256 * 1024 });
}
module.exports = { remoteSource };
