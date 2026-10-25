import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UpdateState } from './types';

const api = window.viewer;
const busyStates = ['checking', 'downloading', 'installing'];
const bytes = (value = 0) => value < 1024 ** 2 ? `${(value / 1024).toFixed(0)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
function summary(update: UpdateState) {
  switch (update.status) {
    case 'checking': return '正在检查新版本…';
    case 'up-to-date': return '当前已是最新版本';
    case 'available': return `发现新版本 v${update.latestVersion}`;
    case 'downloading': return `正在下载更新 · ${Math.floor(update.progress || 0)}%`;
    case 'ready': return '更新已下载并通过校验';
    case 'installing': return update.platform === 'linux' ? '正在安装更新，请完成系统授权；安装成功后退出…' : update.platform === 'darwin' ? '正在替换应用并重启…' : '正在打开安装程序…';
    case 'error': return '更新操作失败，可重试';
    default: return '尚未检查更新';
  }
}
export function UpdateControl({ settingsOpen }: { settingsOpen: boolean }) {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [settingsSlot, setSettingsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    void api.updateState().then(value => { if (active) setUpdate(value); }).catch(reason => { if (active) setError(String(reason)); });
    const unsubscribe = api.onEvent(event => { if (event.type === 'update-state' && event.update) setUpdate(event.update); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => { setSettingsSlot(settingsOpen ? document.getElementById('update-settings-slot') : null); }, [settingsOpen]);
  async function run(action: () => Promise<UpdateState | void>) {
    setError('');
    try { const value = await action(); if (value) setUpdate(value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function show() {
    setOpen(true);
    if (!update || ['idle', 'up-to-date', 'error'].includes(update.status)) void run(() => api.checkForUpdates());
  }
  const hasInstaller = Boolean(update?.installerPath && ['ready', 'error'].includes(update.status));
  const busy = Boolean(update && busyStates.includes(update.status));
  const autoCheck = <label className="update-auto-check"><input aria-label="自动检查更新" type="checkbox" checked={update?.autoCheck ?? true} disabled={!update || saving} onChange={event => {
    const enabled = event.target.checked; setSaving(true);
    void run(() => api.saveUpdatePreferences(enabled)).finally(() => setSaving(false));
  }} />启动时及每 6 小时自动检查</label>;
  return <>
    {settingsSlot && createPortal(<><p className="update-card-status">当前版本 v{update?.currentVersion || __APP_VERSION__} · {update ? summary(update) : '读取中…'}</p>{autoCheck}<button onClick={show}>检查更新…</button></>, settingsSlot)}
    {open && <div className="settings-backdrop" style={{ zIndex: 130 }} onClick={() => setOpen(false)}><section className="directory-settings update-dialog" role="dialog" aria-modal="true" aria-label="软件更新" onClick={event => event.stopPropagation()}>
      <div className="panel-title"><strong>软件更新</strong><button aria-label="关闭软件更新" onClick={() => setOpen(false)}>×</button></div>
      <div className="update-version">当前版本 <strong>v{update?.currentVersion || __APP_VERSION__}</strong>{update?.latestVersion && <><span>→</span>最新版本 <strong>v{update.latestVersion}</strong></>}</div>
      <p className="update-status" role="status">{update ? summary(update) : '正在读取更新状态…'}</p>
      {update?.publishedAt && <small className="hint">发布时间：{new Date(update.publishedAt).toLocaleString()}</small>}
      {(error || update?.error) && <p className="settings-error" role="alert">{error || update?.error}</p>}
      {update?.status === 'downloading' && <div className="update-download-progress"><progress aria-label="更新下载进度" max={100} value={update.progress || 0} /><small>{bytes(update.downloadedBytes)} / {bytes(update.size)}</small></div>}
      {update?.notes && <section className="update-release-notes"><strong>更新说明</strong><pre>{update.notes}</pre></section>}
      {update?.isPackaged === false && <p className="hint update-source-hint">当前为源码运行：安装发行版不会覆盖此工作区，安装后请从应用菜单启动新版本。</p>}
      {hasInstaller && <p className="hint">Linux 需完成系统管理员授权，安装成功后退出；macOS 会后台挂载 DMG、替换应用并重新启动，应用目录权限不足时可能需要系统授权；Windows 打开安装向导。退出会断开 SSH / Telnet；跳板机 localhost 端口按断开规则释放。</p>}
      {autoCheck}
      <div className="inline update-actions">
        <button disabled={busy || update?.status === 'ready'} onClick={() => void run(() => api.checkForUpdates())}>检查更新</button>
        {update?.supported && ['available', 'error'].includes(update.status) && <button className="primary" onClick={() => void run(() => api.downloadUpdate())}>下载更新</button>}
        {update?.status === 'downloading' && <button onClick={() => void run(() => api.cancelUpdate())}>取消下载</button>}
        {hasInstaller && <><button className="primary" onClick={() => void run(() => api.installUpdate())}>退出并安装</button><button onClick={() => void run(() => api.revealUpdateInstaller())}>显示安装包</button></>}
        <button disabled={update?.status === 'installing'} onClick={() => void run(() => api.openUpdateRelease())}>查看发布说明</button>
      </div>
      {update?.checkedAt && <small className="hint">上次检查：{new Date(update.checkedAt).toLocaleString()}</small>}
    </section></div>}
  </>;
}
