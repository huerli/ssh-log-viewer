const path = require('node:path');
const { execFile } = require('node:child_process');

function createInstaller({ platform = process.platform, openPath, execute = execFile }) {
  return async filename => {
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
