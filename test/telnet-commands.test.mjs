import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandGroups } from '../shared/telnet-commands.mjs';
test('command groups round-trip and receive collision-free IDs', () => {
  let id = 0;
  const groups = [{ id: 'old', name: '常用', commands: [{ id: 'old', name: '设备信息', text: 'dev-get-info\r\n' }] }];
  const imported = parseCommandGroups(JSON.stringify({ version: 1, groups }), () => String(++id));
  assert.equal(imported[0].name, groups[0].name);
  assert.equal(imported[0].commands[0].text, groups[0].commands[0].text);
  assert.notEqual(imported[0].id, imported[0].commands[0].id);
  assert.throws(() => parseCommandGroups('{', () => 'id'));
  assert.throws(() => parseCommandGroups(JSON.stringify({ groups: [{ name: 'bad', commands: [null] }] }), () => 'id'));
  assert.throws(() => parseCommandGroups('{}', () => 'id'));
});
test('button colors survive import and invalid colors are rejected', () => {
  const data = { groups: [{ name: '状态', commands: [{ name: '查询', text: 'dev-get-info', color: '#16a34a' }] }] };
  assert.equal(parseCommandGroups(JSON.stringify(data), () => 'id')[0].commands[0].color, '#16a34a');
  data.groups[0].commands[0].color = 'invalid';
  assert.throws(() => parseCommandGroups(JSON.stringify(data), () => 'id'), /颜色/);
});
test('variable commands prompt once per name and substitute literally', async () => {
  const { commandVariables, renderCommand } = await import('../shared/telnet-commands.mjs');
  const text = 'system cmd find / -name "{{map文件名}}" -exec md5sum {} \\;';
  assert.deepEqual(commandVariables(text), ['map文件名']);
  assert.equal(renderCommand(text, { 'map文件名': '3585635853.map' }), 'system cmd find / -name "3585635853.map" -exec md5sum {} \\;');
  assert.deepEqual(commandVariables('{{a}} {{ a }}'), ['a']);
  assert.equal(renderCommand('{{a}} {{a}}', {a:'$&'}), '$& $&');
  assert.throws(() => renderCommand(text, {}));
  assert.throws(() => renderCommand(text, {'map文件名':'a\nb'}));
});

test('new button colors use the palette without repeats until exhausted', async () => {
  const { randomCommandColor, commandButtonColors } = await import('../shared/telnet-commands.mjs');
  const used = [];
  for (let i = 0; i < commandButtonColors.length; i++) {
    const color = randomCommandColor(used);
    assert.match(color, /^#[0-9a-f]{6}$/);
    assert.ok(commandButtonColors.includes(color));
    assert.ok(!used.includes(color));
    used.push(color);
  }
  assert.notEqual(randomCommandColor(used), used.at(-1));
  assert.equal(randomCommandColor(commandButtonColors.filter(color => color !== commandButtonColors[0]).map(color => color.toUpperCase())), commandButtonColors[0]);
});
