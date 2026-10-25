// Keep argv boundaries intact: process titles and whitespace-flattened command
// lines cannot distinguish an ssh option from text inside an identity filename.
const reverseSshParserScript = String.raw`
ssh_forward() (
  ssh_forward_awk() {
  LC_ALL=C awk -v byte_input="$1" '
    BEGIN { if (!byte_input) RS = "\0" }
    byte_input {
      for (byte_index = 1; byte_index <= NF; byte_index++) {
        if ($byte_index + 0 == 0) { args[++argc] = argument; argument = "" }
        else argument = argument sprintf("%c", $byte_index)
      }
      next
    }
    { args[++argc] = $0 }
    function port_ok(value) {
      return value ~ /^[0-9]+$/ && value + 0 >= 1 && value + 0 <= 65535
    }
    function forward_ok(value, fields, count, offset) {
      gsub(/\[::1\]/, "localhost", value)
      count = split(value, fields, ":")
      offset = 0
      if (count == 4) {
        if (fields[1] != "localhost" && fields[1] != "127.0.0.1") return 0
        offset = 1
      } else if (count != 3) return 0
      if (!port_ok(fields[1 + offset]) || !port_ok(fields[3 + offset])) return 0
      if (fields[2 + offset] != "localhost" && fields[2 + offset] != "127.0.0.1") return 0
      if (fields[3 + offset] + 0 != 22) return 0
      forward_port = fields[1 + offset] + 0
      return 1
    }
    function option_ok(value, key, setting) {
      sub(/^[ \t]+/, "", value)
      key = value
      sub(/[= \t].*$/, "", key)
      setting = substr(value, length(key) + 1)
      sub(/^[ \t]*=?[ \t]*/, "", setting)
      key = tolower(key)
      if (setting == "") return 0
      if (key == "port") {
        if (!port_ok(setting)) return 0
        # OpenSSH uses the first value supplied for each configuration key.
        if (!port_set) { ssh_port = setting + 0; port_set = 1 }
        return 1
      }
      if (key == "sessiontype") {
        if (tolower(setting) != "none") return 0
        no_session = 1
        return 1
      }
      if (key == "requesttty") return tolower(setting) == "no"
      if (key == "user") {
        if (setting !~ /^[A-Za-z0-9_.-]+$/) return 0
        if (login == "") login = setting
        return 1
      }
      # Forwarding, destination rewrites, master operations and unknown options
      # are deliberately absent; consuming their values would hide semantics.
      return key ~ /^(batchmode|connecttimeout|connectionattempts|stricthostkeychecking|userknownhostsfile|globalknownhostsfile|loglevel|exitonforwardfailure|serveraliveinterval|serveralivecountmax|tcpkeepalive|compression|compressionlevel|identityfile|identitiesonly|identityagent|passwordauthentication|pubkeyauthentication|preferredauthentications|kbdinteractiveauthentication|challengeresponseauthentication|numberofpasswordprompts|hostkeyalgorithms|pubkeyacceptedalgorithms|ciphers|macs|kexalgorithms|addkeystoagent|fingerprinthash|checkhostip|visualhostkey|hashknownhosts|updatehostkeys|verifyhostkeydns|ipqos|rekeylimit|user|forkafterauthentication)$/
    }
    function parse(    i, arg, flags, j, flag, value, destination, pieces, n) {
      if (argc < 2 || args[1] !~ /(^|\/)ssh$/) return 0
      ssh_port = 22
      for (i = 2; i <= argc; i++) {
        arg = args[i]
        if (arg == "" || arg == "--" || arg == "-") return 0
        if (substr(arg, 1, 1) != "-") {
          if (destination != "") return 0
          destination = arg
          n = split(destination, pieces, "@")
          if (n > 2 || (n == 2 && pieces[1] !~ /^[A-Za-z0-9_.-]+$/)) return 0
          if (n == 2 && login == "") login = pieces[1]
          destination = pieces[n]
          if (destination == "") return 0
          continue
        }
        flags = substr(arg, 2)
        for (j = 1; j <= length(flags); j++) {
          flag = substr(flags, j, 1)
          if (flag == "N") { no_session = 1; continue }
          if (index("1246ACfgKknqTvXxYy", flag)) continue
          if (index("RpoiblcEmB", flag)) {
            value = substr(flags, j + 1)
            if (value == "") {
              i++
              if (i > argc) return 0
              value = args[i]
            }
            if (value == "") return 0
            if (flag == "R") {
              if (++forwards != 1 || !forward_ok(value)) return 0
            } else if (flag == "p") {
              if (!port_ok(value)) return 0
              if (!port_set) { ssh_port = value + 0; port_set = 1 }
            } else if (flag == "l") {
              if (value !~ /^[A-Za-z0-9_.-]+$/) return 0
              if (login == "") login = value
            } else if (flag == "o" && !option_ok(value)) return 0
            break
          }
          return 0
        }
      }
      if (!no_session || forwards != 1 || destination == "") return 0
      if (destination == "" || destination ~ /^-/ || destination !~ /^[][A-Za-z0-9_.:-]+$/) return 0
      printf "%d %s %d %s\n", forward_port, destination, ssh_port, login == "" ? "-" : login
      return 1
    }
    END { if (!parse()) exit 1 }
  '
  }
  if LC_ALL=C awk 'BEGIN { exit(length("\0") == 1 ? 0 : 1) }' < /dev/null; then
    ssh_forward_awk 0 < "$1"
  else
    # BusyBox awk truncates NUL strings. Decimal byte records preserve every
    # argv boundary and byte, including whitespace and regex metacharacters.
    LC_ALL=C od -An -v -t u1 < "$1" | ssh_forward_awk 1
  fi
)
`;

module.exports = { reverseSshParserScript };
