const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

async function createTelnetLog(root, target, now = new Date()) {
  const part = value => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`;
  const host = String(target).trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_') || '_';
  const folder = path.join(root, 'telnet', date, host);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const time = `${part(now.getHours())}-${part(now.getMinutes())}-${part(now.getSeconds())}`;
  const file = path.join(folder, `${time}-${randomUUID()}.log`);
  await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
  return file;
}
module.exports = { createTelnetLog };
