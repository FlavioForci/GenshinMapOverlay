// Brücke zwischen Overlay-Fenster und Hauptprozess.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['settings', 'found:all', 'found:changed', 'tracker:status', 'data:markers', 'view', 'minimap', 'nearby:done', 'notice', 'panel:toggle', 'cursor'];

contextBridge.exposeInMainWorld('overlayApi', {
  on: (channel, callback) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
  mouse: (capture) => ipcRenderer.send('overlay:mouse', capture),
  keyboard: (wanted) => ipcRenderer.send('overlay:keyboard', wanted),
  saveSettings: (patch) => ipcRenderer.send('overlay:settings', patch),
  toggleFound: (id) => ipcRenderer.send('overlay:found-toggle', id),
  nearby: (id) => ipcRenderer.send('overlay:nearby', id),
  refreshData: () => ipcRenderer.send('overlay:refresh-data'),
  hide: () => ipcRenderer.send('overlay:hide'),
  icon: (type) => ipcRenderer.invoke('overlay:icon', type),
  comments: (type, id, page) => ipcRenderer.invoke('overlay:comments', type, id, page),
  commentImage: (imagePath) => ipcRenderer.invoke('overlay:comment-image', imagePath),
  videoThumb: (videoId) => ipcRenderer.invoke('overlay:video-thumb', videoId),
  openLink: (url) => ipcRenderer.send('overlay:open-link', url),
});
