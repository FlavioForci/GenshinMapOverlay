'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const COMMANDS = new Set(['create', 'rename', 'select', 'import-backup', 'export-backup', 'restore-local', 'retry-local']);

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('profileApi', {
  getState: () => ipcRenderer.invoke('progress:get'),
  command: (operation, payload) => COMMANDS.has(operation)
    ? ipcRenderer.invoke('profiles:command', { command: operation, payload })
    : Promise.reject(new Error('invalid-command')),
  onSnapshot: callback => subscribe('progress:snapshot', callback),
  onLanguage: callback => subscribe('profiles:language', callback),
  onPrepareQuit: callback => subscribe('progress:prepare-quit', callback),
  onResumeAfterQuit: callback => subscribe('progress:resume-after-quit', callback),
  quitReady: payload => ipcRenderer.send('progress:quit-ready', payload),
});

// Fixed transfer intents only. Main chooses/owns every path, file and script.
contextBridge.exposeInMainWorld('transferApi', {
  providers: () => ipcRenderer.invoke('transfer:providers'),
  exportScopes: context => ipcRenderer.invoke('transfer:exportScopes', context),
  previewImport: (context, options) => ipcRenderer.invoke('transfer:previewImport', context, options),
  applyImport: (context, options) => ipcRenderer.invoke('transfer:applyImport', context, options),
  exportProfile: (context, options) => ipcRenderer.invoke('transfer:exportProfile', context, options),
  saveScript: (provider, direction) => ipcRenderer.invoke('transfer:saveScript', provider, direction),
  saveReport: previewId => ipcRenderer.invoke('transfer:saveReport', previewId),
});
