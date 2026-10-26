const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createServer } = require('./ssh-fixture.cjs');

async function eventually(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(message);
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-terminal-'));
  let app, ssh, telnet;
  const sockets = new Set(), telnetSessions = [];
  const shellOptions = { shell(shell) {
    shell.channel.write('\x1b[32m欢迎 中文 SSH 终端\x1b[0m\r\n');
    let pending = '';
    shell.channel.on('data', data => {
      const text = data.toString();
      if (text.includes('\x03')) { pending = ''; shell.channel.write('^C\r\n'); }
      pending += text.replace(/\x1b\[[A-Z]/g, '').replace(/\x03/g, '');
      while (pending.includes('\r')) {
        const split = pending.indexOf('\r');
        const command = pending.slice(0, split); pending = pending.slice(split + 1);
        // Only a deterministic echo/response: fixture input is never executed.
        shell.channel.write(command + '\r\n' + (command === 'pwd' ? '/fixture/home\r\n' : 'fixture-response 中文\r\n'));
      }
    });
  } };
  const launch = () => electron.launch({ ...(process.env.VIEWER_TEST_EXECUTABLE ? { executablePath: process.env.VIEWER_TEST_EXECUTABLE, args: [] } : { args: ['.'] }), cwd: path.resolve(__dirname, '..'), env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0', VIEWER_DATA_DIR: path.join(temp, 'config') }, timeout: 30000 });
  try {
    await fs.mkdir(path.join(temp, 'remote/system/log'), { recursive: true });
    await fs.writeFile(path.join(temp, 'remote/system/log/fixture.log'), 'SFTP remains available\n');
    await fs.mkdir(path.join(temp, 'config'));
    await fs.writeFile(path.join(temp, 'config/settings.json'), JSON.stringify({ sshEnabled: true, telnetEnabled: true, autoCheckUpdates: false, directories: { download: path.join(temp, 'downloads'), extract: path.join(temp, 'extracted') } }));
    ssh = await createServer(path.join(temp, 'remote'), shellOptions);
    telnet = net.createServer(socket => {
      sockets.add(socket); const session = { input: '', closed: false }; telnetSessions.push(session);
      socket.on('error', () => {});
      socket.on('close', () => { session.closed = true; sockets.delete(socket); });
      socket.on('data', data => { session.input += data.toString(); socket.write('Telnet fixture response 中文\r\n'); });
      socket.write('Telnet fixture ready\r\n');
    });
    await new Promise(resolve => telnet.listen(0, '127.0.0.1', resolve));
    app = await launch();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showSaveDialog = async (_window, options) => ({ canceled: false, filePath: pathFor(options.title) });
      function pathFor(title) { return directory + (title.includes('SSH') ? '/ssh-export.log' : '/telnet-export.log'); }
    }, temp);
    let page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.locator('.app').waitFor();
    const header = page.locator('.header-actions');
    const mode = async name => {
      await header.getByRole('button', { name: name + ' 输出', exact: true }).click();
      await page.getByLabel(name + ' 输入', { exact: true }).waitFor();
      assert.equal(await header.getByRole('button', { name: name + ' 输出', exact: true }).getAttribute('aria-pressed'), 'true');
    };
    async function editCommand(buttonName, newName, command) {
      await page.getByRole('button', { name: buttonName, exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: '编辑按钮…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑命令按钮', exact: true });
      await dialog.getByLabel('命令名称', { exact: true }).fill(newName);
      await dialog.getByLabel('命令内容', { exact: true }).fill(command);
      await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    async function settingsCard(protocol) {
      await header.getByRole('button', { name: '设置', exact: true }).click();
      return page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: protocol, exact: true }) });
    }
    async function searchOutput(protocol, text, expected = '1 / 1') {
      const input = page.getByLabel('搜索 ' + protocol + ' 输出', { exact: true });
      await input.fill(text); await input.press('Enter');
      await eventually(async () => (await input.locator('..').innerText()).includes(expected), 'xterm search result for ' + text + ' must be ' + expected);
      await input.fill('');
    }

    // Wait for persisted feature settings before inspecting connection controls.
    await header.getByRole('button', { name: 'SSH 输出', exact: true }).waitFor();
    // Establish the existing file connection through its UI, so SSH terminal enablement is real.
    if (!await page.getByRole('region', { name: '连接设置', exact: true }).isVisible()) await page.locator('.connection-actions').getByRole('button', { name: '⚙ 设置', exact: true }).click();
    const connection = page.getByRole('region', { name: '连接设置', exact: true });
    await connection.getByLabel('主机', { exact: true }).fill('127.0.0.1');
    await connection.getByLabel('端口', { exact: true }).fill(String(ssh.port));
    await connection.getByLabel('用户名', { exact: true }).fill('tester');
    await connection.getByLabel('密码', { exact: true }).fill('fixture-password');
    await mode('SSH');
    assert.equal(await page.locator('#telnet-connection-slot .telnet-sidebar').isVisible(), true, 'Telnet connection information must remain visible in SSH mode');
    await page.locator('#telnet-connection-slot').getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await page.getByRole('dialog', { name: 'Telnet 连接设置', exact: true }).waitFor();
    await page.getByRole('dialog', { name: 'Telnet 连接设置', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.connection-pill.connected').waitFor();
    assert.equal(await page.getByRole('button', { name: '设备信息', exact: true }).isVisible(), false);
    await eventually(() => ssh.shells.length === 1 && !!ssh.shells[0].channel, 'SSH shell must open');
    const first = ssh.shells[0];
    await eventually(async () => (await page.getByLabel('SSH 终端状态', { exact: true }).innerText()) === '已连接', 'SSH UI must receive connected event');
    assert.equal(await page.getByRole('button', { name: '打开终端', exact: true }).count(), 0);
    assert.equal(first.pty.term, 'xterm-256color'); assert.ok(first.pty.cols > 0 && first.pty.rows > 0);
    await searchOutput('SSH', '欢迎 中文 SSH 终端');
    await page.getByRole('button', { name: '当前目录', exact: true }).click();
    await eventually(() => first.input === 'pwd\r', 'SSH command button must send raw pwd plus CR without send prefix');
    await page.getByRole('button', { name: '列出文件', exact: true }).click();
    await eventually(() => first.input.endsWith('ls -lah\r'), 'SSH listing button command');
    await page.getByLabel('SSH 输入', { exact: true }).fill('unique-ssh-echo-42');
    await page.getByLabel('SSH 输入', { exact: true }).press('Enter');
    await eventually(() => first.input.includes('unique-ssh-echo-42\r'), 'SSH input must reach remote shell');
    await searchOutput('SSH', 'unique-ssh-echo-42'); // one server echo, no duplicate local echo
    await page.getByLabel('SSH 交互终端', { exact: true }).click();
    await page.keyboard.press('Control+c'); await page.keyboard.press('ArrowUp');
    await eventually(() => first.input.endsWith('\x03\x1b[A'), 'xterm must forward raw Ctrl-C and cursor sequences');
    const beforeResize = first.windows.length;
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1180, 760); });
    await eventually(() => first.windows.length > beforeResize, 'real UI resize must issue SSH window-change');
    assert.ok(first.windows.at(-1).cols > 0 && first.windows.at(-1).rows > 0);

    const sshLog = await page.evaluate(() => window.viewer.sshTerminalRecording('printable', true));
    assert.equal(path.basename(path.dirname(sshLog)), 'tester@127.0.0.1_' + ssh.port);
    assert.ok(path.relative(path.join(temp, 'downloads'), sshLog).startsWith('ssh' + path.sep));
    await eventually(async () => (await fs.readFile(sshLog, 'utf8')).includes('unique-ssh-echo-42'), 'SSH automatic log must contain received data');
    assert.ok(!(await fs.readFile(sshLog, 'utf8')).includes('\x1b['));
    await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, '../artifacts/terminal-ssh.png') });
    let card = await settingsCard('SSH');
    await page.screenshot({ path: path.resolve(__dirname, '../artifacts/terminal-settings.png') });
    await card.getByRole('button', { name: '日志设置…', exact: true }).click();
    const logDialog = page.getByRole('dialog', { name: 'SSH 日志设置', exact: true });
    await logDialog.getByLabel('日志类型').selectOption('all');
    await logDialog.getByRole('button', { name: '应用', exact: true }).click();
    await eventually(async () => (await page.evaluate(() => window.viewer.settings())).sshLogMode === 'all', 'SSH log mode must persist');
    assert.equal((await page.evaluate(() => window.viewer.settings())).telnetLogMode, 'printable');
    first.channel.write('\x1b[31mANSI-log-marker\x1b[0m\r\n');
    await eventually(async () => (await fs.readFile(sshLog, 'utf8')).includes('\x1b[31mANSI-log-marker'), 'all-output mode must retain ANSI');
    await logDialog.getByRole('button', { name: '关闭日志设置', exact: true }).click();
    await card.getByRole('button', { name: '保存输出…', exact: true }).click();
    await eventually(async () => { try { return (await fs.readFile(path.join(temp, 'ssh-export.log'), 'utf8')).includes('ANSI-log-marker'); } catch { return false; } }, 'SSH save output must export the log');
    await page.getByRole('button', { name: '关闭目录设置', exact: true }).click();
    assert.equal(await fs.readFile(path.join(temp, 'ssh-export.log'), 'utf8'), await fs.readFile(sshLog, 'utf8'));
    await editCommand('当前目录', 'SSH 独立按钮', 'printf ssh-custom');
    await page.getByRole('button', { name: 'SSH 独立按钮', exact: true }).click();
    await eventually(() => first.input.endsWith('printf ssh-custom\r'), 'custom SSH button must remain raw SSH');
    console.log('PASS: SSH shell/PTY, Unicode/ANSI, input/button bytes, raw keys, resize, no double echo, logs and export');

    const sidebar = page.locator('#telnet-connection-slot');
    await sidebar.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    const telnetSettings = page.getByRole('dialog', { name: 'Telnet 连接设置', exact: true });
    await telnetSettings.getByLabel('直连名称', { exact: true }).fill('机车1234');
    await telnetSettings.getByLabel('主机', { exact: true }).fill('127.0.0.1');
    await telnetSettings.getByLabel('端口', { exact: true }).fill(String(telnet.address().port));
    await telnetSettings.getByRole('button', { name: '保存', exact: true }).click();
    const directSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('direct-telnet-nodes')));
    assert.equal(directSaved.length, 1);
    await sidebar.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await telnetSettings.getByRole('button', { name: '新增直连', exact: true }).click();
    await telnetSettings.getByLabel('直连名称', { exact: true }).fill('备用设备');
    await telnetSettings.getByLabel('主机', { exact: true }).fill('192.0.2.7');
    await telnetSettings.getByLabel('端口', { exact: true }).fill('2323');
    await telnetSettings.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('direct-telnet-nodes')))).length, 2);
    await sidebar.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    await telnetSettings.getByLabel('直连名称', { exact: true }).fill('备用设备已修改');
    await telnetSettings.getByRole('button', { name: '保存', exact: true }).click();
    await sidebar.getByLabel('Telnet 连接选择', { exact: true }).selectOption(directSaved[0].id);
    await sidebar.getByRole('button', { name: '⚙ 设置', exact: true }).click();
    assert.equal(await telnetSettings.getByLabel('主机', { exact: true }).inputValue(), '127.0.0.1');
    await telnetSettings.getByLabel('直连配置', { exact: true }).selectOption({ label: '备用设备已修改' });
    await telnetSettings.getByRole('button', { name: '删除直连', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('direct-telnet-nodes'))), directSaved);
    await telnetSettings.getByRole('button', { name: '保存', exact: true }).click();

    await sidebar.getByRole('button', { name: '连接', exact: true }).click();
    await eventually(async () => await header.getByRole('button', { name: 'Telnet 输出', exact: true }).getAttribute('aria-pressed') === 'true', 'connecting from SSH must show Telnet output');
    assert.equal(first.closed, false, 'switching to Telnet must preserve SSH shell');
    await header.getByRole('button', { name: 'SSH 输出', exact: true }).click();
    await eventually(async () => (await page.getByLabel('SSH 终端状态', { exact: true }).innerText()) === '已连接', 'returning to SSH must reuse the existing shell');
    await header.getByRole('button', { name: 'Telnet 输出', exact: true }).click();
    assert.equal(ssh.count, 1, 'file connection must remain open');
    assert.ok((await page.evaluate(() => window.viewer.list('/system/log'))).entries.some(item => item.name === 'fixture.log'), 'SFTP must remain usable');
    assert.equal(await page.getByRole('button', { name: 'SSH 独立按钮', exact: true }).isVisible(), false);

    await searchOutput('Telnet', 'Telnet fixture ready');
    assert.equal(telnetSessions[0].input, '', 'connecting must not send unsolicited commands');
    // The fixture responds without echoing input, so displayed commands must come from local echo.
    const telnetInput = page.getByLabel('Telnet 输入', { exact: true });
    await telnetInput.fill('local-echo-enter');
    await telnetInput.press('Enter');
    await eventually(() => telnetSessions[0].input.includes('local-echo-enter\r\n'), 'Enter must transmit a complete Telnet command');
    await searchOutput('Telnet', 'local-echo-enter');
    await sidebar.getByLabel('本地回显', { exact: true }).uncheck();
    await telnetInput.fill('local-echo-disabled');
    await telnetInput.press('Enter');
    await eventually(() => telnetSessions[0].input.includes('local-echo-disabled\r\n'), 'disabling echo must still transmit input');
    await searchOutput('Telnet', 'local-echo-disabled', '没有匹配内容');
    await sidebar.getByLabel('本地回显', { exact: true }).check();
    await telnetInput.fill('local-echo-click');
    await telnetInput.locator('..').getByRole('button', { name: '发送', exact: true }).click();
    await eventually(() => telnetSessions[0].input.includes('local-echo-click\r\n'), 'Send must transmit a complete Telnet command');
    await searchOutput('Telnet', 'local-echo-click');

    await page.getByRole('button', { name: '设备信息', exact: true }).click();
    await eventually(() => telnetSessions[0].input.includes('dev-get-info\r\n'), 'Telnet button must still send its own command');
    await editCommand('设备信息', 'Telnet 独立按钮', 'dev-custom');
    const saved = await page.evaluate(() => ({ ssh: JSON.parse(localStorage.getItem('ssh-command-groups')), telnet: JSON.parse(localStorage.getItem('telnet-command-groups')) }));
    assert.equal(saved.ssh[0].commands[0].name, 'SSH 独立按钮');
    assert.equal(saved.telnet[0].commands[0].name, 'Telnet 独立按钮');
    card = await settingsCard('Telnet');
    await card.getByRole('button', { name: '保存输出…', exact: true }).click();
    await eventually(async () => { try { return (await fs.readFile(path.join(temp, 'telnet-export.log'), 'utf8')).includes('Telnet fixture ready'); } catch { return false; } }, 'Telnet save output must export its independent log');
    await page.getByRole('button', { name: '关闭目录设置', exact: true }).click();
    await mode('SSH');
    assert.equal(telnetSessions[0].closed, false, 'leaving Telnet for SSH must keep its socket open');
    const telnetLog = await page.evaluate(() => window.viewer.telnetRecording('printable', true));
    assert.equal(path.basename(path.dirname(telnetLog)), '机车1234--127.0.0.1_' + telnet.address().port);
    [...sockets][0].write('background-telnet-marker 中文\r\n');
    await eventually(async () => (await fs.readFile(telnetLog, 'utf8')).includes('background-telnet-marker'), 'background Telnet output must still be recorded');
    assert.equal(await header.getByRole('button', { name: 'SSH 输出', exact: true }).getAttribute('aria-pressed'), 'true', 'background output must not change the visible page');
    await eventually(() => ssh.shells.length === 2 && !!ssh.shells[1].channel, 'switching back must automatically reuse the authenticated SSH connection');
    assert.equal(await page.getByRole('button', { name: 'Telnet 独立按钮', exact: true }).isVisible(), false);

    const nextLog = await page.evaluate(() => window.viewer.sshTerminalRecording('all', true));
    assert.notEqual(nextLog, sshLog, 'every shell must receive a unique log');
    await page.evaluate(() => window.viewer.sshTerminalClose());
    await eventually(() => ssh.shells[1].closed, 'explicit shell close');

    // Delay server shell acceptance to exercise a real in-flight SSH callback after mode change.
    shellOptions.holdShell = true;
    await page.getByRole('button', { name: '重试终端', exact: true }).click();
    await eventually(() => ssh.shells.length === 3, 'pending shell request must reach server');
    await mode('Telnet');
    shellOptions.holdShell = false;
    ssh.releaseShells();
    await eventually(() => ssh.shells[2].closed, 'late shell callback must dispose cancelled shell');
    assert.equal(ssh.count, 1);
    assert.equal(telnetSessions.length, 1, 'returning must reuse the original Telnet connection');
    assert.equal(telnetSessions[0].closed, false);
    await searchOutput('Telnet', 'background-telnet-marker');
    await page.getByRole('button', { name: 'Telnet 独立按钮', exact: true }).click();
    await eventually(() => telnetSessions[0].input.endsWith('dev-custom\r\n'), 'Telnet must remain ready to send after returning');
    await mode('SSH');
    await eventually(() => ssh.shells.length === 4 && !!ssh.shells[3].channel, 'SSH must reopen after cancelled attempt');
    await page.locator('.connection-actions').getByRole('button', { name: '断开', exact: true }).click();
    await eventually(() => ssh.shells[3].closed && ssh.count === 0, 'upper disconnect must close SSH shell and file connection');
    assert.equal(await page.locator('[data-protocol=ssh]').getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
    await page.locator('.connection-actions').getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.connection-pill.connected').waitFor();
    await eventually(() => ssh.shells.length === 5 && !!ssh.shells[4].channel, 'upper reconnect must reopen SSH terminal automatically');
    await mode('Telnet');
    assert.ok((await page.evaluate(() => window.viewer.list('/system/log'))).entries.some(item => item.name === 'fixture.log'));
    await header.getByRole('button', { name: '日志查看', exact: true }).click();
    await page.locator('.file-entry').filter({ hasText: 'fixture.log' }).dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll('.line-content')].some(line => line.textContent.includes('SFTP remains available')));
    await page.getByPlaceholder('搜索全文关键词或正则表达式…').fill('SFTP remains');
    await page.getByRole('button', { name: '搜索全文', exact: true }).click();
    await page.locator('.search-results .result').filter({ hasText: 'SFTP remains available' }).waitFor();
    assert.equal(telnetSessions[0].closed, false, 'opening a local log must also preserve Telnet');
    [...sockets][0].write('telnet-while-viewing-log\r\n');
    await eventually(async () => (await fs.readFile(telnetLog, 'utf8')).includes('telnet-while-viewing-log'), 'logging continues while viewing logs');
    assert.equal(await header.getByRole('button', { name: '日志查看', exact: true }).getAttribute('class'), 'primary');
    await sidebar.getByRole('button', { name: '断开', exact: true }).click();
    await eventually(() => telnetSessions[0].closed, 'explicit Telnet disconnect must still close the socket');
    assert.deepEqual(errors, []);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.locator('.app').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('direct-telnet-nodes'))), directSaved);
    assert.equal(await page.getByLabel('Telnet 连接选择', { exact: true }).inputValue(), directSaved[0].id);
    await page.getByRole('button', { name: 'Telnet 独立按钮', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'SSH 独立按钮', exact: true }).isVisible(), false);
    await page.locator('.header-actions').getByRole('button', { name: 'SSH 输出', exact: true }).click();
    await page.getByRole('button', { name: 'SSH 独立按钮', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Telnet 独立按钮', exact: true }).isVisible(), false);
    assert.equal((await page.evaluate(() => window.viewer.settings())).sshLogMode, 'all');
    assert.equal((await page.evaluate(() => window.viewer.settings())).telnetLogMode, 'printable');
    console.log('PASS: exclusive display, persistent Telnet/background logging/explicit disconnect, retained SFTP, Telnet loopback/export, upper connection reuse/automatic shell, unique logs, pending-shell cancellation and independent configuration after restart');
  } catch (error) {
    if (app) await app.firstWindow().then(page => page.screenshot({ path: path.join(os.tmpdir(), 'viewer-terminal-failure.png') })).catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    if (ssh) await ssh.close();
    for (const socket of sockets) socket.destroy();
    if (telnet) await new Promise(resolve => telnet.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
