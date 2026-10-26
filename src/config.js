// %APPDATA%\Genshin Map Overlay\settings.json
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  hotkeys: {
    toggleOverlay: 'F7',
    togglePanel: 'F8',
    toggleFound: 'F9',
    cycleOpacity: 'F10',
    // nur aktiv, solange ein Marker in der Nähe angeboten wird
    markNearby: 'Alt+E',
  },
  hotkeysEnabled: true,
  active: true,
  // null = Setup bzw. Windows-Sprache
  language: null,
  // Oculi. Teleporter/Statuen nicht, die zeigt die Ingame-Karte schon
  enabledTypes: ['o5', 'o6', 'o141', 'o194', 'o403', 'o508', 'o626', 'o694', 'o833'],
  hideFound: false,
  // false: Overlay fehlt in Aufnahmen, stört so auch den Tracker nicht
  showInCaptures: false,
  // Marker auf der Minimap (Weltansicht); „in der Nähe“-Hinweis bis zu so vielen Kartenpixeln (z13)
  minimap: true,
  nearbyRadius: 7,
  opacity: 1,
  opacitySteps: [1, 0.75, 0.5],
  markerSize: 26,
  displayId: null,
  // 10 bis 13 Grobsuche, 14 für nah gezoomte Ansichten
  referenceLevels: [10, 11, 12, 13, 14],
  trackingFps: 15,
  searchIntervalMs: 500,
  // Leer = über HoYoPlay suchen
  genshinPath: '',
  // Eigener Datenserver (server/). Leer = direkt von der externen Quelle
  serverUrl: 'https://genshin-map-overlay.pages.dev',
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalize(raw) {
  const cfg = { ...DEFAULTS, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw && raw.hotkeys) } };
  cfg.opacity = clamp(cfg.opacity, 0.2, 1, DEFAULTS.opacity);
  if (!Array.isArray(cfg.opacitySteps) || !cfg.opacitySteps.length) cfg.opacitySteps = DEFAULTS.opacitySteps;
  cfg.opacitySteps = cfg.opacitySteps.map((v) => clamp(v, 0.2, 1, 1));
  cfg.markerSize = clamp(cfg.markerSize, 14, 48, DEFAULTS.markerSize);
  cfg.nearbyRadius = clamp(cfg.nearbyRadius, 1, 30, DEFAULTS.nearbyRadius);
  cfg.trackingFps = clamp(cfg.trackingFps, 1, 30, DEFAULTS.trackingFps);
  cfg.searchIntervalMs = clamp(cfg.searchIntervalMs, 100, 5000, DEFAULTS.searchIntervalMs);
  if (!Array.isArray(cfg.enabledTypes)) cfg.enabledTypes = DEFAULTS.enabledTypes;
  if (!Array.isArray(cfg.referenceLevels) || !cfg.referenceLevels.every((z) => z >= 10 && z <= 15)) {
    cfg.referenceLevels = DEFAULTS.referenceLevels;
  }
  return cfg;
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    // Fehlt oder kaputt → mit Standardwerten neu anlegen
    const cfg = normalize({});
    save(cfg);
    return cfg;
  }
}

// Nur Abweichungen speichern, damit neue Standardwerte bei Updates greifen
function save(cfg) {
  const out = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'hotkeys') {
      const changed = Object.entries(value).filter(([name, accelerator]) => DEFAULTS.hotkeys[name] !== accelerator);
      if (changed.length) out.hotkeys = Object.fromEntries(changed);
    } else if (JSON.stringify(value) !== JSON.stringify(DEFAULTS[key])) {
      out[key] = value;
    }
  }
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(out, null, 2), 'utf8');
}

module.exports = { load, save, filePath };
