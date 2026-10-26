// Display changes leave both terminal connections alive; only a new attempt or explicit close cancels pending work.
function createTerminalMode() {
  let mode = 'telnet', generation = 0;
  return {
    select(next) {
      if (!['ssh', 'telnet'].includes(next)) throw new Error('终端模式无效');
      mode = next;
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
