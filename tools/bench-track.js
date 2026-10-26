// Messbank für den Tracker: spielt eine Bildfolge in simulierter Echtzeit ab und misst
// Bildrate, Aussetzer, Genauigkeit und Fehler auf dem Bildschirm (mit Verzögerung).
//   node tools/bench-track.js                            künstliche Fahrt aus den Kacheln (Wahrheit bekannt)
//   node tools/bench-track.js --clip testbilder/clips/a  echte Aufnahme (frames.json + truth.json)
//   node tools/bench-track.js --clip … --make-truth      Wahrheit für eine Aufnahme berechnen
// Optionen: --variants "sync;worker"  --seed 3  --runs 2
//   Variante mit Optionen (Werte als JSON): worker&checkMs=250&mask={"purple":true}
//   --fixed  jedes Bild, Prüfung kommt nach 100 ms (wiederholbar, für die Fehlersuche)
//   --trace  jeden Schritt ausgeben  --dump datei  Schritte als JSON
// Fehler in Pixeln eines 1920×1080-Bildschirms (Tracker-Bild 1280 breit × 1,5).
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { DataStore } = require('../src/data/store');
const TILESET = require('../src/data/tileset');
const MatcherCore = require('../src/tracker/matcher-core');
const { TrackerCore } = require('../src/tracker/tracker-core');
const Hud = require('../src/shared/hud');
const { createRenderer } = require('./synth');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const cacheDir = opt('cache', path.join(process.env.APPDATA || '.', 'Genshin Map Overlay', 'cache'));
const store = new DataStore(cacheDir);
const LEVELS = [10, 11, 12, 13, 14];
const W = 1280;
const H = 720;
const SCREEN = 1920 / W;
const WRONG_PX = 20;
const FRAME_MS = 1000 / 30;
const TICK_MS = 1000 / 60;

let seed = Number(opt('seed', 3));
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
// RANSAC nutzt Math.random → für wiederholbare Läufe fest seeden
let mathSeed = 1;
Math.random = () => {
  mathSeed = (mathSeed * 1664525 + 1013904223) % 4294967296;
  return mathSeed / 4294967296;
};

async function loadCv() {
  const mod = require('@techstark/opencv-js');
  if (typeof mod.then === 'function') return mod;
  if (mod.Mat) return mod;
  return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
}

const dist = (a, b) => MatcherCore.fitDistance(a, b, W, H) * SCREEN;
const quant = (list, q) => {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---------- Künstliche Fahrt ----------

// Ziehen in Tracker-Pixeln/s, Zoom wie ein Mausrad-Schritt im Spiel (~200 ms)
const PATH = [
  { hold: 800 },
  { pan: [600, 0], ms: 1000 },
  { hold: 500 },
  { pan: [-400, 300], ms: 800 },
  { zoom: 1.25, ms: 200 }, { hold: 150 }, { zoom: 1.25, ms: 200 }, { hold: 600 },
  { pan: [1400, -600], ms: 600 },
  { hold: 800 },
  { zoom: 0.8, ms: 200 }, { zoom: 0.8, ms: 200 }, { zoom: 0.8, ms: 200 }, { hold: 800 },
  { pan: [0, 900], ms: 700 },
  { hold: 1000 },
];

function makePath(start) {
  const keys = [{ t: 0, ...start }];
  let cur = { ...start };
  let t = 0;
  for (const seg of PATH) {
    const ms = seg.hold || seg.ms;
    if (seg.pan) cur = { ...cur, cx: cur.cx + (seg.pan[0] * ms) / 1000 / cur.s, cy: cur.cy + (seg.pan[1] * ms) / 1000 / cur.s };
    if (seg.zoom) cur = { ...cur, s: cur.s * seg.zoom };
    t += ms;
    keys.push({ t, ...cur });
  }
  const duration = t;
  // weich: Zoom logarithmisch, Bewegung linear im Abschnitt
  const at = (time) => {
    const tt = Math.max(0, Math.min(duration, time));
    let i = 1;
    while (i < keys.length - 1 && keys[i].t < tt) i++;
    const a = keys[i - 1];
    const b = keys[i];
    const f = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 1;
    const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * f);
    const cx = a.cx + (b.cx - a.cx) * f;
    const cy = a.cy + (b.cy - a.cy) * f;
    return { s, tx: W / 2 - s * cx, ty: H / 2 - s * cy, cx, cy };
  };
  return { at, duration };
}

// Feste Szene: Farbstich, Bedienelemente am Rand, Symbole fest auf der Karte
function makeScene(start) {
  const gain = [0.85 + rand() * 0.3, 0.85 + rand() * 0.3, 0.85 + rand() * 0.3];
  const offset = -15 + rand() * 30;
  const icons = [];
  for (let k = 0; k < 220; k++) {
    icons.push({
      x: start.cx + (rand() - 0.5) * 4000,
      y: start.cy + (rand() - 0.5) * 2500,
      r: 7 + Math.round(rand() * 5),
      c: [150 + rand() * 105, 150 + rand() * 105, 150 + rand() * 105],
    });
  }
  return function decorate(cv, mat, view) {
    const d = mat.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] * gain[c] + offset + (rand() - 0.5) * 8;
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    for (const ic of icons) {
      const x = Math.round(view.s * ic.x + view.tx);
      const y = Math.round(view.s * ic.y + view.ty);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      cv.circle(mat, new cv.Point(x, y), ic.r, new cv.Scalar(ic.c[0], ic.c[1], ic.c[2], 255), -1);
      cv.circle(mat, new cv.Point(x, y), 3, new cv.Scalar(30, 30, 30, 255), -1);
    }
    const dark = new cv.Scalar(20, 24, 32, 255);
    for (const [x0, y0, x1, y1] of Hud.rects(W, H)) cv.rectangle(mat, new cv.Point(Math.round(x0), Math.round(y0)), new cv.Point(Math.round(x1), Math.round(y1)), dark, -1);
  };
}

async function syntheticSource(cv) {
  const data = await store.loadMarkers();
  const centers = [];
  for (let i = 0; i < data.markers.count; i++) {
    if (data.types[data.markers.type[i]].key === 'o3') centers.push([data.markers.x[i], data.markers.y[i]]);
  }
  const { renderView } = createRenderer(store);
  // Start an einem Teleporter; die ganze Fahrt muss über der Karte bleiben (kein Schwarz außerhalb)
  let start = null;
  let p = null;
  for (let tries = 0; tries < 300 && !p; tries++) {
    const [cx, cy] = centers[Math.floor(rand() * centers.length)];
    const candidate = { cx, cy, s: 0.7 + rand() * 0.7 };
    const path = makePath(candidate);
    let fine = true;
    for (let t = 0; t <= path.duration && fine; t += 250) {
      const v = path.at(t);
      const small = await renderView(cv, v.cx, v.cy, v.s / 8, W / 8, H / 8);
      let black = 0;
      const d = small.mat.data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) black++;
      small.mat.delete();
      fine = black / (d.length / 4) < 0.05;
    }
    if (fine) {
      start = candidate;
      p = path;
    }
  }
  if (!p) throw new Error('keine Fahrt über Land gefunden');
  const { cx, cy } = start;
  const decorate = makeScene(start);
  const count = Math.floor(p.duration / FRAME_MS);
  return {
    name: `künstlich (Start ${cx.toFixed(0)}/${cy.toFixed(0)}, Zoom ${start.s.toFixed(2)})`,
    frames: Array.from({ length: count }, (_, k) => ({ t: k * FRAME_MS })),
    truthAt: (t) => p.at(t),
    async load(k) {
      const v = p.at(k * FRAME_MS);
      const view = await renderView(cv, v.cx, v.cy, v.s, W, H);
      decorate(cv, view.mat, view.truth);
      const img = { data: new Uint8ClampedArray(view.mat.data), width: W, height: H };
      view.mat.delete();
      return { img, truth: view.truth };
    },
  };
}

// ---------- Echte Aufnahme ----------
// frames.json: { width, height, frames: [{ file, t }] }, Bilder 1280 breit; truth.json: [{ s, tx, ty } | null]

function decode(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

function clipSource(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  const truthFile = path.join(dir, 'truth.json');
  const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : null;
  const t0 = meta.frames[0].t;
  const frames = meta.frames.map((f) => ({ file: path.join(dir, f.file), t: f.t - t0 }));
  return {
    name: `Aufnahme ${path.basename(dir)}`,
    frames,
    truth,
    truthAt: (t) => {
      if (!truth) return null;
      let k = 0;
      while (k + 1 < frames.length && frames[k + 1].t <= t) k++;
      return truth[k];
    },
    async load(k) {
      return { img: decode(frames[k].file), truth: truth ? truth[k] : null };
    },
  };
}

// Wahrheit: jedes Bild einzeln mit voller Grobsuche, dann Feinabgleich mit dem Vorgänger als prior
async function makeTruth(cv, ref, dir) {
  const src = clipSource(dir);
  const strong = new MatcherCore.Matcher(cv, ref, { globalLevels: [10, 11, 12, 13], global: { width: 1280, nfeatures: 2500 } });
  const out = [];
  let prev = null;
  for (let k = 0; k < src.frames.length; k++) {
    const { img } = await src.load(k);
    let r = strong.locate(img.data, img.width, img.height, null);
    if (prev) {
      const p = strong.locate(img.data, img.width, img.height, prev);
      if (p.ok && (!r.ok || p.inliers >= r.inliers)) r = p;
    }
    out.push(r.ok ? { s: r.s, tx: r.tx, ty: r.ty, inliers: r.inliers } : null);
    prev = r.ok ? r : null;
    process.stdout.write(`\r  Wahrheit ${k + 1}/${src.frames.length}`);
  }
  process.stdout.write('\n');
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(out));
  console.log(`  ${out.filter(Boolean).length}/${out.length} Bilder mit Wahrheit → ${path.join(dir, 'truth.json')}`);
}

// ---------- Simulation ----------

// Ablauf wie tracker.js: neuestes Bild holen, verarbeiten, Takt halten.
// worker: Prüfung rechnet sofort, das Ergebnis kommt aber erst nach ihrer Rechenzeit an.
async function simulate(cv, ref, source, spec) {
  const [variant, ...pairs] = spec.split('&');
  const extra = Object.fromEntries(pairs.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), JSON.parse(p.slice(i + 1))]; }));
  const options = { globalLevels: [10, 11, 12, 13], mask: extra.mask || null, globalMask: extra.globalMask };
  const matcher = new MatcherCore.Matcher(cv, ref, options);
  const workerMatcher = new MatcherCore.Matcher(cv, ref, options);
  let simNow = 0;
  let checkCompute = 0;
  const arriving = [];
  const checkMs = [];
  const check = (img, prior) => {
    const t0 = performance.now();
    const r = workerMatcher.locate(img.data, img.width, img.height, prior);
    const ms = performance.now() - t0;
    checkCompute += ms;
    checkMs.push(ms);
    return new Promise((resolve) => arriving.push({ at: simNow + (has('fixed') ? 100 : ms), resolve, value: r }));
  };
  const { hud, ...coreExtra } = extra;
  const core = new TrackerCore(cv, matcher, { exclude: hud === "alt" ? Hud.rects : Hud.trackerRects, ...coreExtra, check: variant === "worker" ? check : null });

  const deliver = async (now) => {
    for (let i = arriving.length - 1; i >= 0; i--) {
      if (arriving[i].at <= now) {
        arriving[i].resolve(arriving[i].value);
        arriving.splice(i, 1);
      }
    }
    await new Promise((r) => setImmediate(r));
  };

  const frames = source.frames;
  const steps = [];
  const reports = [];
  let tFree = 0;
  let lastK = -1;
  let lastLock = -Infinity;
  for (;;) {
    let k = lastK + 1;
    if (k >= frames.length) break;
    if (frames[k].t > tFree) tFree = frames[k].t;
    while (k + 1 < frames.length && frames[k + 1].t <= tFree) k++;
    lastK = k;
    simNow = tFree;
    await deliver(simNow);
    const { img, truth } = await source.load(k);
    checkCompute = 0;
    const w0 = performance.now();
    const res = core.step(img, simNow);
    const ms = performance.now() - w0 - checkCompute;
    const done = simNow + ms;
    steps.push({ k, t: simNow, ms, ok: res.ok, mode: res.mode, why: res.why, inliers: res.inliers, pairs: res.pairs, points: res.points, err: res.ok && truth ? dist(res, truth) : null, est: res.ok ? { s: res.s, tx: res.tx, ty: res.ty } : null });
    if (has('trace')) console.log(`${spec} ${simNow.toFixed(0).padStart(6)} ms  Bild ${String(k).padStart(3)}  ${(res.mode || '').padEnd(13)} ${res.ok ? 'ok  ' : 'NEIN'} ${ms.toFixed(0).padStart(4)} ms  Inlier ${String(res.inliers).padStart(3)}  ${res.ok && truth ? `Fehler ${dist(res, truth).toFixed(1)} px` : res.why || ''}`);
    if (res.ok) {
      reports.push({ t: done, est: { s: res.s, tx: res.tx, ty: res.ty } });
      lastLock = done;
    } else if (!core.locked) {
      reports.push({ t: done, est: null });
    }
    const flowing = core.flow.active;
    const interval = core.locked || done - lastLock < 3000 ? 1000 / (flowing ? 30 : 15) : 500;
    tFree = has('fixed') ? simNow + 0.001 : Math.max(done, simNow + interval);
  }

  // Anzeige mit 60 Hz: was zeigt das Overlay, wie weit liegt es neben der Karte?
  const end = frames[frames.length - 1].t;
  const screenErr = [];
  const stillErr = [];
  const movingErr = [];
  let ticks = 0;
  let shown = 0;
  let wrong = 0;
  let r = -1;
  for (let t = frames[0].t; t <= end; t += TICK_MS) {
    while (r + 1 < reports.length && reports[r + 1].t <= t) r++;
    const truth = source.truthAt(t);
    if (!truth) continue;
    ticks++;
    const est = r >= 0 ? reports[r].est : null;
    if (!est) continue;
    shown++;
    const e = dist(est, truth);
    screenErr.push(e);
    const before = source.truthAt(t - 100);
    (before && dist(before, truth) < 1 ? stillErr : movingErr).push(e);
    if (e > WRONG_PX) wrong++;
  }
  if (opt('dump', null)) fs.writeFileSync(`${opt('dump')}-${spec.replace(/[^A-Za-z0-9]+/g, "_")}.json`, JSON.stringify(steps));
  const okReports = reports.filter((x) => x.est);
  const gaps = okReports.slice(1).map((x, i) => x.t - okReports[i].t);
  const acc = steps.filter((s) => s.err !== null).map((s) => s.err);
  return {
    variant: spec,
    updatesPerSec: okReports.length / ((end - frames[0].t) / 1000),
    gapP95: quant(gaps, 0.95),
    gapMax: gaps.length ? Math.max(...gaps) : NaN,
    accP50: quant(acc, 0.5),
    accP95: quant(acc, 0.95),
    accBadPct: (100 * acc.filter((e) => e > 50).length) / Math.max(1, acc.length),
    screenP50: quant(screenErr, 0.5),
    screenP95: quant(screenErr, 0.95),
    screenMax: screenErr.length ? Math.max(...screenErr) : NaN,
    stillP95: quant(stillErr, 0.95),
    movingP50: quant(movingErr, 0.5),
    movingP95: quant(movingErr, 0.95),
    shownPct: (100 * shown) / Math.max(1, ticks),
    wrongPct: (100 * wrong) / Math.max(1, ticks),
    stepP50: quant(steps.map((s) => s.ms), 0.5),
    stepMax: Math.max(...steps.map((s) => s.ms)),
    checkP50: quant(checkMs, 0.5),
    modes: steps.reduce((m, s) => ({ ...m, [s.mode]: (m[s.mode] || 0) + 1 }), {}),
  };
}

function printTable(rows) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const lines = [
    ['Variante', 'Updates/s', 'Lücke p95/max ms', 'Erkennung p50/p95 px', '>50 px %', 'Bildschirm p50/p95/max px', 'still p95 px', 'Bewegung p50/p95 px', 'sichtbar %', 'falsch %', 'Schritt p50/max ms', 'Prüfung ms'],
    ...rows.map((x) => [
      x.variant, f(x.updatesPerSec), `${f(x.gapP95, 0)}/${f(x.gapMax, 0)}`, `${f(x.accP50)}/${f(x.accP95)}`, f(x.accBadPct),
      `${f(x.screenP50)}/${f(x.screenP95)}/${f(x.screenMax, 0)}`, f(x.stillP95), `${f(x.movingP50)}/${f(x.movingP95)}`, f(x.shownPct), f(x.wrongPct), `${f(x.stepP50)}/${f(x.stepMax, 0)}`, f(x.checkP50, 0),
    ]),
  ];
  const widths = lines[0].map((_, c) => Math.max(...lines.map((l) => String(l[c]).length)));
  for (const l of lines) console.log(l.map((v, c) => String(v).padEnd(widths[c])).join('  '));
}

(async () => {
  const cv = await loadCv();
  const file = path.join(cacheDir, 'reference', `refdb-v1-${TILESET.version}-${LEVELS.join('_')}.bin`);
  const ref = MatcherCore.deserializeReference(fs.readFileSync(file)).ref;
  const clip = opt('clip', null);
  if (clip && has('make-truth')) {
    await makeTruth(cv, ref, clip);
    return;
  }
  const variants = opt('variants', 'sync;worker').split(';');
  const runs = Number(opt('runs', 1));
  for (let run = 0; run < runs; run++) {
    const startSeed = seed;
    const rows = [];
    let name = '';
    for (const v of variants) {
      seed = startSeed;
      mathSeed = startSeed + 1;
      const source = clip ? clipSource(clip) : await syntheticSource(cv);
      name = source.name;
      rows.push(await simulate(cv, ref, source, v));
    }
    console.log(`\n${name}`);
    printTable(rows);
    for (const x of rows) console.log(`  ${x.variant}: Schritte ${JSON.stringify(x.modes)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
