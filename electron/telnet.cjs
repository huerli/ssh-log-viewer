const net = require('node:net');
const { StringDecoder } = require('node:string_decoder');
function createTelnet(emit) {
  let socket;
  const close = () => { const old = socket; socket = undefined; old?.destroy(); };
  return {
    close,
    write(text) {
      if (!socket || socket.destroyed) throw new Error('Telnet 未连接');
      if (typeof text !== 'string' || text.length > 65536) throw new Error('输入过长');
      const bytes = []; for (const byte of Buffer.from(text)) { bytes.push(byte); if (byte === 255) bytes.push(255); }
      socket.write(Buffer.from(bytes));
    },
    connect(host, port) {
      if (typeof host !== 'string' || !host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Telnet 地址或端口无效');
      close();
      return new Promise((resolve, reject) => {
        const own = net.createConnection({ host: host.trim(), port }); socket = own;
        const decoder = new StringDecoder('utf8');
        let state = 0, command = 0, connected = false;
        own.setTimeout(15000);
        own.on('connect', () => { connected = true; own.setTimeout(0); emit({ type: 'telnet-status', message: '已连接' }); resolve(); });
        own.on('timeout', () => own.destroy(new Error('Telnet 连接超时')));
        own.on('data', buffer => {
          const bytes = [];
          for (const byte of buffer) {
            if (state === 0) { if (byte === 255) state = 1; else bytes.push(byte); }
            else if (state === 1) {
              if (byte === 255) { bytes.push(byte); state = 0; }
              else if (byte === 250) state = 3;
              else if ([251,252,253,254].includes(byte)) { command = byte; state = 2; }
              else state = 0;
            } else if (state === 2) {
              if (command === 253) own.write(Buffer.from([255,252,byte]));
              if (command === 251) own.write(Buffer.from([255,254,byte]));
              state = 0;
            } else if (state === 3 && byte === 255) state = 4;
            else if (state === 4) state = byte === 240 ? 0 : 3;
          }
          if (socket === own && bytes.length) emit({ type: 'telnet-data', message: decoder.write(Buffer.from(bytes)) });
        });
        own.on('error', error => { if (!connected) reject(error); if (socket === own) emit({ type: 'telnet-status', message: error.message }); });
        own.on('close', () => { if (!connected) reject(new Error('Telnet 连接已关闭')); if (socket === own) { socket = undefined; emit({ type: 'telnet-status', message: '已断开' }); } });
      });
    }
  };
}
module.exports = { createTelnet };
