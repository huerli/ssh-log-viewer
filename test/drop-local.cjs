// Exercise the same native file payload as dragging from a file manager.
async function dropLocal(page, file) {
  await page.getByRole('tab', { name: '日志查看', exact: true }).click();
  const area = page.getByLabel('日志查看区域', { exact: true });
  const box = await area.boundingBox();
  if (!box) throw new Error('日志拖入区域不可见');
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data });
    }
  } finally { await cdp.detach(); }
}
module.exports = { dropLocal };
