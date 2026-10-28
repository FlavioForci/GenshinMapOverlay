// Brücke zwischen Profil-Abfrage und Hauptprozess.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileApi', {
  state: () => ipcRenderer.invoke('profiles:state'),
  onChange: (callback) => ipcRenderer.on('profiles:changed', (_event, state) => callback(state)),
  add: () => ipcRenderer.invoke('profiles:add'),
  rename: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  remove: (id) => ipcRenderer.invoke('profiles:remove', id),
  choose: (id) => ipcRenderer.send('profiles:choose', id),
  ask: (on) => ipcRenderer.send('profiles:ask', on),
  close: () => ipcRenderer.send('profiles:close'),
  height: (px) => ipcRenderer.send('profiles:height', px),
});
