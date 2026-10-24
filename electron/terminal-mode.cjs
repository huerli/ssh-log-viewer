// Display changes leave Telnet connected; only a new attempt or explicit close cancels its pending work.
function createTerminalMode({ closeSsh }) {
  let mode = 'telnet', generation = 0;
  return {
    select(next) {
      if (!['ssh', 'telnet'].includes(next)) throw new Error('终端模式无效');
      mode = next;
      if (mode === 'telnet') closeSsh();
      return mode;
    },
    get mode() { return mode; },
    token() { return generation; },
    cancel() { generation++; },
    check(token) {
      if (generation !== token) throw new Error('命令终端连接已取消');
    },
  };
}
module.exports = { createTerminalMode };
