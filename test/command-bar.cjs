const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-command-bar-'));
  const artifacts = path.resolve(__dirname, '../artifacts');
  let app, page;
  const errors = [];
  const launch = async () => {
    app = await electron.launch({
      ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }),
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0', VIEWER_DATA_DIR: path.join(temp, 'config') },
      timeout: 30000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.app').waitFor();
  };
  const mode = async protocol => {
    await page.locator('.header-actions').getByRole('button', { name: protocol + ' 输出', exact: true }).click();
    await page.getByLabel(protocol + ' 输入', { exact: true }).waitFor();
  };
  const groups = protocol => page.evaluate(key => JSON.parse(localStorage.getItem(key)), protocol + '-command-groups');
  const toolbar = () => page.locator('.command-button-bar:visible');
  const selectedGroup = () => toolbar().getByLabel('按钮组', { exact: true });
  const command = name => toolbar().getByRole('button', { name, exact: true });
  async function openToolbarMenu(selector = '.command-buttons') {
    // Locate actual whitespace, so bubbling from a command cannot accidentally satisfy this test.
    const surface = selector === '.command-button-bar' ? toolbar() : toolbar().locator(selector);
    const point = await surface.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (let x = rect.right - 3; x > rect.left; x -= 4) {
        for (let y = rect.top + 2; y < rect.bottom; y += 4) {
          if (document.elementFromPoint(x, y) === element) return { x, y };
        }
      }
      throw new Error('No toolbar whitespace found');
    });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: '按钮栏操作', exact: true });
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['新增按钮…', '导入配置…', '调整分组…']);
    assert.equal(await page.getByRole('dialog', { name: '按钮栏配置', exact: true }).count(), 0, 'whitespace context menu must not open full configuration');
    return menu;
  }
  async function addCommand(name, text, screenshot = false) {
    const menu = await openToolbarMenu();
    await menu.getByRole('menuitem', { name: '新增按钮…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增命令按钮', exact: true });
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog', { name: '按钮栏配置', exact: true }).count(), 0);
    const color = await dialog.getByLabel('命令按钮颜色', { exact: true }).inputValue();
    assert.match(color, /^#[0-9a-f]{6}$/i, 'new buttons must start with a real color');
    await dialog.getByLabel('命令名称', { exact: true }).fill(name);
    await dialog.getByLabel('命令内容', { exact: true }).fill(text);
    if (screenshot) await page.screenshot({ path: path.join(artifacts, 'command-bar-add.png') });
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await command(name).waitFor();
    assert.equal(await command(name).evaluate((element, hex) => {
      const probe = document.createElement('span');
      probe.style.color = hex;
      return element.style.backgroundColor === probe.style.color;
    }, color), true, 'visible button must use the saved color');
    return color;
  }
  async function groupManager() {
    const menu = await openToolbarMenu();
    await menu.getByRole('menuitem', { name: '调整分组…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '调整分组', exact: true });
    await dialog.waitFor();
    return dialog;
  }
  try {
    await fs.mkdir(path.join(temp, 'config'), { recursive: true });
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(temp, 'config/settings.json'), JSON.stringify({ autoCheckUpdates: false, sshEnabled: true, telnetEnabled: true }));
    await launch();
    const seed = {
      telnet: [
        { id: 'manual', name: '保留手动颜色', commands: [{ id: 'original', name: '原有按钮', text: 'echo original', color: '#123456' }] },
        { id: 'second', name: '第二分组', commands: [] },
      ],
      ssh: [{ id: 'ssh-manual', name: 'SSH 保留分组', commands: [{ id: 'ssh-original', name: 'SSH 原有按钮', text: 'pwd', color: '#654321' }] }],
    };
    await page.evaluate(value => {
      for (const [protocol, data] of Object.entries(value)) localStorage.setItem(protocol + '-command-groups', JSON.stringify(data));
    }, seed);
    await page.reload();
    await mode('Telnet');
    const menu = await openToolbarMenu('.command-button-bar');
    await page.screenshot({ path: path.join(artifacts, 'command-bar-menu.png') });
    await menu.getByRole('menuitem', { name: '新增按钮…', exact: true }).click();
    const cancelled = page.getByRole('dialog', { name: '新增命令按钮', exact: true });
    await cancelled.getByLabel('命令名称', { exact: true }).fill('不会保存');
    await cancelled.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await groups('telnet'), seed.telnet, 'cancelling must not mutate commands');

    const firstColor = await addCommand('随机按钮一', 'echo one', true);
    const secondColor = await addCommand('随机按钮二', 'echo two');
    assert.notEqual(firstColor, secondColor, 'random palette should avoid already used colors');
    assert.notEqual(firstColor.toLowerCase(), '#123456');
    assert.notEqual(secondColor.toLowerCase(), '#123456');
    let saved = await groups('telnet');
    assert.deepEqual(saved[0].commands[0], seed.telnet[0].commands[0], 'adding buttons must preserve manual colors');
    assert.equal(saved[0].commands[1].color, firstColor);
    assert.equal(saved[0].commands[2].color, secondColor);

    // Individual command editing retains its existing full editor and selected color.
    await command('随机按钮一').click({ button: 'right' });
    const buttonMenu = page.getByRole('menu', { name: '命令按钮操作', exact: true });
    assert.equal(await page.getByRole('menu', { name: '按钮栏操作', exact: true }).count(), 0);
    await buttonMenu.getByRole('menuitem', { name: '编辑按钮…', exact: true }).click();
    const full = page.getByRole('dialog', { name: '按钮栏配置', exact: true });
    assert.equal(await full.getByLabel('命令按钮颜色', { exact: true }).inputValue(), firstColor);
    await full.getByLabel('命令名称', { exact: true }).fill('随机按钮一已编辑');
    await full.getByRole('button', { name: '保存修改', exact: true }).click();
    await full.getByRole('button', { name: '关闭按钮栏配置', exact: true }).click();
    await command('随机按钮一已编辑').waitFor();

    await selectedGroup().selectOption('__add__');
    const newGroup = page.getByRole('dialog', { name: '新增按钮组', exact: true });
    await newGroup.getByLabel('新分组名称', { exact: true }).fill('新建分组');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(artifacts, 'command-bar-new-group.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'midnight'; });
    await newGroup.getByRole('button', { name: '确认', exact: true }).click();
    await newGroup.waitFor({ state: 'hidden' });
    let manager = await groupManager();
    saved = await groups('telnet');
    const addedId = saved.find(group => group.name === '新建分组').id;
    const row = manager.locator('.command-group-row').filter({ has: page.getByLabel('分组名称：新建分组', { exact: true }) });
    await row.getByLabel('分组名称：新建分组', { exact: true }).fill('重命名分组');
    await row.getByRole('button', { name: '保存名称', exact: true }).click();
    assert.equal((await groups('telnet')).find(group => group.id === addedId).name, '重命名分组');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(artifacts, 'command-bar-groups.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'midnight'; });
    await manager.getByRole('button', { name: '关闭分组调整', exact: true }).click();
    await selectedGroup().selectOption(addedId);
    manager = await groupManager();
    await manager.getByRole('button', { name: '上移分组重命名分组', exact: true }).click();
    assert.deepEqual((await groups('telnet')).map(group => group.id), ['manual', addedId, 'second']);
    await manager.getByRole('button', { name: '下移分组重命名分组', exact: true }).click();
    assert.deepEqual((await groups('telnet')).map(group => group.id), ['manual', 'second', addedId]);
    await manager.getByRole('button', { name: '关闭分组调整', exact: true }).click();
    assert.equal(await selectedGroup().inputValue(), addedId, 'reordering must retain selected group identity');
    const groupColor = await addCommand('分组内按钮', 'echo grouped');
    saved = await groups('telnet');
    assert.equal(saved.find(group => group.id === addedId).commands[0].color, groupColor);
    assert.ok(![firstColor, secondColor].includes(groupColor), 'palette must avoid colors in other groups too');
    manager = await groupManager();
    await manager.getByRole('button', { name: '删除分组第二分组', exact: true }).click();
    assert.deepEqual((await groups('telnet')).map(group => group.id), ['manual', addedId]);
    await manager.getByRole('button', { name: '关闭分组调整', exact: true }).click();
    assert.equal(await selectedGroup().inputValue(), addedId);
    const finalTelnet = await groups('telnet');

    await mode('SSH');
    assert.deepEqual(await groups('ssh'), seed.ssh);
    const sshColor = await addCommand('SSH 新增按钮', 'echo ssh');
    const finalSsh = await groups('ssh');
    assert.deepEqual(finalSsh[0].commands[0], seed.ssh[0].commands[0]);
    assert.equal(finalSsh[0].commands[1].color, sshColor);
    assert.deepEqual(await groups('telnet'), finalTelnet, 'SSH changes must not affect Telnet');
    await app.close(); app = undefined;
    await launch();
    assert.deepEqual(await groups('telnet'), finalTelnet, 'Telnet colors, groups and order must survive restart');
    assert.deepEqual(await groups('ssh'), finalSsh, 'SSH colors must survive restart');
    await mode('Telnet');
    await selectedGroup().selectOption('manual');
    await command('随机按钮一已编辑').waitFor();
    await selectedGroup().selectOption(addedId);
    await command('分组内按钮').waitFor();
    await mode('SSH');
    await command('SSH 新增按钮').waitFor();
    assert.equal(await command('分组内按钮').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: compact toolbar menu/add/cancel, distinct persistent colors, preserved manual colors, group add/rename/reorder/delete, selected group identity, per-button editor, SSH/Telnet isolation and restart');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(artifacts, 'command-bar-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
