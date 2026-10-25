const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const macInstallerScript = `#!/bin/sh
set -eu
dmg="$1"
target="$2"
script="$3"
work="$(mktemp -d "\${TMPDIR:-/tmp}/ssh-log-viewer-update.XXXXXX")"
mount="$work/mount"
cleanup() {
  /usr/bin/hdiutil detach "$mount" -force >/dev/null 2>&1 || true
  /bin/rm -rf "$work" "$script"
}
trap cleanup EXIT INT TERM
/bin/sleep 2
/bin/mkdir -p "$mount"
/usr/bin/hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" >/dev/null
source="$(/usr/bin/find "$mount" -maxdepth 2 -name '*.app' -type d -print -quit)"
if [ -z "$source" ]; then
  echo 'DMG 中未找到应用程序' >&2
  exit 1
fi
staged="\${target}.new.$$"
backup="\${target}.backup.$$"
/bin/rm -rf "$staged"
/usr/bin/ditto "$source" "$staged"
/bin/mv "$target" "$backup"
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target" || true
  exit 1
fi
/bin/rm -rf "$backup"
/usr/bin/open -n "$target"
`;

function createInstaller({ platform = process.platform, appPath, openPath, execute = execFile, spawn: spawnProcess = spawn }) {
  return async filename => {
    if (platform === 'darwin' && appPath) {
      if (!path.isAbsolute(filename) || path.extname(filename) !== '.dmg') throw new Error('无效的 macOS 更新安装包路径');
      if (!path.isAbsolute(appPath) || path.extname(appPath) !== '.app') throw new Error('无效的 macOS 应用程序路径');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-log-viewer-mac-update-'));
      const script = path.join(directory, 'install.sh');
      await fs.writeFile(script, macInstallerScript, { mode: 0o700 });
      const child = spawnProcess('/bin/sh', [script, filename, appPath, script], { detached: true, stdio: 'ignore' });
      child.unref?.();
      return '';
    }
    if (platform !== 'linux') return openPath(filename);
    if (!path.isAbsolute(filename) || path.extname(filename) !== '.deb') throw new Error('无效的 Linux 更新安装包路径');
    await new Promise((resolve, reject) => {
      execute('/usr/bin/pkexec', ['--disable-internal-agent', '/usr/bin/apt-get', 'install', '--yes', filename],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } },
        (error, stdout, stderr) => {
          if (!error) return resolve();
          if (error.code === 126) return reject(new Error('已取消系统安装授权，可重试或显示安装包手动安装'));
          if (error.code === 127 || error.code === 'ENOENT') return reject(new Error('无法获取系统安装授权，请确认已安装 polkit 和 APT，或显示安装包手动安装'));
          reject(new Error(`系统安装失败：${String(stderr || stdout || error.message).trim().slice(-2000)}`));
        });
    });
    return '';
  };
}
module.exports = { createInstaller };
