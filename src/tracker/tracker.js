// Unsichtbares Tracker-Fenster: Aufnahme + Bildvergleich, Ergebnis an den Hauptprozess.
/* global MatcherCore, ReferenceBuilder, Hud */
const api = window.trackerApi;
const CAPTURE_WIDTH = 1280;
// Optischer Fluss trägt die offene Karte; ORB nur zum Verankern und gegen Drift:
// - Abgleich alle CHECK_MS, neu verankern erst bei zweimal > DRIFT_PX (einzelne ORB-Ausreißer ignorieren)
const FLOW_FPS = 30;
const CHECK_MS = 1000;
const DRIFT_PX = 5;

let cv = null;
let settings = null;
let matcher = null;
let flow = null;
let lastCheck = 0;
let driftHits = 0;
let reader = null;
let stream = null;
let frameCanvas = null;
let frameCtx = null;
let prior = null;
let lostFrames = 0;
let locked = false;
let running = false;
let building = false;
// Nur zur Fehlersuche (DevTools): letzte Versuche, Bild beim letzten Verlust
const recent = [];
let lostFrame = null;
let lastLockAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// key = i18n-Schlüssel, übersetzt wird im Hauptprozess
const status = (phase, key, params = {}, progress = 0) => api.status({ phase, key, params, progress });

async function loadCv() {
  const mod = window.cv;
  if (typeof mod.then === 'function') return mod;
  if (mod.Mat) return mod;
  return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
}

const tileCanvas = new OffscreenCanvas(256, 256);
const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
const tileCache = new Map();

async function tileRgba(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const bytes = await api.tile(z, x, y);
  let rgba = null;
  if (bytes && bytes.length) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    tileCtx.clearRect(0, 0, 256, 256);
    tileCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    rgba = new Uint8Array(tileCtx.getImageData(0, 0, 256, 256).data.buffer);
  }
  if (tileCache.size > 300) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, rgba);
  return rgba;
}

function referenceKey() {
  return `refdb-v1-${settings.tileset.version}-${settings.levels.join('_')}`;
}

async function prepareReference(force) {
  building = true;
  matcher = null;
  try {
    const key = referenceKey();
    const cached = force ? null : await api.loadReference(key);
    let ref;
    if (cached && cached.length) {
      ref = MatcherCore.deserializeReference(cached).ref;
    } else {
      status('download', 'status.downloadStart');
      await api.prefetch(settings.levels);
      status('building', 'status.building', { percent: 0 });
      ref = await ReferenceBuilder.build(cv, settings.tileset, settings.levels, tileRgba, null, (done, total) => {
        const p = done / total;
        status('building', 'status.building', { percent: Math.round(p * 100) }, p);
      });
      await api.saveReference(key, MatcherCore.serializeReference(ref, { levels: settings.levels, tileset: settings.tileset.version }));
      tileCache.clear();
    }
    // Stufen 14+ nur fürs Nachführen, hält die Grobsuche schnell
    const coarse = settings.levels.filter((z) => z <= 13);
    matcher = new MatcherCore.Matcher(cv, ref, { globalLevels: coarse.length ? coarse : null });
    if (flow) flow.reset();
    flow = new MatcherCore.FlowTracker(cv, { exclude: Hud.rects });
    status('ready', 'status.ready');
  } catch (err) {
    status('error', 'status.buildFailed', { error: err.message });
  } finally {
    building = false;
  }
}

async function startCapture() {
  stopCapture();
  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { reader = null; });
  // eslint-disable-next-line no-undef
  const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
  reader = processor.readable.getReader();
}

function stopCapture() {
  if (reader) reader.cancel().catch(() => {});
  reader = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function grabFrame() {
  if (!reader) await startCapture();
  const { value: frame, done } = await reader.read();
  if (done || !frame) {
    reader = null;
    return null;
  }
  const width = CAPTURE_WIDTH;
  const height = Math.round((CAPTURE_WIDTH * frame.displayHeight) / frame.displayWidth);
  if (!frameCanvas || frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas = new OffscreenCanvas(width, height);
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  }
  frameCtx.drawImage(frame, 0, 0, width, height);
  frame.close();
  return frameCtx.getImageData(0, 0, width, height);
}

function report(res, width, height) {
  const nowLocked = !!res && res.ok;
  if (nowLocked) {
    // relativ zur Bildgröße: bildschirm = (sx * karte + ox) * Breite
    api.view({
      locked: true,
      sx: res.s / width,
      sy: res.s / height,
      ox: res.tx / width,
      oy: res.ty / height,
      inliers: res.inliers,
      ms: res.ms,
      mode: res.mode,
    });
  } else if (locked) {
    api.view({ locked: false });
  }
  locked = nowLocked;
}

function anchorFlow(img, res) {
  flow.anchor(img.data, img.width, img.height, res);
  lastCheck = performance.now();
  driftHits = 0;
}

// Fluss weiterführen; ab und zu per ORB nachprüfen und bei echter Drift neu verankern
function followFlow(img) {
  const res = flow.track(img.data, img.width, img.height);
  if (!res.ok || performance.now() - lastCheck < CHECK_MS) return res;
  lastCheck = performance.now();
  const orb = matcher.locate(img.data, img.width, img.height, res);
  if (!orb.ok || MatcherCore.fitDistance(res, orb, img.width, img.height) <= DRIFT_PX) {
    driftHits = 0;
    return res;
  }
  if (++driftHits < 2) return res;
  anchorFlow(img, orb);
  return orb;
}

async function loop() {
  if (running) return;
  running = true;
  let failures = 0;
  while (settings.active && matcher && !building) {
    const started = performance.now();
    try {
      const img = await grabFrame();
      if (!img) {
        await sleep(200);
        continue;
      }
      let res = prior && flow.active ? followFlow(img) : null;
      if (!res || !res.ok) {
        res = matcher.locate(img.data, img.width, img.height, prior);
        // Nachführen gescheitert (z. B. schneller Zoom) → gleich im selben Bild neu suchen
        if (!res.ok && prior) res = matcher.locate(img.data, img.width, img.height, null);
        if (res.ok) anchorFlow(img, res);
      }
      recent.push({ t: Date.now(), mode: res.mode, ok: res.ok, inliers: res.inliers, pairs: res.pairs, spread: res.spread, s: res.s, ms: res.ms });
      if (recent.length > 240) recent.shift();
      if (res.ok) {
        prior = res;
        lostFrames = 0;
        lastLockAt = Date.now();
        report(res, img.width, img.height);
      } else if (prior && ++lostFrames < 3) {
        // einzelne Aussetzer (schnelles Ziehen) noch nicht als verloren werten
      } else {
        if (prior) lostFrame = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height, lastS: prior.s };
        prior = null;
        flow.reset();
        report(null);
      }
      if (failures) status('ready', 'status.ready');
      failures = 0;
    } catch (err) {
      failures++;
      stopCapture();
      const detail = `${(err && err.name) || 'Fehler'}: ${(err && err.message) || err}`;
      api.log(`Bildschirmaufnahme fehlgeschlagen (Versuch ${failures}) – ${detail}`);
      status('capture-error', 'status.captureFailed', { error: detail });
      await sleep(Math.min(10000, 1000 * failures));
      continue;
    }
    // kurz nach einem Verlust ist die Karte meist noch offen → im Nachführ-Takt suchen
    const recentlyLocked = Date.now() - lastLockAt < 3000;
    const fps = flow.active ? FLOW_FPS : settings.fps;
    const interval = prior || recentlyLocked ? 1000 / fps : settings.searchIntervalMs;
    await sleep(Math.max(0, interval - (performance.now() - started)));
  }
  running = false;
  if (!settings.active) {
    stopCapture();
    prior = null;
    if (flow) flow.reset();
    report(null);
    if (matcher) status('paused', 'status.paused');
  }
}

async function applySettings(next) {
  const levelsChanged = settings && (next.levels.join() !== settings.levels.join() || next.tileset.version !== settings.tileset.version);
  settings = next;
  if (levelsChanged) await prepareReference(false);
  if (settings.active && matcher) {
    status('ready', 'status.ready');
    loop();
  }
}

api.on('tracker:settings', (next) => applySettings(next));
api.on('tracker:rebuild', async () => {
  await prepareReference(true);
  if (settings.active) loop();
});
api.on('tracker:restart-capture', () => {
  stopCapture();
  prior = null;
  if (flow) flow.reset();
});

(async () => {
  status('loading', 'status.loading');
  cv = await loadCv();
  settings = await api.settings();
  await prepareReference(false);
  if (settings.active) loop();
  else if (matcher) status('paused', 'status.paused');
})();
