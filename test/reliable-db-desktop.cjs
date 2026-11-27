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
    const body = page.getByRole('region', { name: '全程记录内容', exact: true });
    assert.match(await body.innerText(), /TRACK001/);
    assert.match(await body.innerText(), /-30/);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    for (const width of [900, 2244]) {
      await page.setViewportSize({ width, height: 1000 });
      const rows = await body.locator('.reliable-fields > div').evaluateAll(fields => {
        const rows = new Map();
        for (const field of fields) {
          const { top, bottom } = field.getBoundingClientRect();
          const row = rows.get(top) ?? [];
          row.push(bottom);
          rows.set(top, row);
        }
        return [...rows.values()];
      });
      assert.ok(rows.some(row => row.length > 1), `expected multiple fields per row at ${width}px`);
      for (const row of rows) {
        assert.ok(Math.max(...row) - Math.min(...row) < 1, `expected aligned field borders at ${width}px`);
      }
    }
    await page.setViewportSize(viewport);
    await page.getByText('全程记录头', { exact: true }).click();
    await page.getByText('K9', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/reliable-db-content.png' });
    await page.getByRole('button', { name: '关闭记录详情', exact: true }).click();
    assert.equal(await page.locator('.reliable-detail').count(), 0);
    await page.screenshot({ path: path.join(temp, 'reliable-db.png') });
    const extended = Buffer.alloc(256);
    const fixture = await fs.readFile(path.join(__dirname, 'fixtures/reliable-wholercd.bin'));
    fixture.copy(extended);
    extended.writeUInt16LE(124, 6);
    extended[60] = 21;
    extended.writeUInt32LE(1700000000, 112);
    extended.set([4, 5, 1, 112, 0], 127);
    await page.getByLabel('可靠传输 DB 文件', { exact: true }).setInputFiles({ name: 'wholercd', mimeType: 'application/octet-stream', buffer: extended });
    const table = page.locator('.reliable-table');
    assert.deepEqual((await table.getByRole('columnheader').allTextContents()).slice(5, 7), ['事件明细', '转换后的时间（本地）']);
    await table.getByText('操作结果：进入推进', { exact: true }).waitFor();
    await page.getByText('124', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看槽位 0x00' }).click();
    await body.getByText('TAX 箱时间', { exact: true }).waitFor();
    const eventDetail = page.getByRole('region', { name: '事件明细' });
    await eventDetail.getByText('进入推进', { exact: true }).waitFor();
    await eventDetail.getByText('II 端', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭可靠传输查看器' }).click();
    assert.deepEqual(errors, []); console.log('Reliable DB desktop passed');
  } finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
