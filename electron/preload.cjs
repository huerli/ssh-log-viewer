const { contextBridge, ipcRenderer } = require('electron');
const methods = ['settings', 'saveTheme', 'saveLogFont', 'saveProfile', 'loadProfile', 'loadJumpProfile', 'saveJumpProfile', 'connect', 'disconnect', 'list', 'openRemote', 'openLocal', 'chooseLocalFolder', 'listLocal', 'openLocalFile', 'searchLocalFiles', 'page', 'filter', 'clearFilter', 'search', 'cancelSearch', 'download', 'extract', 'cancelTask', 'follow', 'saveBookmarks', 'chooseKey', 'chooseDirectory', 'openExtracted', 'searchFiles', 'searchExtracted', 'batchTransfer'];
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(name, ...args)]));
api.onEvent = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('viewer-event', listener);
  return () => ipcRenderer.removeListener('viewer-event', listener);
};
contextBridge.exposeInMainWorld('viewer', api);
