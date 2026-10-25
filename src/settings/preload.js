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
