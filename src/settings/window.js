'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Create the normal settings window; language remains outside progress state. */
function createSettingsWindow({ BrowserWindow, onClosed = () => {}, getLanguage = () => 'en' }) {
  const file = path.join(__dirname, 'index.html');
  const expected = pathToFileURL(file).href;
  const win = new BrowserWindow({
    width: 760, height: 720, minWidth: 560, minHeight: 520, show: false, focusable: true,
    title: 'Genshin Map Overlay', backgroundColor: '#262c3a', icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  const fixedNavigation = (event, url) => { if (url !== expected) event.preventDefault(); };
  win.webContents.on('will-navigate', fixedNavigation);
  win.webContents.on('will-redirect', fixedNavigation);
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('profiles:language', getLanguage() === 'de' ? 'de' : 'en');
    win.show();
  });
  win.on('closed', onClosed);
  win.loadFile(file);
  return win;
}

/** Main owns one reusable window. Closing releases ownership for reopen. */
function createSettingsWindowOwner({ createWindow }) {
  let window = null;
  return {
    current: () => window,
    open() {
      if (!window || window.isDestroyed()) window = createWindow(() => { window = null; });
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return window;
    },
    sendLanguage(language) {
      if (window && !window.isDestroyed()) window.webContents.send('profiles:language', language === 'de' ? 'de' : 'en');
    },
  };
}

module.exports = { createSettingsWindow, createSettingsWindowOwner };
