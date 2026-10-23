// Brücke für das unsichtbare Tracker-Fenster.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['tracker:settings', 'tracker:rebuild', 'tracker:restart-capture'];

contextBridge.exposeInMainWorld('trackerApi', {
  settings: () => ipcRenderer.invoke('tracker:settings'),
  tile: (z, x, y) => ipcRenderer.invoke('tracker:tile', z, x, y),
  prefetch: (levels) => ipcRenderer.invoke('tracker:prefetch', levels),
  loadReference: (key) => ipcRenderer.invoke('tracker:reference-load', key),
  saveReference: (key, bytes) => ipcRenderer.invoke('tracker:reference-save', key, bytes),
  status: (status) => ipcRenderer.send('tracker:status', status),
  view: (view) => ipcRenderer.send('tracker:view', view),
  log: (text) => ipcRenderer.send('tracker:log', String(text)),
  on: (channel, callback) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
});
