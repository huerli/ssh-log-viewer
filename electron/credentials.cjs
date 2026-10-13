const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class CredentialStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.file = path.join(directory, 'credentials.json');
    this.queue = Promise.resolve();
  }
  async load() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取已保存密码'); }
  }
  async key() {
    const filename = path.join(this.directory, 'credentials.key');
    try { return await fs.readFile(filename); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const key = crypto.randomBytes(32);
      try { await fs.writeFile(filename, key, { flag: 'wx', mode: 0o600 }); return key; }
      catch (error) { if (error.code === 'EEXIST') return fs.readFile(filename); throw error; }
    }
  }
  async encrypt(password) {
    if (this.safeStorage?.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text') {
      return { mode: 'system', ciphertext: this.safeStorage.encryptString(password).toString('base64') };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', await this.key(), iv);
    const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return { mode: 'local', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: data.toString('base64') };
  }
  async get(id) {
    await this.queue;
    const entry = (await this.load())[id];
    if (!entry) return '';
    try {
      if (entry.mode === 'system') return this.safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('已保存密码无法解密，请重新输入并保存'); }
  }
  set(id, password) {
    const work = this.queue.catch(() => {}).then(async () => {
      const entries = await this.load();
      if (password === null) delete entries[id];
      else entries[id] = await this.encrypt(password);
      const temporary = this.file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.queue = work;
    return work;
  }
}
const credentialId = profile => { const identity = [profile.name || profile.host, profile.host, Number(profile.port || 22), profile.username, profile.auth]; if (profile.jump?.enabled) identity.push(profile.jump.host, Number(profile.jump.port || 22), profile.jump.username); return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'); };
module.exports = { CredentialStore, credentialId };
