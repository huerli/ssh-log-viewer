function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('跳板机反向隧道端口无效，必须是 1–65535 的整数');
}

// Inspect kernel socket ownership before signalling anything. In particular, an
// sshd master or a session with additional forwards must never be terminated.
function buildJumpPortReleaseCommand(port) {
  validatePort(port);
  // @@{ represents shell parameter expansion without JavaScript interpolation.
  const script = String.raw`
port=PORT_TO_RELEASE
fail() { printf '%s\n' "$*" >&2; exit 1; }
for tool in awk readlink tr od sleep; do
  command -v "$tool" >/dev/null 2>&1 || fail "释放跳板机端口需要 Linux 工具：$tool"
done
[ -r /proc/net/tcp ] || fail '无法读取 /proc/net/tcp，不能安全确认跳板机端口归属'
[ ! -e /proc/net/tcp6 ] || [ -r /proc/net/tcp6 ] || fail '无法读取 IPv6 监听信息，不能安全确认端口归属'
byte_order=$(printf '\001\000' | od -An -tu2 | tr -d '[:space:]')
case "$byte_order" in
  1) loop4=0100007F; loop6=00000000000000000000000001000000 ;;
  256) loop4=7F000001; loop6=00000000000000000000000000000001 ;;
  *) fail '无法判断跳板机字节序，不能安全检查监听地址' ;;
esac
port_hex=$(printf '%04X' "$port")
listeners() {
  awk 'FNR > 1 && $4 == "0A" { split($2, a, ":"); print $10 ":" a[2] ":" a[1] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}
target_inodes() {
  listeners | awk -F: -v p="$port_hex" -v a="$loop4" -v b="$loop6" '$2 == p && ($3 == a || $3 == b) { print $1 }'
}
non_loopback=$(listeners | awk -F: -v p="$port_hex" -v a="$loop4" -v b="$loop6" '$2 == p && $3 != a && $3 != b { print $1 }')
[ -z "$non_loopback" ] || fail "端口 $port 存在非 localhost 监听，拒绝结束该服务"
inodes=$(target_inodes | tr '\n' ' ')
[ -n "$inodes" ] || { printf 'JUMP_PORT_ABSENT\n'; exit 0; }
# Protect the SSH session executing this command, including all its ancestors.
protected=' '
ancestor=$$
while [ "$ancestor" -gt 1 ] 2>/dev/null; do
  case "$protected" in *" $ancestor "*) break ;; esac
  protected="$protected$ancestor "
  ancestor=$(awk '/^PPid:/ { print $2 }' "/proc/$ancestor/status" 2>/dev/null)
done
owners=' '
found=' '
for directory in /proc/[0-9]*/fd; do
  [ -d "$directory" ] || continue
  pid=@@{directory#/proc/}; pid=@@{pid%/fd}
  sockets=$(readlink "$directory"/* 2>/dev/null)
  for socket in $sockets; do
    case "$socket" in 'socket:['*']') inode=@@{socket#socket:[}; inode=@@{inode%]} ;; *) continue ;; esac
    case " $inodes " in *" $inode "*)
      case "$owners" in *" $pid "*) ;; *) owners="$owners$pid " ;; esac
      found="$found$inode "
    ;; esac
  done
done
for inode in $inodes; do
  case "$found" in *" $inode "*) ;; *) fail "无法确认端口 $port 的进程归属；请使用有权限的跳板机账号手动释放" ;; esac
done
identity() { awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null; }
check_owner() {
  pid=$1
  [ "$pid" -gt 1 ] || fail '拒绝结束系统进程'
  case "$protected" in *" $pid "*) fail "端口 $port 属于当前跳板机连接，拒绝结束当前 SSH 会话" ;; esac
  executable=$(readlink "/proc/$pid/exe" 2>/dev/null) || fail "无权验证进程 $pid；未释放端口 $port"
  case "@@{executable##*/}" in sshd|sshd-session) ;; *) fail "端口 $port 属于非 SSH 服务（进程 $pid），未执行终止" ;; esac
  title=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || fail "无法读取 SSH 进程 $pid 的会话信息"
  case "$title" in 'sshd: '*|'sshd-session: '*) ;; *) fail "无法确认进程 $pid 是独立 SSH 会话，拒绝结束 SSH 主服务" ;; esac
  # A forward-only connection has title "sshd: user" until a session channel
  # opens; interactive/exec sessions use "sshd: user@pts/..." or "@notty".
  set -- $title
  [ "$#" -eq 2 ] || fail "无法确认进程 $pid 是独立 SSH 会话，拒绝结束 SSH 主服务"
  case "$2" in -*|*'['*|*']'*) fail "进程 $pid 不是可释放的 SSH 会话" ;; *@*) ;; */*) fail "拒绝结束 SSH 主服务 $pid" ;; esac
  # A session can own several socket descriptors for the same IPv4/IPv6
  # forward. Refuse if it also owns any other listening address or port.
  all_listeners=$(listeners)
  owns_target=no
  sockets=$(readlink "/proc/$pid/fd"/* 2>/dev/null)
  for socket in $sockets; do
    case "$socket" in 'socket:['*']') inode=@@{socket#socket:[}; inode=@@{inode%]} ;; *) continue ;; esac
    records=$(printf '%s\n' "$all_listeners" | awk -F: -v i="$inode" '$1 == i')
    [ -n "$records" ] || continue
    for record in $records; do
      case "$record" in "$inode:$port_hex:$loop4"|"$inode:$port_hex:$loop6") owns_target=yes ;; *) fail "SSH 会话 $pid 还监听其他地址或端口，拒绝中断该会话；请手动释放端口 $port" ;; esac
    done
  done
  [ "$owns_target" = yes ] || fail "端口 $port 的进程归属已变化，请重试"
}
identities=''
for pid in $owners; do
  check_owner "$pid"
  started=$(identity "$pid")
  [ -n "$started" ] || fail "无法验证 SSH 进程 $pid 的启动时间"
  identities="$identities $pid:$started"
done
for entry in $identities; do
  pid=@@{entry%:*}; started=@@{entry#*:}
  [ "$(identity "$pid")" = "$started" ] || fail 'SSH 进程已变化，已停止释放操作，请重试'
  check_owner "$pid"
done
for entry in $identities; do
  pid=@@{entry%:*}; started=@@{entry#*:}
  [ "$(identity "$pid")" = "$started" ] || fail 'SSH 进程已变化，已停止释放操作，请重试'
  kill -TERM "$pid" 2>/dev/null || fail "无权结束 SSH 会话 $pid，端口 $port 未释放"
done
attempt=0
while [ "$attempt" -lt 10 ]; do
  [ -n "$(target_inodes)" ] || { printf 'JUMP_PORT_RELEASED\n'; exit 0; }
  sleep 0.2
  attempt=$((attempt + 1))
done
fail "已请求结束反向 SSH 会话，但端口 $port 仍在监听；未强制终止，请在跳板机检查"
`;
  return `sh -c '${script.replaceAll('@@{', '$' + '{').replace('PORT_TO_RELEASE', String(port)).replace(/'/g, "'\\''")}'`;
}

async function releaseJumpPort(jumpClient, targetPort) {
  const command = buildJumpPortReleaseCommand(targetPort);
  if (!jumpClient || typeof jumpClient.exec !== 'function') throw new Error('跳板机 SSH 连接不可用，无法释放反向隧道端口');
  return new Promise((resolve, reject) => {
    let stream, output = '', errors = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      jumpClient.removeListener?.('close', onDisconnect);
      if (error) { try { stream?.close?.(); } catch {} reject(error); }
      else resolve(result);
    };
    const onDisconnect = () => finish(new Error('跳板机连接提前关闭，无法确认反向隧道端口是否释放'));
    const timer = setTimeout(() => finish(new Error('释放跳板机反向隧道端口超时（8 秒）；请在跳板机检查端口状态')), 8000);
    jumpClient.once?.('close', onDisconnect);
    try {
      jumpClient.exec(command, (error, channel) => {
        if (settled) { try { channel?.close?.(); } catch {} return; }
        if (error) return finish(new Error(`无法在跳板机执行端口释放：${error.message}`));
        stream = channel;
        stream.setEncoding?.('utf8');
        stream.stderr?.setEncoding?.('utf8');
        const collect = (chunk, stderr) => {
          if (stderr) errors += chunk.toString(); else output += chunk.toString();
          if (output.length + errors.length > 16384) finish(new Error('跳板机端口释放输出异常，无法确认端口状态'));
        };
        stream.on('data', chunk => collect(chunk, false));
        stream.stderr?.on('data', chunk => collect(chunk, true));
        stream.on('error', error => finish(new Error(`跳板机端口释放失败：${error.message}`)));
        stream.on('close', code => {
          if (code !== 0) return finish(new Error(errors.trim() || `跳板机端口释放失败（退出码 ${code ?? '未知'}）`));
          const lines = output.trim().split(/\r?\n/);
          if (lines.includes('JUMP_PORT_RELEASED')) return finish(null, { released: true, message: `已释放跳板机 localhost:${targetPort}，设备再次连接前需重建反向 SSH 隧道` });
          if (lines.includes('JUMP_PORT_ABSENT')) return finish(null, { released: false, message: `跳板机 localhost:${targetPort} 已无监听，端口无需释放` });
          finish(new Error('跳板机未返回有效端口检查结果，无法确认反向隧道已释放'));
        });
      });
    } catch (error) { finish(new Error(`无法在跳板机执行端口释放：${error.message}`)); }
  });
}

module.exports = { releaseJumpPort, buildJumpPortReleaseCommand };
