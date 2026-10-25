// Brücke zwischen Overlay-Fenster und Hauptprozess.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['settings', 'progress:snapshot', 'progress:toggle-hide-found', 'tracker:status', 'data:markers', 'view', 'notice', 'panel:toggle', 'cursor'];

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('overlayApi', {
  on: (channel, callback) => {
    if (!EVENTS.includes(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  mouse: (capture) => ipcRenderer.send('overlay:mouse', capture),
  keyboard: (wanted) => ipcRenderer.send('overlay:keyboard', wanted),
  saveSettings: (patch) => ipcRenderer.send('overlay:settings', patch),
  getProgress: () => ipcRenderer.invoke('progress:get'),
  setFound: payload => ipcRenderer.invoke('progress:set-found', payload),
  setProfilePreferences: payload => ipcRenderer.invoke('progress:set-preferences', payload),
  selectProfile: payload => ipcRenderer.invoke('progress:select-profile', payload),
  openProfileSettings: () => ipcRenderer.invoke('profiles:open-settings'),
  onPrepareQuit: callback => subscribe('progress:prepare-quit', callback),
  onResumeAfterQuit: callback => subscribe('progress:resume-after-quit', callback),
  quitReady: payload => ipcRenderer.send('progress:quit-ready', payload),
  refreshData: () => ipcRenderer.send('overlay:refresh-data'),
  hide: () => ipcRenderer.send('overlay:hide'),
  icon: (type) => ipcRenderer.invoke('overlay:icon', type),
  comments: (type, id, page) => ipcRenderer.invoke('overlay:comments', type, id, page),
  commentImage: (imagePath) => ipcRenderer.invoke('overlay:comment-image', imagePath),
  videoThumb: (videoId) => ipcRenderer.invoke('overlay:video-thumb', videoId),
  openLink: (url) => ipcRenderer.send('overlay:open-link', url),
});
