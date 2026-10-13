import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sessionModule from '../electron/ssh-session.cjs';
import targetFixture from './ssh-fixture.cjs';
import jumpFixture from './jump-fixture.cjs';
const { connectSession } = sessionModule;
const { createServer } = targetFixture;
const { createJump, reverseTunnel } = jumpFixture;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = (targetPort, jumpPort) => ({ host: '127.0.0.1', port: targetPort, username: 'tester', auth: 'password', password: 'fixture-password', jump: { enabled: true, host: '127.0.0.1', port: jumpPort, username: 'jumper', auth: 'password', password: 'jump-password' } });

test('SSH hopping and real reverse tunnel reach target SFTP and close owned connections', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'viewer-hop-')); let target, jump, reverse, session;
  try {
    await mkdir(path.join(temp, 'system/log'), { recursive: true }); await writeFile(path.join(temp, 'system/log/target.log'), 'target only');
    target = await createServer(temp); jump = await createJump([target.port]);
    const verified = []; const options = () => ({ signal: new AbortController().signal, verify: (identity, role, hash, callback) => { verified.push({ identity, role, hash }); callback(true); } });
    session = await connectSession(profile(target.port, jump.port), options());
    const list = await new Promise((resolve, reject) => session.sftp.readdir('/system/log', (error, entries) => error ? reject(error) : resolve(entries)));
    assert.equal(list[0].filename, 'target.log'); assert.equal(verified[0].role, '跳板机'); assert.equal(verified[1].role, '目标机器');
    assert.notEqual(verified[0].hash, verified[1].hash); assert.ok(verified[1].identity.includes(`jumper@127.0.0.1:${jump.port}`));
    session.close(); session = null; await pause(100); assert.equal(jump.count, 0);
    const keyPath = path.join(temp, 'jump-key'); await writeFile(keyPath, jump.privateKey);
    const keyProfile = profile(target.port, jump.port); keyProfile.jump = { ...keyProfile.jump, auth: 'key', keyPath, password: undefined };
    session = await connectSession(keyProfile, options());
    assert.equal(await new Promise((resolve, reject) => session.sftp.realpath('/system/log', (error, value) => error ? reject(error) : resolve(value))), '/system/log');
    session.close(); session = null; await pause(100); assert.equal(jump.count, 0);
    reverse = await reverseTunnel(jump, target.port);
    session = await connectSession(profile(reverse.port, jump.port), options());
    assert.equal(await new Promise((resolve, reject) => session.sftp.realpath('/system/log', (error, value) => error ? reject(error) : resolve(value))), '/system/log');
    assert.equal(jump.requests.at(-1).destPort, reverse.port);
    session.close(); session = null; await pause(100); assert.equal(jump.count, 1);
    await assert.rejects(connectSession({ ...profile(reverse.port, jump.port), password: 'wrong' }, options()), /目标机器(?:连接|认证)失败/);
    await pause(100); assert.equal(jump.count, 1);
    await assert.rejects(connectSession(profile(reverse.port, jump.port), { ...options(), verify: (id, role, hash, callback) => callback(role !== '目标机器') }), /目标机器(?:连接|认证)失败/);
    await pause(100); assert.equal(jump.count, 1);
    await assert.rejects(connectSession(profile(1, jump.port), options()), /跳板机转发失败/);
    const controller = new AbortController(); const work = connectSession(profile(reverse.port, jump.port), { ...options(), signal: controller.signal }); controller.abort(); await assert.rejects(work);
    await pause(100); assert.equal(jump.count, 1);
  } finally { session?.close(); reverse?.close(); if (jump) await jump.close(); if (target) await target.close(); await rm(temp, { recursive: true, force: true }); }
});


test('keyboard-interactive password login works without sending passwords as OTP answers', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'viewer-keyboard-')); let target, jump, otp, session;
  try {
    await mkdir(path.join(temp, 'system/log'), { recursive: true });
    target = await createServer(temp); jump = await createJump([target.port], { keyboardOnly: true });
    const options = () => ({ signal: new AbortController().signal, verify: (id, role, hash, callback) => callback(true) });
    session = await connectSession(profile(target.port, jump.port), options());
    assert.deepEqual(jump.answers, [['jump-password']]); session.close(); session = null;
    otp = await createJump([target.port], { keyboardOnly: true, prompt: 'Verification code: ' });
    await assert.rejects(connectSession(profile(target.port, otp.port), options()), /额外交互认证或验证码/);
    assert.ok(otp.answers.every(answers => !answers.includes('jump-password')));
    await assert.rejects(connectSession({ ...profile(target.port, jump.port), jump: { ...profile(target.port, jump.port).jump, password: '' } }, options()), /跳板机未填写密码/);
  } finally { session?.close(); if (otp) await otp.close(); if (jump) await jump.close(); if (target) await target.close(); await rm(temp, { recursive: true, force: true }); }
});
