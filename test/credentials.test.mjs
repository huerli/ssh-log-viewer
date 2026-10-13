import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import credentials from '../electron/credentials.cjs';
const { CredentialStore, credentialId } = credentials;

test('password survives restart encrypted, isolated by profile, removable, and detects tampering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-credentials-'));
  try {
    const basic = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw Error('must not use basic_text'); } };
    const store = new CredentialStore(dir, basic);
    const profile = { name: 'first', host: 'localhost', username: 'tester', port: 22, auth: 'password' };
    const id = credentialId(profile), second = credentialId({ ...profile, name: 'second' });
    assert.notEqual(id, second);
    assert.notEqual(id, credentialId({ ...profile, jump: { enabled: true, host: 'jump', port: 22, username: 'hop' } }));
    assert.notEqual(credentialId({ ...profile, jump: { enabled: true, host: 'jumpA', port: 22, username: 'hop' } }), credentialId({ ...profile, jump: { enabled: true, host: 'jumpB', port: 22, username: 'hop' } }));
    await Promise.all([store.set(id, '秘密-fixture-password'), store.set(second, 'other-password')]);
    const content = await readFile(store.file, 'utf8');
    assert.ok(!content.includes('fixture-password')); assert.ok(!content.includes('other-password'));
    assert.equal(JSON.parse(content)[id].mode, 'local');
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, 'credentials.key'))).mode & 0o777, 0o600);
    const reopened = new CredentialStore(dir, basic);
    assert.equal(await reopened.get(id), '秘密-fixture-password');
    await reopened.set(second, null);
    assert.equal(await reopened.get(second), ''); assert.equal(await reopened.get(id), '秘密-fixture-password');
    const entries = JSON.parse(await readFile(store.file, 'utf8'));
    entries[id].tag = Buffer.alloc(16).toString('base64');
    await writeFile(store.file, JSON.stringify(entries));
    await assert.rejects(reopened.get(id), /无法解密/);
    await reopened.set(id, 'replacement'); assert.equal(await reopened.get(id), 'replacement');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
