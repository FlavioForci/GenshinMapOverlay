// Hauptprozess: overlay (über dem Spiel, durchklickbar) + tracker (unsichtbar, Bildvergleich).
// Kein Zugriff aufs Spiel, keine Eingaben. Hotkeys per RegisterHotKey, kein Tastatur-Hook.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('child_process');
const {
  app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, Tray, nativeImage, screen, session, shell, systemPreferences, dialog,
} = require('electron');
const config = require('./config');
const I18n = require('./shared/i18n');
const { DataStore } = require('./data/store');
const { createProgressRuntime } = require('./progress/runtime');
const { registerProgressIpc } = require('./progress/ipc');
const { createTransferRuntime } = require('./transfer/runtime');
const { canonicalCatalog } = require('./transfer/catalog');
const { createQuitGuard, createRendererQuitDrain } = require('./progress/app-lifecycle');
const { createClientProgressBarrier } = require('./progress/client-barrier');
const { createSettingsWindow, createSettingsWindowOwner } = require('./settings/window');
const TILESET = require('./data/tileset');
const hotkeyHelper = require('./hotkey-helper');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const OVERLAY_DOCUMENT = pathToFileURL(path.join(__dirname, 'overlay/index.html')).href;
const SETTINGS_DOCUMENT = pathToFileURL(path.join(__dirname, 'settings/index.html')).href;
// Windows: Admin-/UIPI-Themen, Tasten-Helfer, Genshin-Start. macOS: Panel über Vollbild, Aufnahme-Freigabe
// Linux: X11/XWayland statt Wayland, Autostart per .desktop-Datei, kein Aufnahmeschutz
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
// Wie WebRTC: Wayland-Sitzung → Aufnahme übers PipeWire-Portal, auch unter XWayland
const IS_WAYLAND = IS_LINUX && process.env.XDG_SESSION_TYPE === 'wayland' && !!process.env.WAYLAND_DISPLAY;

let cfg;
let lang = 'en';
let store;
let progressRuntime;
let progressInitialization;
let disposeProgressIpc;
let transferRuntime;
let transferCatalog = null;
const settingsOwner = createSettingsWindowOwner({
  createWindow: onClosed => createSettingsWindow({ BrowserWindow, onClosed, getLanguage: () => lang }),
});
let markerData = null;
let overlayWin;
let trackerWin;
let tray;
let quitting = false;
let saveTimer;
const state = {
  tracker: { phase: 'starting', key: 'status.starting', progress: 0 },
  locked: false,
  hotkeyErrors: [],
  isAdmin: false,
  helperConnected: false,
  // Marker-Id, die das Overlay gerade „in der Nähe“ anbietet (Nähe-Taste), sonst null
  nearby: null,
};

const tr = (key, params) => I18n.t(lang, key, params);

// Beim Beenden laufen Timer evtl. noch, obwohl die Fenster schon zerstört sind
const alive = (win) => !!win && !win.isDestroyed();
const timers = [];

const bridge = new hotkeyHelper.HotkeyBridge({
  onHotkey: (name) => {
    const action = HOTKEY_ACTIONS[name];
    if (action) action();
  },
  onStatus: ({ connected, errors }) => {
    state.helperConnected = connected;
    if (connected && errors === null) {
      globalShortcut.unregisterAll();
      return;
    }
    if (connected) {
      state.hotkeyErrors = errors;
      notify(errors.length ? tr('notice.helperActivePartial', { keys: hotkeyErrorText() }) : tr('notice.helperActive'));
      sendToOverlay('settings', publicSettings());
      updateTrayMenu();
    } else {
      registerHotkeys();
    }
  },
  log: (text) => log(text),
});

// ---------- Protokoll ----------

// %APPDATA%\Genshin Map Overlay\overlay.log, rotiert bei ~1 MB
function log(text) {
  try {
    const file = path.join(app.getPath('userData'), 'overlay.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {
    // Log-Fehler ignorieren
  }
}

// ---------- Start ----------

// Linux unter Wayland: einmal mit --ozone-platform=x11 neu starten (XWayland).
// - nur dort gehen Fensterposition, „immer oben“, Durchklicken, Cursorabfrage und Hotkeys
// - Schalter wirkt nur beim Prozessstart, app.commandLine kommt zu spät
// - eigener --ozone-platform beim Start (z. B. =wayland) hat Vorrang
function relaunchOnX11() {
  if (!IS_WAYLAND || !process.env.DISPLAY || process.argv.some((a) => a.startsWith('--ozone-platform'))) return false;
  // AppImage: die Datei selbst neu starten, der Mount-Ordner verschwindet mit diesem Prozess
  const exe = process.env.APPIMAGE || process.execPath;
  try {
    spawn(exe, [...process.argv.slice(1), '--ozone-platform=x11'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    // Neustart nicht möglich → so weiter wie gestartet
    return false;
  }
}

if (hotkeyHelper.isHelperProcess()) {
  hotkeyHelper.runHelper();
} else if (relaunchOnX11()) {
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setActive(true));
  app.whenReady().then(start);
}

const overlayProgressDrain = createRendererQuitDrain({
  ipcMain,
  getClients: () => [{ window: overlayWin, url: OVERLAY_DOCUMENT }],
});
const rendererQuitDrain = createRendererQuitDrain({
  ipcMain,
  getClients: () => [
    { window: overlayWin, url: OVERLAY_DOCUMENT },
    { window: settingsOwner.current(), url: SETTINGS_DOCUMENT },
  ],
});
// One FIFO owns both drain lifecycles. Profile commands prepare only overlay:
// preparing the settings initiator here would wait on its own pending command.
const progressBarrier = createClientProgressBarrier({
  overlayDrain: overlayProgressDrain,
  quitDrain: {
    async prepare() {
      // Startup can create overlay after initialization. Capture clients only
      // after that continuation; shutdown has already closed barrier acceptance.
      if (progressInitialization) await progressInitialization;
      await rendererQuitDrain.prepare();
    },
    resume: () => rendererQuitDrain.resume(),
    dispose: () => rendererQuitDrain.dispose(),
  },
});
function localProgressWindow(window, url) {
  return alive(window) && !window.webContents.isDestroyed() && window.webContents.getURL() === url;
}
function openProfileSettings() {
  if (progressBarrier.active()) return;
  return settingsOwner.open();
}
const quitGuard = createQuitGuard({
  shutdown: () => progressBarrier.shutdown(async () => {
    const runtime = progressRuntime || (progressInitialization && await progressInitialization);
    if (runtime) await runtime.shutdown();
  }),
  quit: () => app.quit(),
  onReady: () => {
    quitting = true;
    timers.forEach(timer => clearInterval(timer));
    clearTimeout(saveTimer);
    if (disposeProgressIpc) disposeProgressIpc();
    if (transferRuntime) transferRuntime.dispose();
    progressBarrier.dispose();
  },
  onError: () => {
    notify(tr('profiles.quitFailed'));
    dialog.showErrorBox(tr('profiles.title'), tr('profiles.quitFailed'));
  },
});
app.on('before-quit', event => { void quitGuard.beforeQuit(event); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {});

// Tray-Auswahl > Setup (language.txt) > Windows-Sprache
function resolveLanguage() {
  if (cfg.language) return I18n.resolve(cfg.language);
  try {
    const chosen = fs.readFileSync(path.join(path.dirname(process.execPath), 'language.txt'), 'utf8').trim();
    if (chosen) return I18n.resolve(chosen);
  } catch {
    // ohne Setup (z. B. Entwicklung)
  }
  return app.getLocale().toLowerCase().startsWith('de') ? 'de' : 'en';
}

async function start() {
  Menu.setApplicationMenu(null);
  if (IS_MAC) app.dock.hide();
  cfg = config.load({ preserveMalformed: true });
  lang = resolveLanguage();
  if (cfg.tileset) Object.assign(TILESET, cfg.tileset);
  store = new DataStore(path.join(app.getPath('userData'), 'cache'), TILESET, cfg.serverUrl);
  progressInitialization = createProgressRuntime({ app, log, onSnapshot: snapshot => {
    sendToOverlay('progress:snapshot', snapshot);
    const settingsWindow = settingsOwner.current();
    if (localProgressWindow(settingsWindow, SETTINGS_DOCUMENT)) settingsWindow.webContents.send('progress:snapshot', snapshot);
  } });
  progressRuntime = await progressInitialization;
  disposeProgressIpc = registerProgressIpc({
    ipcMain, service: progressRuntime.service,
    getOverlayWindow: () => localProgressWindow(overlayWin, OVERLAY_DOCUMENT) ? overlayWin : null,
    getSettingsWindow: () => localProgressWindow(settingsOwner.current(), SETTINGS_DOCUMENT) ? settingsOwner.current() : null,
    openSettings: openProfileSettings, dialogs: dialog,
    retryLocal: () => progressRuntime.retryLocal(),
    withProgressBarrier: operation => progressBarrier.run(operation),
  });
  transferRuntime = createTransferRuntime({
    progress: progressRuntime.service, getCatalog: () => transferCatalog,
    getSettingsWindow: () => localProgressWindow(settingsOwner.current(), SETTINGS_DOCUMENT) ? settingsOwner.current() : null,
    ipcMain, dialogs: dialog, withProgressBarrier: operation => progressBarrier.run(operation),
  });
  state.isAdmin = isAdmin();
  log(`start: Version ${app.getVersion()}, Electron ${process.versions.electron}, Sprache ${lang}, Admin ${state.isAdmin}, Bildschirme ${screen.getAllDisplays().map((d) => `${d.id}:${d.size.width}x${d.size.height}@${d.scaleFactor}`).join(' ')}`);

  setupCapture();
  createOverlay();
  createTracker();
  createTray();
  registerHotkeys();
  checkScreenPermission();
  checkLinuxSession();
  // AppImage: nach Update/Verschieben den Autostart auf die aktuelle Datei zeigen lassen
  if (IS_LINUX && app.isPackaged && isAutostart()) setAutostart(true);

  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => {
      placeOverlay();
      updateTrayMenu();
    });
  }
  timers.push(setInterval(keepOnTop, 2000));
  timers.push(setInterval(pollCursor, 33));
  timers.push(setInterval(() => maybeStartHelper(false), 10000));
  timers.push(setTimeout(() => maybeStartHelper(false), 3000));
  if (state.isAdmin) notify(tr('notice.adminCapture'));

  loadMarkerData(false);
  if (!cfg.active && IS_WIN) {
    tray.displayBalloon({
      title: tr('balloon.runningTitle'),
      content: tr('balloon.runningText', { key: cfg.hotkeys.toggleOverlay }),
      iconType: 'info',
    });
  }
}

function isAdmin() {
  return IS_WIN && spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
}

// macOS fragt beim ersten Aufnehmen nach, wirksam erst nach Neustart der App
function checkScreenPermission() {
  if (!IS_MAC) return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  log(`macOS Bildschirmaufnahme: ${status}`);
  if (status !== 'granted') notify(tr('notice.macScreenPermission'));
}

// Linux: reines Wayland → Overlay eingeschränkt. Wayland-Sitzung → Portal fragt nach dem Bildschirm
function checkLinuxSession() {
  if (!IS_LINUX) return;
  const nativeWayland = IS_WAYLAND && !process.argv.includes('--ozone-platform=x11');
  log(`Linux: Sitzung ${process.env.XDG_SESSION_TYPE || '?'}, Desktop ${process.env.XDG_CURRENT_DESKTOP || '?'}, natives Wayland ${nativeWayland}`);
  if (nativeWayland) notify(tr('notice.linuxWayland'));
  else if (IS_WAYLAND && cfg.active) notify(tr('notice.linuxPortal'));
}

async function loadMarkerData(force) {
  try {
    const loaded = await store.loadMarkers({ force, lang });
    // Build after data loads, never per transfer request. Semantic fingerprints
    // ignore translated labels; raw marker levels are not verified floors.
    if (loaded !== markerData) {
      const catalog = canonicalCatalog(loaded);
      if (transferCatalog?.fingerprint !== catalog.fingerprint) transferRuntime?.controller.invalidatePreview();
      transferCatalog = catalog;
    }
    markerData = loaded;
    sendToOverlay('data:markers', markerData);
    if (force) notify(tr('notice.dataUpdated'));
  } catch (err) {
    notify(tr('notice.dataFailed', { error: err.message }));
  }
}

// ---------- Fenster ----------

function targetDisplay() {
  return screen.getAllDisplays().find((d) => d.id === cfg.displayId) || screen.getPrimaryDisplay();
}

function createOverlay() {
  overlayWin = new BrowserWindow({
    ...targetDisplay().bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Linux (X11): nicht fokussierbar = override-redirect, liegt am Fenstermanager vorbei oben
    focusable: false,
    // macOS: NSPanel, kann über Vollbild-Apps liegen
    ...(IS_MAC ? { type: 'panel' } : {}),
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Genshin Map Overlay',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  // Aus Aufnahmen ausblenden, sonst sieht der Tracker die eigenen Marker (Linux: nicht möglich)
  overlayWin.setContentProtection(!cfg.showInCaptures);
  const fixedNavigation = (event, url) => { if (url !== OVERLAY_DOCUMENT) event.preventDefault(); };
  overlayWin.webContents.on('will-navigate', fixedNavigation);
  overlayWin.webContents.on('will-redirect', fixedNavigation);
  overlayWin.webContents.on('will-attach-webview', event => event.preventDefault());
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  overlayWin.webContents.on('did-finish-load', () => {
    if (!localProgressWindow(overlayWin, OVERLAY_DOCUMENT)) return;
    sendToOverlay('settings', publicSettings());
    sendToOverlay('progress:snapshot', progressRuntime.service.snapshot());
    sendToOverlay('tracker:status', localizedStatus());
    if (markerData) sendToOverlay('data:markers', markerData);
    for (const text of pendingNotices) sendToOverlay('notice', text);
    pendingNotices = [];
    if (cfg.active) showOverlay();
  });
  overlayWin.on('close', (event) => {
    if (!quitting) event.preventDefault();
  });
}

function placeOverlay() {
  if (!alive(overlayWin)) return;
  overlayWin.setBounds(targetDisplay().bounds);
}

function showOverlay() {
  if (!alive(overlayWin)) return;
  placeOverlay();
  overlayWin.showInactive();
  // Windows kürzt neue Fenster auf den Bereich über der Taskleiste → nochmal setzen
  placeOverlay();
  keepOnTop();
}

// Aufnahmeschutz mit auffrischen: ging nach Auflösungswechseln verloren, dann sieht der Tracker die eigenen Marker
function keepOnTop() {
  if (!alive(overlayWin) || !overlayWin.isVisible()) return;
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setContentProtection(!cfg.showInCaptures);
}

// Genshin (Admin) vorne → forward-Mausereignisse fehlen, Cursor daher selbst abfragen.
// Daran entscheidet das Overlay, ob es Klicks abfängt.
let lastCursor = null;
function pollCursor() {
  if (!alive(overlayWin) || !overlayWin.isVisible()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = overlayWin.getBounds();
  const cursor = { x: point.x - bounds.x, y: point.y - bounds.y };
  if (lastCursor && lastCursor.x === cursor.x && lastCursor.y === cursor.y) return;
  lastCursor = cursor;
  sendToOverlay('cursor', cursor);
}

function createTracker() {
  trackerWin = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'tracker', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  trackerWin.loadFile(path.join(__dirname, 'tracker', 'index.html'));
  trackerWin.webContents.on('render-process-gone', (_e, details) => {
    log(`tracker: Prozess beendet (${details.reason}, Code ${details.exitCode})`);
    setTrackerStatus({ phase: 'error', key: 'status.crashed', params: { reason: details.reason }, progress: 0 });
    setTimeout(() => alive(trackerWin) && !quitting && trackerWin.reload(), 2000);
  });
}

// Wayland: Portal-Auswahl merken, sonst fragt der Systemdialog bei jedem Neustart der Aufnahme
let portalSource = null;

// Nur der Tracker darf aufnehmen, ohne Dialog den Bildschirm des Overlays
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const trackerFrame = alive(trackerWin) && trackerWin.webContents.mainFrame;
    const isTracker = trackerFrame && request.frame
      && request.frame.processId === trackerFrame.processId && request.frame.routingId === trackerFrame.routingId;
    if (!isTracker) {
      callback({});
      return;
    }
    if (portalSource) {
      callback({ video: portalSource });
      return;
    }
    try {
      // Wayland: zeigt den Portal-Dialog, liefert nur die gewählte Quelle ohne display_id
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = String(targetDisplay().id);
      const source = sources.find((s) => s.display_id === wanted) || sources[0];
      log(`capture: ${sources.length} Bildschirme, gewählt ${source ? `${source.id} (display ${source.display_id})` : 'keiner'}, gesucht display ${wanted}`);
      if (IS_WAYLAND && source) portalSource = source;
      callback(source ? { video: source } : {});
    } catch (err) {
      log(`capture: getSources fehlgeschlagen – ${err && err.stack ? err.stack : err}`);
      callback({});
    }
  }, { useSystemPicker: false });
}

// ---------- Zustand ----------

function hotkeyErrorText() {
  return state.hotkeyErrors.map((name) => `${cfg.hotkeys[name]} (${tr(`hotkey.${name}`)})`).join(', ');
}

function publicSettings() {
  return {
    language: lang,
    hotkeys: cfg.hotkeysEnabled ? cfg.hotkeys : {},
    hotkeyErrors: state.hotkeyErrors.map((name) => cfg.hotkeys[name]),
    showInCaptures: cfg.showInCaptures,
    // Linux kennt keinen Aufnahmeschutz → Schalter im Panel ausblenden
    captureProtection: !IS_LINUX,
    minimap: cfg.minimap,
    nearbyRadius: cfg.nearbyRadius,
    opacity: cfg.opacity,
    markerSize: cfg.markerSize,
    active: cfg.active,
  };
}

function trackerSettings() {
  const display = targetDisplay();
  return {
    active: cfg.active,
    levels: cfg.referenceLevels,
    tileset: TILESET,
    fps: cfg.trackingFps,
    searchIntervalMs: cfg.searchIntervalMs,
    minimap: cfg.minimap,
    displaySize: { width: display.size.width * display.scaleFactor, height: display.size.height * display.scaleFactor },
  };
}

function sendToOverlay(channel, payload) {
  if (channel === 'progress:snapshot' && !localProgressWindow(overlayWin, OVERLAY_DOCUMENT)) return;
  if (alive(overlayWin)) overlayWin.webContents.send(channel, payload);
}

function sendToTracker(channel, payload) {
  if (alive(trackerWin)) trackerWin.webContents.send(channel, payload);
}

function updateSettings(patch) {
  Object.assign(cfg, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Never overwrite legacy bytes during migration or read-only recovery.
    if (progressRuntime?.service.snapshot().sync.phase === 'local') config.save(cfg);
  }, 400);
  sendToOverlay('settings', publicSettings());
  updateTrayMenu();
}

// Tracker liefert nur i18n-Schlüssel
function localizedStatus() {
  const s = state.tracker;
  return { ...s, message: s.key ? tr(s.key, s.params) : s.message || '' };
}

function setTrackerStatus(status) {
  const changed = status.phase !== state.tracker.phase;
  // Gemerkte Portal-Quelle ungültig → beim nächsten Versuch neu fragen
  if (status.phase === 'capture-error') portalSource = null;
  state.tracker = status;
  const localized = localizedStatus();
  if (changed) log(`tracker-status: ${status.phase} – ${localized.message}`);
  sendToOverlay('tracker:status', localized);
  if (tray) tray.setToolTip(tr('tray.tooltip', { status: localized.message }));
}

let pendingNotices = [];
function notify(text) {
  if (!alive(overlayWin) || overlayWin.webContents.isLoading()) pendingNotices.push(text);
  else sendToOverlay('notice', text);
}

// ---------- Aktionen ----------

function setActive(on) {
  updateSettings({ active: on });
  sendToTracker('tracker:settings', trackerSettings());
  updateNearbyHotkey();
  if (on) {
    showOverlay();
    notify(tr('notice.overlayOn'));
  } else if (alive(overlayWin)) {
    overlayWin.hide();
  }
}

// Marker auf der Minimap an/aus (Tray und Panel): Tracker hört dann auch mit der Minimap-Verfolgung auf
function setMinimap(on) {
  updateSettings({ minimap: on });
  sendToTracker('tracker:settings', trackerSettings());
}

function togglePanel() {
  if (!cfg.active) setActive(true);
  sendToOverlay('panel:toggle');
}

function toggleFoundVisibility() {
  sendToOverlay('progress:toggle-hide-found');
}

function cycleOpacity() {
  const steps = cfg.opacitySteps;
  const index = steps.findIndex((s) => Math.abs(s - cfg.opacity) < 0.01);
  updateSettings({ opacity: steps[(index + 1) % steps.length] });
  notify(tr('notice.opacity', { value: Math.round(cfg.opacity * 100) }));
}

// Markernamen kommen aus dem Cache, kein Download
function setLanguage(code) {
  lang = I18n.resolve(code);
  updateSettings({ language: lang });
  settingsOwner.sendLanguage(lang);
  sendToOverlay('tracker:status', localizedStatus());
  loadMarkerData(false);
  notify(tr('notice.languageChanged'));
}

function setDisplay(id) {
  portalSource = null;
  updateSettings({ displayId: id });
  placeOverlay();
  sendToTracker('tracker:settings', trackerSettings());
  sendToTracker('tracker:restart-capture');
}

function rebuildReference() {
  sendToTracker('tracker:rebuild');
}

function isGenshinRunning() {
  const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq GenshinImpact.exe', '/NH'], { windowsHide: true, encoding: 'utf8' });
  return /GenshinImpact\.exe/i.test(res.stdout || '');
}

// Auto-Start nur bei laufendem Genshin. UAC abgelehnt → erst wieder per Tray-Menü
let helperDeclined = false;
async function maybeStartHelper(force) {
  if (!IS_WIN || state.isAdmin || bridge.connected || !cfg.hotkeysEnabled) return;
  if (!force && (helperDeclined || !isGenshinRunning())) return;
  const ok = await bridge.start();
  if (!ok) {
    helperDeclined = true;
    notify(tr('notice.helperDeclined'));
  }
}

// Installationsordner aus der HoYoPlay-Registry
function findGenshinExe() {
  const candidates = [];
  if (cfg.genshinPath) candidates.push(cfg.genshinPath);
  const res = spawnSync('reg', ['query', 'HKCU\\Software\\Cognosphere\\HYP\\1_0\\hk4e_global', '/v', 'GameInstallPath'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  const match = /GameInstallPath\s+REG_SZ\s+(.+)/.exec(res.stdout || '');
  if (match) candidates.push(path.join(match[1].trim(), 'GenshinImpact.exe'));
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// Exklusives Vollbild verdeckt das Overlay → randloses Fenster per Unity-Startparameter
function launchGenshinBorderless() {
  if (isGenshinRunning()) {
    notify(tr('notice.genshinRunning'));
    return;
  }
  const exe = findGenshinExe();
  if (!exe) {
    notify(tr('notice.genshinNotFound'));
    return;
  }
  const display = targetDisplay();
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const args = ['-popupwindow', '-screen-fullscreen', '0', '-screen-width', width, '-screen-height', height];
  const command = `Start-Process -FilePath ${quote(exe)} -WorkingDirectory ${quote(path.dirname(exe))} -ArgumentList ${args.map(quote).join(',')}`;
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  ps.on('exit', (code) => {
    if (code !== 0) notify(tr('notice.genshinStartFailed'));
  });
  if (!cfg.active) setActive(true);
}

function reloadSettings() {
  const previousLang = lang;
  cfg = config.load({ preserveMalformed: true });
  lang = resolveLanguage();
  settingsOwner.sendLanguage(lang);
  sendToOverlay('settings', publicSettings());
  sendToTracker('tracker:settings', trackerSettings());
  registerHotkeys();
  placeOverlay();
  const serverChanged = store.serverUrl !== String(cfg.serverUrl || '').replace(/\/+$/, '');
  if (serverChanged) {
    store.serverUrl = String(cfg.serverUrl || '').replace(/\/+$/, '');
    store.manifestCache = null;
  }
  if (lang !== previousLang || serverChanged) {
    sendToOverlay('tracker:status', localizedStatus());
    loadMarkerData(false);
  }
  notify(tr('notice.settingsReloaded'));
}

// ---------- Hotkeys ----------

const HOTKEY_ACTIONS = {
  toggleOverlay: () => setActive(!cfg.active),
  togglePanel,
  toggleFound: toggleFoundVisibility,
  cycleOpacity,
  markNearby,
};

// Marker in der Nähe (Minimap) als gefunden markieren
function markNearby() {
  const id = state.nearby;
  if (id === null) return;
  sendToOverlay('nearby:mark', id);
}

// Nähe-Taste nur, solange das Overlay einen Marker anbietet: sonst bleibt sie für Spiel und andere Programme frei
function activeHotkeys() {
  if (!cfg.hotkeysEnabled) return {};
  const { markNearby: nearbyKey, ...rest } = cfg.hotkeys;
  return state.nearby !== null && cfg.active && nearbyKey ? { ...rest, markNearby: nearbyKey } : rest;
}

let nearbyRegistered = null;
function updateNearbyHotkey() {
  if (bridge.connected) {
    bridge.setHotkeys(activeHotkeys());
    return;
  }
  const wanted = activeHotkeys().markNearby || null;
  if (wanted === nearbyRegistered) return;
  if (nearbyRegistered) globalShortcut.unregister(nearbyRegistered);
  nearbyRegistered = null;
  if (!wanted) return;
  try {
    if (globalShortcut.register(wanted, markNearby)) nearbyRegistered = wanted;
  } catch {
    // belegt oder ungültig: Hinweis zeigt die Taste trotzdem, sie wirkt nur nicht
  }
}

// Ohne Helfer greifen die Kürzel nicht, solange Genshin (Admin) im Vordergrund ist
function registerHotkeys() {
  globalShortcut.unregisterAll();
  nearbyRegistered = null;
  state.hotkeyErrors = [];
  bridge.setHotkeys(activeHotkeys());
  if (bridge.connected) {
    sendToOverlay('settings', publicSettings());
    updateTrayMenu();
    return;
  }
  if (cfg.hotkeysEnabled) {
    for (const [name, accelerator] of Object.entries(activeHotkeys())) {
      const action = HOTKEY_ACTIONS[name];
      if (!action || !accelerator || name === 'markNearby') continue;
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, action);
      } catch {
        ok = false;
      }
      if (!ok) state.hotkeyErrors.push(name);
    }
  }
  updateNearbyHotkey();
  if (state.hotkeyErrors.length) {
    log(`hotkeys: nicht registriert – ${state.hotkeyErrors.join(', ')}`);
    notify(tr('notice.hotkeysTaken', { keys: hotkeyErrorText() }));
  }
  sendToOverlay('settings', publicSettings());
  updateTrayMenu();
}

// ---------- Tray ----------

function createTray() {
  // Linux-Leisten skalieren selbst, größer bleibt dort scharf
  const size = IS_LINUX ? 32 : 16;
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: size, height: size, quality: 'best' }));
  tray.setToolTip('Genshin Map Overlay');
  // macOS und Linux öffnen beim Klick meist das Menü, dort nicht zusätzlich umschalten
  if (IS_WIN) tray.on('click', () => setActive(!cfg.active));
  updateTrayMenu();
}

// Linux: Electron kann keinen Autostart → XDG-Autostart-Datei
function autostartFile() {
  return path.join(app.getPath('appData'), 'autostart', 'genshin-map-overlay.desktop');
}

function isAutostart() {
  return IS_LINUX ? fs.existsSync(autostartFile()) : app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on) {
  if (!IS_LINUX) {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  try {
    if (!on) {
      fs.rmSync(autostartFile(), { force: true });
      return;
    }
    // AppImage: die Datei selbst, nicht der Mount-Ordner. Exec-Regeln: " ` $ \ maskieren, % verdoppeln
    const exe = (process.env.APPIMAGE || process.execPath).replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%');
    const entry = ['[Desktop Entry]', 'Type=Application', 'Name=Genshin Map Overlay', `Exec="${exe}"`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''];
    fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
    fs.writeFileSync(autostartFile(), entry.join('\n'), 'utf8');
  } catch (err) {
    log(`autostart: ${err.message}`);
  }
}

// Taste rechtsbündig anzeigen; registriert wird sie woanders (globalShortcut/Helfer)
function hotkeyLabel(name) {
  const ok = cfg.hotkeysEnabled && cfg.hotkeys[name] && !state.hotkeyErrors.includes(name);
  return ok ? { accelerator: cfg.hotkeys[name], registerAccelerator: false } : {};
}

// Kurz halten: was das Panel schon kann (Gefundene, Screenshots, Deckkraft), fehlt hier
function updateTrayMenu() {
  if (!tray) return;
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const currentId = targetDisplay().id;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('tray.launchGenshin'), visible: IS_WIN, click: launchGenshinBorderless },
    { type: 'separator', visible: IS_WIN },
    { label: tr('tray.active'), type: 'checkbox', checked: cfg.active, click: (item) => setActive(item.checked), ...hotkeyLabel('toggleOverlay') },
    { label: tr('tray.panel'), click: togglePanel, ...hotkeyLabel('togglePanel') },
    { label: tr('tray.profiles'), click: openProfileSettings },
    { label: tr('tray.minimap'), type: 'checkbox', checked: cfg.minimap !== false, click: (item) => setMinimap(item.checked) },
    {
      label: tr('tray.helperStart'),
      visible: IS_WIN && !state.helperConnected && !state.isAdmin && cfg.hotkeysEnabled,
      click: () => {
        helperDeclined = false;
        maybeStartHelper(true);
      },
    },
    { type: 'separator' },
    {
      // Nur installiert, sonst startet Windows die nackte electron.exe
      label: tr(IS_LINUX ? 'tray.autostartLogin' : 'tray.autostart'),
      type: 'checkbox',
      visible: app.isPackaged,
      checked: app.isPackaged && isAutostart(),
      click: (item) => {
        setAutostart(item.checked);
        log(`autostart: ${item.checked}`);
        updateTrayMenu();
      },
    },
    {
      label: tr('tray.language'),
      submenu: I18n.LANGUAGES.map((l) => ({
        label: l.label,
        type: 'radio',
        checked: l.code === lang,
        click: () => setLanguage(l.code),
      })),
    },
    {
      label: tr('tray.display'),
      visible: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: tr('tray.displayItem', {
          n: i + 1,
          primary: d.id === primaryId ? tr('tray.primary') : '',
          width: d.size.width,
          height: d.size.height,
        }),
        type: 'radio',
        checked: d.id === currentId,
        click: () => setDisplay(d.id),
      })),
    },
    {
      label: tr('tray.advanced'),
      submenu: [
        { label: tr('tray.refreshData'), click: () => loadMarkerData(true) },
        { label: tr('tray.rebuild'), click: rebuildReference },
        {
          label: tr('tray.hotkeysEnabled'),
          type: 'checkbox',
          checked: cfg.hotkeysEnabled,
          click: (item) => {
            updateSettings({ hotkeysEnabled: item.checked });
            registerHotkeys();
          },
        },
        { type: 'separator' },
        { label: tr('tray.openSettings'), click: () => shell.openPath(config.ensureFile()) },
        { label: tr('tray.reloadSettings'), click: reloadSettings },
      ],
    },
    { type: 'separator' },
    { label: tr('tray.quit'), click: () => app.quit() },
  ]));
}

// ---------- IPC ----------

function fromOverlay(event) {
  return alive(overlayWin) && event.sender === overlayWin.webContents;
}

function fromTracker(event) {
  return alive(trackerWin) && event.sender === trackerWin.webContents;
}

ipcMain.on('overlay:mouse', (event, capture) => {
  if (!fromOverlay(event)) return;
  overlayWin.setIgnoreMouseEvents(!capture, { forward: true });
});

// Fokus nur fürs Suchfeld, danach zurück ans Spiel
ipcMain.on('overlay:keyboard', (event, wanted) => {
  if (!fromOverlay(event)) return;
  overlayWin.setFocusable(wanted);
  overlayWin.setSkipTaskbar(true);
  if (wanted) overlayWin.focus();
  else overlayWin.blur();
});

ipcMain.on('overlay:settings', (event, patch) => {
  if (!fromOverlay(event) || !patch || typeof patch !== 'object') return;
  const allowed = {};
  if (typeof patch.showInCaptures === 'boolean') {
    allowed.showInCaptures = patch.showInCaptures;
    overlayWin.setContentProtection(!patch.showInCaptures);
  }
  if (Number.isFinite(patch.opacity)) allowed.opacity = Math.min(1, Math.max(0.2, patch.opacity));
  if (Number.isFinite(patch.markerSize)) allowed.markerSize = Math.min(48, Math.max(14, patch.markerSize));
  updateSettings(allowed);
  if (typeof patch.minimap === 'boolean') setMinimap(patch.minimap);
});

ipcMain.on('overlay:refresh-data', (event) => {
  if (fromOverlay(event)) loadMarkerData(true);
});

ipcMain.on('overlay:hide', (event) => {
  if (fromOverlay(event)) setActive(false);
});

ipcMain.handle('overlay:icon', async (event, type) => {
  if (!fromOverlay(event)) return null;
  try {
    return await store.icon(type);
  } catch {
    return null;
  }
});

// Fehler kommen als { error } zurück
ipcMain.handle('overlay:comments', async (event, type, id, page) => {
  if (!fromOverlay(event)) return null;
  try {
    return await store.comments(String(type), Number(id), Number(page) || 1);
  } catch (err) {
    log(`comments: ${type}/${id} – ${err.message}`);
    return { error: err.message };
  }
});

ipcMain.handle('overlay:comment-image', async (event, imagePath) => {
  if (!fromOverlay(event)) return null;
  try {
    return await store.commentImage(imagePath);
  } catch {
    return null;
  }
});

ipcMain.handle('overlay:video-thumb', async (event, videoId) => {
  if (!fromOverlay(event)) return null;
  try {
    return await store.videoThumb(videoId);
  } catch {
    return null;
  }
});

// Nur http(s) an den Standardbrowser
ipcMain.on('overlay:open-link', (event, url) => {
  if (!fromOverlay(event) || typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) return;
  shell.openExternal(url);
});

// Tracker
ipcMain.handle('tracker:settings', (event) => (fromTracker(event) ? trackerSettings() : null));

ipcMain.handle('tracker:tile', async (event, z, x, y) => {
  if (!fromTracker(event)) return null;
  try {
    return await store.tile(z, x, y);
  } catch {
    return null;
  }
});

ipcMain.handle('tracker:prefetch', async (event, levels) => {
  if (!fromTracker(event)) return;
  await store.prefetchTiles(levels, (done, total) => {
    if (done % 20 === 0 || done === total) {
      setTrackerStatus({ phase: 'download', key: 'status.download', params: { done, total }, progress: done / total });
    }
  });
});

// Referenz: Cache → eigener Server → null (Tracker baut sie dann aus den Kacheln)
ipcMain.handle('tracker:reference-load', async (event, key) => {
  if (!fromTracker(event)) return null;
  try {
    return fs.readFileSync(referenceFile(key));
  } catch {
    // nicht im Cache
  }
  try {
    setTrackerStatus({ phase: 'download', key: 'status.downloadStart', progress: 0 });
    const buf = await store.reference(key);
    if (!buf) return null;
    fs.mkdirSync(path.dirname(referenceFile(key)), { recursive: true });
    fs.writeFileSync(referenceFile(key), buf);
    log(`reference: ${key} vom Server geladen (${Math.round(buf.length / 1024)} KB)`);
    return buf;
  } catch (err) {
    log(`reference: Download fehlgeschlagen – ${err.message}`);
    return null;
  }
});

ipcMain.handle('tracker:reference-save', (event, key, bytes) => {
  if (!fromTracker(event)) return;
  fs.mkdirSync(path.dirname(referenceFile(key)), { recursive: true });
  fs.writeFileSync(referenceFile(key), Buffer.from(bytes));
});

function referenceFile(key) {
  return path.join(app.getPath('userData'), 'cache', 'reference', `${String(key).replace(/[^\w.-]/g, '_')}.bin`);
}

ipcMain.on('tracker:status', (event, status) => {
  if (fromTracker(event)) setTrackerStatus(status);
});

ipcMain.on('tracker:log', (event, text) => {
  if (fromTracker(event)) log(`tracker: ${text}`);
});

ipcMain.on('tracker:view', (event, view) => {
  if (!fromTracker(event)) return;
  if (view.locked !== state.locked) {
    state.locked = view.locked;
    if (tray) tray.setToolTip(tr('tray.tooltip', { status: tr(view.locked ? 'tray.locked' : 'tray.searching') }));
  }
  sendToOverlay('view', view);
});

// Marker in der Nähe der Spielfigur (Id) oder null → Nähe-Taste an/aus
ipcMain.on('overlay:nearby', (event, id) => {
  if (!fromOverlay(event)) return;
  const next = Number.isFinite(id) ? id : null;
  if (next === state.nearby) return;
  state.nearby = next;
  updateNearbyHotkey();
});

// Spielfigur auf der Minimap (Kartenpixel) oder null
ipcMain.on('tracker:minimap', (event, pos) => {
  if (fromTracker(event)) sendToOverlay('minimap', pos);
});
