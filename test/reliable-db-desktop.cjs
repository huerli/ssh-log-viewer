const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-reliable-')); let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, VIEWER_DATA_DIR: temp } });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: '可靠传输 DB', exact: true }).click();
    const bytes = Buffer.alloc(256, 255); bytes.writeUInt32LE(123, 0); bytes[4] = 254; bytes.writeUInt16LE(19, 6); bytes[8] = 2; bytes[9] = 0;
    bytes.writeUInt32LE(456, 12); bytes.writeUInt32LE(789, 16); bytes.writeUInt32LE(123456, 20); bytes.set([0x12, 0x34, 0x56], 24);
    await page.getByLabel('可靠传输 DB 文件', { exact: true }).setInputFiles({ name: 'wholercd', mimeType: 'application/octet-stream', buffer: bytes });
    await page.waitForFunction(() => document.querySelector('.reliable-db [role=status]')?.textContent.includes('待确认 1'));
    assert.equal(await page.getByLabel('DB 槽位大小').inputValue(), '256');
    assert.match(await page.locator('.reliable-table').innerText(), /全程记录/);
    await page.getByRole('button', { name: '查看槽位 0x00' }).click();
    assert.match(await page.locator('.reliable-detail').innerText(), /12 34 56/);
    await page.getByLabel('DB 状态筛选').selectOption('ok'); assert.equal(await page.locator('.reliable-table tbody tr').count(), 0);
    await page.getByLabel('DB 状态筛选').selectOption('pending'); assert.equal(await page.locator('.reliable-table tbody tr').count(), 1);
    await page.getByLabel('搜索 DB 记录').fill('456'); assert.equal(await page.locator('.reliable-table tbody tr').count(), 1);
    await page.getByLabel('可靠传输 DB 文件', { exact: true }).setInputFiles({ name: 'wholercd', mimeType: 'application/octet-stream', buffer: await fs.readFile(path.join(__dirname, 'fixtures/reliable-wholercd.bin')) });
    await page.locator('.reliable-table tbody tr').first().click();
    await page.getByRole('heading', { name: '实际记录内容' }).waitFor();
    assert.match(await page.locator('.reliable-fields').innerText(), /K9/);
    assert.match(await page.locator('.reliable-fields').innerText(), /TRACK001/);
    assert.match(await page.locator('.reliable-fields').innerText(), /-30/);
    await page.screenshot({ path: '/tmp/reliable-db-content.png' });
    await page.getByRole('button', { name: '关闭记录详情', exact: true }).click();
    assert.equal(await page.locator('.reliable-detail').count(), 0);
    await page.screenshot({ path: path.join(temp, 'reliable-db.png') });
    await page.getByRole('button', { name: '关闭可靠传输查看器' }).click();
    assert.deepEqual(errors, []); console.log('Reliable DB desktop passed');
  } finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
