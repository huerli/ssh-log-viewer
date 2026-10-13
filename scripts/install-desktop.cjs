const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform === 'linux') {
  const root = path.resolve(__dirname, '..');
  const applications = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications');
  // Desktop Entry escaping differs from shell quoting; Exec also treats % as field codes.
  const value = text => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const argument = text => '"' + value(text.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')) + '"';
  const content = `[Desktop Entry]
Type=Application
Name=SSH Log Viewer
Comment=SSH remote and local log viewer
Exec=${argument(path.join(root, 'start.sh'))}
Icon=${value(path.join(root, 'assets/icon.png'))}
Terminal=false
Categories=Development;
StartupWMClass=com.teee.sshlogviewer
StartupNotify=true
`;
  fs.mkdirSync(applications, { recursive: true });
  const destination = path.join(applications, 'com.teee.sshlogviewer.desktop');
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) fs.writeFileSync(destination, content, { mode: 0o644 });
}
