// Unsichtbares Tracker-Fenster: Aufnahme + Bildvergleich, Ergebnis an den Hauptprozess.
// Ablauf (Fluss, Verankern, Drift) in tracker-core.js, Drift-Prüfung im Worker (check-worker.js).
/* global MatcherCore, ReferenceBuilder, TrackerCore, Hud */
const api = window.trackerApi;
const CAPTURE_WIDTH = 1280;
const FLOW_FPS = 30;
// Abgestimmt mit tools/bench-track.js an einer echten Kartenfahrt (Inazuma, viele Symbole):
// - Maske gegen Spiel-Symbole: lila, graue Ränder, dunkles Meer, breiterer Rand; Grobsuche ohne prior mit alter Maske
// - Worker prüft alle 250 ms, sicherer Treffer (≥ 30 Inlier) korrigiert sofort; ohne Worker wie bisher 1 s
const MASK = { purple: true, erode: 13, gray: 70, sea: 80 };
const CHECK_MS_WORKER = 250;
const CHECK_MS_INLINE = 1000;

let cv = null;
let settings = null;
let matcher = null;
let core = null;
let checker = null;
let checkSeq = 0;
let reader = null;
let stream = null;
let frameCanvas = null;
let frameCtx = null;
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

// ---------- Drift-Prüfung im Worker ----------
// Ohne Worker (Fehler beim Start) prüft der Kern wie bisher im selben Bild.

function stopChecker() {
  if (checker) {
    checker.worker.terminate();
    for (const waiting of checker.waiting.values()) waiting.reject(new Error('Worker beendet'));
  }
  checker = null;
  if (core) {
    core.o.check = null;
    core.o.checkMs = CHECK_MS_INLINE;
  }
}

function startChecker(bytes, options) {
  stopChecker();
  try {
    const worker = new Worker('check-worker.js');
    const c = { worker, ready: false, waiting: new Map() };
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        c.ready = true;
        if (core && checker === c) {
          core.o.check = checkInWorker;
          core.o.checkMs = CHECK_MS_WORKER;
        }
      } else if (msg.type === 'result') {
        const waiting = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
        if (waiting) waiting.resolve(msg.res);
      }
    };
    worker.onerror = (event) => {
      api.log(`Prüf-Worker ausgefallen – ${event.message || 'unbekannt'}`);
      if (checker === c) stopChecker();
    };
    const copy = bytes.slice();
    worker.postMessage({ type: 'init', bytes: copy.buffer, options }, [copy.buffer]);
    checker = c;
  } catch (err) {
    api.log(`Prüf-Worker nicht gestartet – ${err.message}`);
  }
}

function checkInWorker(img, prior) {
  return new Promise((resolve, reject) => {
    if (!checker || !checker.ready) {
      reject(new Error('Worker nicht bereit'));
      return;
    }
    const id = ++checkSeq;
    const copy = new Uint8ClampedArray(img.data);
    checker.waiting.set(id, { resolve, reject });
    checker.worker.postMessage({
      type: 'check', id, data: copy.buffer, width: img.width, height: img.height,
      prior: { s: prior.s, tx: prior.tx, ty: prior.ty },
    }, [copy.buffer]);
  });
}

async function prepareReference(force) {
  building = true;
  matcher = null;
  try {
    const key = referenceKey();
    const cached = force ? null : await api.loadReference(key);
    let ref;
    let bytes;
    if (cached && cached.length) {
      bytes = cached;
      ref = MatcherCore.deserializeReference(cached).ref;
    } else {
      status('download', 'status.downloadStart');
      await api.prefetch(settings.levels);
      status('building', 'status.building', { percent: 0 });
      ref = await ReferenceBuilder.build(cv, settings.tileset, settings.levels, tileRgba, null, (done, total) => {
        const p = done / total;
        status('building', 'status.building', { percent: Math.round(p * 100) }, p);
      });
      bytes = MatcherCore.serializeReference(ref, { levels: settings.levels, tileset: settings.tileset.version });
      await api.saveReference(key, bytes);
      tileCache.clear();
    }
    // Stufen 14+ nur fürs Nachführen, hält die Grobsuche schnell
    const coarse = settings.levels.filter((z) => z <= 13);
    const options = { globalLevels: coarse.length ? coarse : null, mask: MASK, globalMask: null };
    matcher = new MatcherCore.Matcher(cv, ref, options);
    if (core) core.reset();
    core = new TrackerCore.TrackerCore(cv, matcher, { exclude: Hud.trackerRects, mask: MASK, trustInliers: 30, checkMs: CHECK_MS_INLINE });
    startChecker(bytes, options);
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
      const wasLocked = core.locked;
      const prior = core.prior;
      const res = core.step(img, performance.now());
      recent.push({ t: Date.now(), mode: res.mode, ok: res.ok, inliers: res.inliers, pairs: res.pairs, spread: res.spread, s: res.s, ms: res.ms });
      if (recent.length > 240) recent.shift();
      if (res.ok) {
        lastLockAt = Date.now();
        report(res, img.width, img.height);
      } else if (!core.locked) {
        if (wasLocked) lostFrame = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height, lastS: prior.s };
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
    const fps = core.flow.active ? FLOW_FPS : settings.fps;
    const interval = core.locked || recentlyLocked ? 1000 / fps : settings.searchIntervalMs;
    await sleep(Math.max(0, interval - (performance.now() - started)));
  }
  running = false;
  if (!settings.active) {
    stopCapture();
    if (core) core.reset();
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
  if (core) core.reset();
});

(async () => {
  status('loading', 'status.loading');
  cv = await loadCv();
  settings = await api.settings();
  await prepareReference(false);
  if (settings.active) loop();
  else if (matcher) status('paused', 'status.paused');
})();
