const { contextBridge, ipcRenderer, webUtils } = require('electron');
const methods = ['sessionInvoke', 'sessionClose', 'updateState', 'checkForUpdates', 'downloadUpdate', 'cancelUpdate', 'installUpdate', 'openUpdateRelease', 'revealUpdateInstaller', 'saveUpdatePreferences', 'terminalMode', 'sshTerminalOpen', 'sshTerminalWrite', 'sshTerminalResize', 'sshTerminalClose', 'sshTerminalRecording', 'sshTerminalSaveOutput', 'importServerAsJump', 'webTelnetSearchDevices', 'webTelnetPassword', 'webTelnetLogin', 'webTelnetConnect', 'telnetRecording', 'telnetSaveOutput', 'telnetConnect', 'telnetWrite', 'telnetClose', 'downloadedFiles', 'settings', 'saveFeatureEnabled', 'saveTheme', 'saveSearchHistory', 'copyText', 'exportSearchResults', 'exportJsonConfig', 'openFolder', 'saveLogFont', 'deleteProfile', 'deleteJumpProfile', 'saveProfile', 'loadProfile', 'loadJumpProfile', 'saveJumpProfile', 'connect', 'disconnect', 'list', 'openRemote', 'openLocal', 'browseLocalSelection', 'selectLocalPath', 'chooseLocalFolder', 'listLocal', 'openLocalFile', 'searchLocalFiles', 'page', 'filter', 'clearFilter', 'search', 'cancelSearch', 'download', 'upload', 'extract', 'extractLocalMatches', 'cancelTask', 'follow', 'saveBookmarks', 'chooseKey', 'chooseDirectory', 'openExtracted', 'searchFiles', 'searchExtracted', 'batchTransfer'];
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke(name, ...args)]));
api.getPathForFile = file => webUtils.getPathForFile(file);
api.onEvent = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('viewer-event', listener);
  return () => ipcRenderer.removeListener('viewer-event', listener);
};
contextBridge.exposeInMainWorld('viewer', api);
