const { reverseSshParserScript } = require('./reverse-ssh-parse.cjs');
const { runReverseCleanup } = require('./reverse-cleanup-exec.cjs');
function buildStopWorkerCommand({ port, host, sshPort, tunneled = false } = {}) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('反向隧道端口无效');
  if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) throw new Error('跳板机 SSH 端口无效');
  if (host !== undefined && (typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]_-]+$/.test(host))) throw new Error('跳板机地址无效');
  const script = String.raw`
expected_port=EXPECTED_PORT
expected_host=EXPECTED_HOST
expected_ssh_port=EXPECTED_SSH_PORT
use_session=USE_SESSION
fail() { printf '%s\n' "$*" >&2; exit 1; }
${reverseSshParserScript}
printf 'REVERSE_CLEANUP_DISCOVERING\n'
for tool in awk tr readlink sleep od; do
  command -v "$tool" >/dev/null 2>&1 || fail "停止 reverse-ssh-worker 需要 Linux 工具：$tool"
done
[ -d /proc/1 ] || fail '无法检查设备进程，未停止 reverse-ssh-worker'
identity() { awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null; }
alive() {
  [ "$(identity "$1")" = "$2" ] || return 1
  state=$(awk '/^State:/ { print $2 }' "/proc/$1/status" 2>/dev/null)
  [ -n "$state" ] && [ "$state" != Z ] && [ "$state" != X ]
}
matches_candidate() {
  [ -z "$expected_port" ] || [ "$candidate_port" = "$expected_port" ] || return 1
  [ "$ignore_destination" = yes ] && return 0
  if [ -n "$expected_user" ] && [ "$candidate_user" != "$expected_user" ]; then
    [ "$candidate_kind" = worker ] && [ "$candidate_user" = - ] || return 1
  fi
  [ -z "$expected_host" ] || [ "$candidate_host" = "$expected_host" ] || return 1
  [ -z "$expected_ssh_port" ] || [ "$candidate_ssh_port" = "$expected_ssh_port" ] || return 1
}
worker() {
  checked_worker_pid=$1
  executable=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$executable" in */sh|*/ash|*/dash|*/bash|*/busybox|*/reverse-ssh-worker) ;; *) return 1 ;; esac
  arguments=$(tr '\000' ' ' 2>/dev/null < "/proc/$1/cmdline") || return 1
  set -f
  set -- $arguments
  set +f
  case "$1" in
    /usr/local/sbin/reverse-ssh-worker) shift ;;
    */sh|sh|*/ash|ash|*/dash|dash|*/bash|bash) [ "$2" = /usr/local/sbin/reverse-ssh-worker ] || return 1; shift 2 ;;
    *) return 1 ;;
  esac
  [ "$#" -eq 3 ] || return 1
  case "$1:$3" in *[!0-9:]*|:*|*:) return 1 ;; esac
  worker_forward_port=$1; worker_destination=$2; worker_destination_port=$3
  worker_accounts=$(
    for account_child in $(child_pids "$checked_worker_pid"); do
      account_parent=$(awk '/^PPid:/ { print $2 }' "/proc/$account_child/status" 2>/dev/null)
      [ "$account_parent" = "$checked_worker_pid" ] || continue
      account_executable=$(readlink "/proc/$account_child/exe" 2>/dev/null)
      case "$account_executable" in */ssh) ;; *) continue ;; esac
      account_forward=$(ssh_forward "/proc/$account_child/cmdline" 2>/dev/null) || continue
      set -f
      set -- $account_forward
      set +f
      [ "$#" -eq 4 ] && [ "$4" != - ] && printf '%s\n' "$4"
    done | awk '!seen[$0]++'
  )
  set -f
  set -- $worker_accounts
  set +f
  if [ "$#" -eq 0 ]; then candidate_user=-
  elif [ "$#" -eq 1 ]; then candidate_user=$1
  else candidate_user='!multiple'; fi
  candidate_kind=worker
  candidate_port=$worker_forward_port; candidate_host=$worker_destination; candidate_ssh_port=$worker_destination_port
  matches_candidate
}
forward() {
  forward_executable=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$forward_executable" in */ssh) ;; *) return 1 ;; esac
  forward_value=$(ssh_forward "/proc/$1/cmdline" 2>/dev/null) || return 1
  # A dedicated reverse client owns no local listener or multiplex socket.
  # Runtime ownership also catches forwarding/sharing injected by ssh_config.
  forward_links=$(socket_links "/proc/$1/fd")
  forward_listeners=$(local_listener_inodes) || return 1
  for forward_link in $forward_links; do
    case "$forward_link" in 'socket:['*']') forward_inode=@@{forward_link#socket:[}; forward_inode=@@{forward_inode%]} ;; *) continue ;; esac
    case " $forward_listeners " in *" $forward_inode "*) return 1 ;; esac
  done
  set -f
  set -- $forward_value
  set +f
  [ "$#" -eq 4 ] || return 1
  candidate_kind=forward
  candidate_port=$1; candidate_host=$2; candidate_ssh_port=$3; candidate_user=$4
  matches_candidate
}
find_targets() {
  for target_directory in /proc/[0-9]*; do
    target_pid=@@{target_directory#/proc/}
    target_executable=$(readlink "$target_directory/exe" 2>/dev/null) || continue
    case "$target_executable" in
      */ssh) forward "$target_pid" || continue; target_kind=forward ;;
      */sh|*/ash|*/dash|*/bash|*/busybox|*/reverse-ssh-worker) worker "$target_pid" || continue; target_kind=worker ;;
      *) continue ;;
    esac
    target_started=$(identity "$target_pid")
    [ -n "$target_started" ] && printf '%s %s %s %s %s %s %s\n' "$target_kind" "$target_pid" "$candidate_port" "$candidate_host" "$candidate_ssh_port" "$candidate_user" "$target_started"
  done
}
# A reverse-forward child connects locally to this exec session's sshd. Match
# the kernel TCP peer tuples instead of comparing public/domain/NAT endpoints.
session_title() {
  set -f
  set -- $1
  set +f
  [ "$1" = 'sshd:' ] || return 1
  if [ "$#" -eq 2 ]; then
    case "$2" in -*|/*) return 1 ;; *@*) return 0 ;; esac
  elif [ "$#" -eq 3 ] && [ "$3" = '[priv]' ]; then
    case "$2" in -*|*/*) return 1 ;; *) return 0 ;; esac
  fi
  return 1
}
# BusyBox readlink accepts a single path; enumerate descriptors individually.
socket_links() {
  for socket_fd in "$1"/*; do
    readlink "$socket_fd" 2>/dev/null || :
  done
}
local_listener_inodes() {
  [ -r /proc/net/tcp ] && [ -r /proc/net/unix ] || return 1
  [ ! -e /proc/net/tcp6 ] || [ -r /proc/net/tcp6 ] || return 1
  {
    awk 'FNR > 1 && $4 == "0A" && $10 != 0 { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
    awk 'FNR > 1 && $4 == "00010000" && $7 != 0 { print $7 }' /proc/net/unix 2>/dev/null
  } | tr '\n' ' '
}
session_peers() {
  peer_ancestor=$$
  session_count=0
  while [ "$peer_ancestor" -gt 1 ] 2>/dev/null; do
    peer_executable=$(readlink "/proc/$peer_ancestor/exe" 2>/dev/null)
    case "$peer_executable" in
      */sshd|*/sshd-session)
        case "$peer_executable" in
          */sshd)
            peer_title=$(tr '\000' ' ' 2>/dev/null < "/proc/$peer_ancestor/cmdline")
            session_title "$peer_title" || break
          ;;
        esac
        peer_started=$(identity "$peer_ancestor")
        peer_links=$(socket_links "/proc/$peer_ancestor/fd")
        [ -n "$peer_started" ] && [ "$(identity "$peer_ancestor")" = "$peer_started" ] || return 1
        for peer_link in $peer_links; do
          case "$peer_link" in 'socket:['*']') peer_inode=@@{peer_link#socket:[}; peer_inode=@@{peer_inode%]} ;; *) continue ;; esac
          printf '%s\n' "$socket_records" | awk -v i="$peer_inode" '$2 == i && i != 0 { print $1 " " $4 " " $3 }'
        done
        session_count=$((session_count + 1))
        [ "$session_count" -lt 2 ] || break
      ;;
    esac
    peer_ancestor=$(awk '/^PPid:/ { print $2 }' "/proc/$peer_ancestor/status" 2>/dev/null)
  done
}
child_pids() {
  if [ -r "/proc/$1/task/$1/children" ]; then
    direct_children=''
    IFS= read -r direct_children < "/proc/$1/task/$1/children" || :
    printf '%s\n' "$direct_children"
  else
    # One awk process avoids hundreds of forks on kernels without /children.
    # getline tolerates short-lived /proc entries disappearing during the scan.
    awk -v wanted="$1" 'BEGIN {
      for (i=1; i<ARGC; i++) {
        file=ARGV[i]
        while ((getline line < file) > 0) {
          if (line ~ /^PPid:/) {
            split(line, fields)
            if (fields[2] == wanted) {
              pid=file; sub(/^\/proc\//, "", pid); sub(/\/status$/, "", pid); print pid
            }
            break
          }
        }
        close(file)
      }
      exit
    }' /proc/[0-9]*/status 2>/dev/null
  fi
}
pid_carries_session() {
  carrier_child=$1
  carrier_directory=/proc/$carrier_child
  carrier_executable=$(readlink "$carrier_directory/exe" 2>/dev/null)
  case "$carrier_executable" in */ssh) ;; *) return 1 ;; esac
  carrier_started=$(identity "$carrier_child")
  carrier_links=$(socket_links "$carrier_directory/fd")
  [ -n "$carrier_started" ] && [ "$(identity "$carrier_child")" = "$carrier_started" ] || return 1
  for carrier_link in $carrier_links; do
    case "$carrier_link" in 'socket:['*']') carrier_inode=@@{carrier_link#socket:[}; carrier_inode=@@{carrier_inode%]} ;; *) continue ;; esac
    carrier_records=$(printf '%s\n' "$socket_records" | awk -v i="$carrier_inode" '$2 == i && i != 0 { print $1 " " $3 " " $4 }')
    [ -n "$carrier_records" ] || continue
    if printf '%s\n' "$carrier_records" | awk -v peers="$ssh_peers" 'BEGIN { count=split(peers, p, "\n"); for(i=1;i<=count;i++) known[p[i]]=1 } $0 in known { found=1 } END { exit !found }'; then return 0; fi
  done
  return 1
}
carries_session() {
  for worker_child in $(child_pids "$1"); do
    worker_parent=$(awk '/^PPid:/ { print $2 }' "/proc/$worker_child/status" 2>/dev/null)
    [ "$worker_parent" = "$1" ] || continue
    pid_carries_session "$worker_child" && return 0
  done
  return 1
}
if [ "$use_session" = yes ] && [ -n "$expected_port" ]; then ignore_destination=yes; fi
targets=$(find_targets)
if [ -z "$targets" ]; then
  if [ -n "$expected_port" ] && [ "$use_session" != yes ]; then
    ignore_destination=yes
    alternatives=$(find_targets)
    [ -z "$alternatives" ] || fail '存在相同反向端口但目的地址或 SSH 端口不匹配的隧道，未执行停止'
  fi
  printf 'REVERSE_WORKER_ABSENT\n'; exit 0
fi
if [ "$use_session" = yes ] && [ -n "$expected_port" ]; then
  socket_records=$(awk 'FNR > 1 && $4 == "01" && $10 != 0 { print FILENAME " " $10 " " $2 " " $3 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)
  ssh_peers=$(session_peers)
  [ -n "$ssh_peers" ] || fail '无法读取当前 SSH 会话的 TCP 归属，未停止反向隧道'
  proofs=$(
    while read -r kind pid p h sp account started; do
      alive "$pid" "$started" || continue
      if [ "$kind" = worker ]; then carries_session "$pid" || continue
      else pid_carries_session "$pid" || continue; fi
      printf '%s %s %s %s\n' "$p" "$h" "$sp" "$account"
    done <<__TARGETS__
$targets
__TARGETS__
  )
  [ -n "$proofs" ] || fail '同端口隧道未承载当前 SSH 会话，未停止任何进程'
else
  proofs=$(printf '%s\n' "$targets" | awk '{ print $3 " " $4 " " $5 " " $6 }')
fi
groups=$(printf '%s\n' "$proofs" | awk '!seen[$1 " " $2 " " $3]++ { print $1 " " $2 " " $3 }')
set -f
set -- $groups
set +f
[ "$#" -eq 3 ] || fail '找到多个反向隧道目的地址或转发端口，无法唯一确认；未停止任何进程'
expected_port=$1; expected_host=$2; expected_ssh_port=$3
accounts=$(printf '%s\n' "$proofs" | awk '$4 != "-" && !seen[$4]++ { print $4 }')
set -f
set -- $accounts
set +f
[ "$#" -le 1 ] || fail '当前隧道涉及多个 SSH 账号，未停止任何进程'
[ "$accounts" != '!multiple' ] || fail '持久 worker 涉及多个 SSH 账号，未停止任何进程'
selected_user=@@{1:--}
ignore_destination=no
expected_user=$selected_user
selected=$(printf '%s\n' "$targets" | awk -v p="$expected_port" -v h="$expected_host" -v sp="$expected_ssh_port" -v u="$selected_user" '$3 == p && $4 == h && $5 == sp && ($6 == u || ($1 == "worker" && $6 == "-"))')
[ -n "$selected" ] || fail '隧道进程已发生变化，未执行停止'
protected=' '
ancestor=$$
while [ "$ancestor" -gt 1 ] 2>/dev/null; do
  protected="$protected$ancestor "
  ancestor=$(awk '/^PPid:/ { print $2 }' "/proc/$ancestor/status" 2>/dev/null)
done
frozen=''
resume_workers() {
  for frozen_entry in $frozen; do
    frozen_pid=@@{frozen_entry%:*}; frozen_started=@@{frozen_entry#*:}
    alive "$frozen_pid" "$frozen_started" && kill -CONT "$frozen_pid" 2>/dev/null
  done
  :
}
trap 'resume_workers' 0
trap 'exit 1' HUP INT TERM
worker_records=''
ssh_records=''
while read -r kind pid p h sp account started; do
  [ "$pid" -gt 1 ] || fail '拒绝停止系统进程'
  case "$protected" in *" $pid "*) fail '隧道进程属于当前执行会话的祖先，未执行终止' ;; esac
  alive "$pid" "$started" || fail '隧道进程身份已发生变化，未执行终止'
  if [ "$kind" = worker ]; then
    worker "$pid" || fail 'worker 参数已发生变化，未执行终止'
    frozen="$frozen $pid:$started"
    kill -STOP "$pid" 2>/dev/null || fail '无权暂停 reverse-ssh-worker'
    worker_records="$worker_records $pid:$started"
    for child in $(child_pids "$pid"); do
      parent=$(awk '/^PPid:/ { print $2 }' "/proc/$child/status" 2>/dev/null)
      [ "$parent" = "$pid" ] || continue
      executable=$(readlink "/proc/$child/exe" 2>/dev/null)
      case "$executable" in */ssh) ;; *) continue ;; esac
      child_started=$(identity "$child")
      [ -n "$child_started" ] && ssh_records="$ssh_records $child:$child_started:child"
    done
  else
    forward "$pid" || fail '手动反向 SSH 的参数已发生变化，未执行终止'
    ssh_records="$ssh_records $pid:$started:forward"
  fi
done <<__SELECTED__
$selected
__SELECTED__
# Verify the current carrier again after freezing retry loops.
if [ "$use_session" = yes ]; then
  still_proven=no
  while read -r kind pid p h sp account started; do
    alive "$pid" "$started" || continue
    if [ "$kind" = worker ]; then carries_session "$pid" && still_proven=yes
    else pid_carries_session "$pid" && still_proven=yes; fi
  done <<__SELECTED__
$selected
__SELECTED__
  [ "$still_proven" = yes ] || fail '当前 SSH 会话的隧道归属已变化，未执行终止'
fi
# The worker's TERM trap may itself close the active tunnel. Run the WHOLE
# shutdown transaction independently of that channel, not just the final kills.
printf 'REVERSE_WORKER_STOP_REQUESTED\n'
(
  trap '' HUP INT TERM PIPE
  trap 'resume_workers' 0
  sleep 0.2
  for entry in $worker_records; do
    pid=@@{entry%:*}; started=@@{entry#*:}
    alive "$pid" "$started" && worker "$pid" || fail 'worker 身份已变化，停止中止'
    kill -TERM "$pid" 2>/dev/null || fail '无权停止 reverse-ssh-worker'
  done
  resume_workers
  for entry in $worker_records; do
    pid=@@{entry%:*}; started=@@{entry#*:}
    attempt=0
    while alive "$pid" "$started" && [ "$attempt" -lt 10 ]; do sleep 0.1; attempt=$((attempt + 1)); done
    alive "$pid" "$started" && fail 'reverse-ssh-worker 未响应停止信号；未强制终止'
  done
  frozen=''
  [ -z "$worker_records" ] || printf 'REVERSE_WORKER_PARENT_STOPPED\n'
  # Every selected SSH process is identified independently; duplicate child
  # records are harmless because identity/aliveness is checked before each kill.
  for entry in $ssh_records; do
    kind=@@{entry##*:}; rest=@@{entry%:*}; pid=@@{rest%:*}; started=@@{rest#*:}
    alive "$pid" "$started" || continue
    executable=$(readlink "/proc/$pid/exe" 2>/dev/null)
    case "$executable" in */ssh) ;; *) fail 'SSH 进程身份已变化，停止中止' ;; esac
    if [ "$kind" = forward ]; then
      forward "$pid" || fail '手动反向 SSH 参数已变化，停止中止'
      [ "$candidate_user" = "$selected_user" ] || fail '手动反向 SSH 账号已变化'
    fi
    kill -TERM "$pid" 2>/dev/null || fail '无权停止反向 SSH 客户端'
  done
  attempt=0
  while [ "$attempt" -lt 10 ]; do
    remaining=no
    for entry in $ssh_records; do
      rest=@@{entry%:*}; pid=@@{rest%:*}; started=@@{rest#*:}
      alive "$pid" "$started" && remaining=yes
    done
    [ "$remaining" = no ] && break
    sleep 0.1; attempt=$((attempt + 1))
  done
  [ "$remaining" = no ] || fail '反向 SSH 客户端未响应停止信号'
  sleep 0.3
  replacements=$(find_targets)
  [ -z "$replacements" ] || fail '反向隧道被设备守护服务重新拉起，请停止设备上的对应服务'
  printf 'REVERSE_WORKER_STOPPED\n'
) &
cleanup_pid=$!
# The child owns frozen workers now; a transport HUP must not resume its work.
frozen=''
wait "$cleanup_pid"
`;
  return `sh -c '${script.replaceAll('@@{', '$' + '{').replace('USE_SESSION', tunneled === true ? 'yes' : 'no').replace('EXPECTED_PORT', port === undefined ? "''" : String(port)).replace('EXPECTED_HOST', host === undefined ? "''" : host).replace('EXPECTED_SSH_PORT', sshPort === undefined ? "''" : String(sshPort)).replace(/'/g, "'\\''")}'`;
}

async function stopReverseSshWorker(client, options = {}) {
  return runReverseCleanup(client, buildStopWorkerCommand(options), options);
}
module.exports = { buildStopWorkerCommand, stopReverseSshWorker };
