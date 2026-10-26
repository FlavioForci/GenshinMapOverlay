// Messbank für die Minimap-Verfolgung an einer Aufnahme mit Minimap-Ecke (tools/record.js --minimap).
//   node tools/bench-minimap.js testbilder/clips/welt1 [--step 2] [--options '{"search":24}']
// - große Karte je Bild erkannt (einmal berechnet, gespeichert in bigmap-full.json)
// - Anker = Kartenmitte bei der ersten Erkennung jeder Kartenphase (Karte öffnet auf die Spielfigur zentriert)
// - Prüfung: am Ende jedes Weltabschnitts muss die Verfolgung den Anker der nächsten Kartenphase treffen
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { DataStore } = require('../src/data/store');
const TILESET = require('../src/data/tileset');
const MatcherCore = require('../src/tracker/matcher-core');
const { MinimapTracker, GEOMETRY } = require('../src/tracker/minimap-core');
const { createRenderer } = require('./synth');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dir = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const STEP = Number(opt('step', 2));
const FRAME_MS = 1000 / 30;
const cacheDir = path.join(process.env.APPDATA || '.', 'Genshin Map Overlay', 'cache');

async function loadCv() {
  const mod = require('@techstark/opencv-js');
  if (typeof mod.then === 'function') return mod;
  if (mod.Mat) return mod;
  return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
}

// Große Karte offen? Pro Bild ok + Kartenmitte (Kartenpixel), mit Vorgänger als prior
async function bigMap(cv, meta) {
  const file = path.join(dir, 'bigmap-full.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const ref = MatcherCore.deserializeReference(fs.readFileSync(path.join(cacheDir, 'reference', `refdb-v1-${TILESET.version}-10_11_12_13_14.bin`))).ref;
  const m = new MatcherCore.Matcher(cv, ref, { globalLevels: [10, 11, 12, 13] });
  const out = [];
  let prior = null;
  for (let k = 0; k < meta.frames.length; k++) {
    const j = jpeg.decode(fs.readFileSync(path.join(dir, meta.frames[k].file)), { useTArray: true, formatAsRGBA: true });
    const r = m.locate(j.data, j.width, j.height, prior);
    prior = r.ok ? r : null;
    out.push(r.ok ? { x: (j.width / 2 - r.tx) / r.s, y: (j.height / 2 - r.ty) / r.s } : null);
    if (k % 50 === 0) process.stdout.write(`\r  große Karte ${k}/${meta.frames.length}`);
  }
  process.stdout.write('\n');
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// Minimap-Ecke auf 1080p bringen
// --height 768: kleinere Auflösung nachstellen (Ecke herunterrechnen, wie im Tracker wieder auf 1080p hoch)
const SIM_HEIGHT = Number(opt('height', 0));

function corner(cv, meta, k) {
  const p = PNG.sync.read(fs.readFileSync(path.join(dir, meta.frames[k].corner)));
  if (SIM_HEIGHT) {
    const m = new cv.Mat(p.height, p.width, cv.CV_8UC4);
    m.data.set(p.data);
    const f = SIM_HEIGHT / meta.crop.frameH;
    const small = new cv.Mat();
    cv.resize(m, small, new cv.Size(Math.round(p.width * f), Math.round(p.height * f)), 0, 0, cv.INTER_AREA);
    const out = new cv.Mat();
    const c = GEOMETRY.corner;
    cv.resize(small, out, new cv.Size(c.w, c.h), 0, 0, cv.INTER_LINEAR);
    const res = { data: new Uint8ClampedArray(out.data), width: c.w, height: c.h };
    [m, small, out].forEach((x) => x.delete());
    return res;
  }
  const kx = meta.crop.frameH / 1080;
  if (Math.abs(kx - 1) < 1e-6) return { data: p.data, width: p.width, height: p.height };
  const m = new cv.Mat(p.height, p.width, cv.CV_8UC4);
  m.data.set(p.data);
  const out = new cv.Mat();
  const c = GEOMETRY.corner;
  cv.resize(m, out, new cv.Size(c.w, c.h), 0, 0, cv.INTER_AREA);
  const res = { data: new Uint8ClampedArray(out.data), width: c.w, height: c.h };
  m.delete();
  out.delete();
  return res;
}

(async () => {
  const cv = await loadCv();
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  if (!meta.crop) throw new Error('Aufnahme ohne Minimap-Ecke (record.js --minimap)');
  const big = await bigMap(cv, meta);
  const { renderView } = createRenderer(new DataStore(cacheDir));
  const render = async (cx, cy, scale, size) => {
    const v = await renderView(cv, cx, cy, scale, size, size);
    const img = { data: new Uint8ClampedArray(v.mat.data), width: size, height: size };
    v.mat.delete();
    return img;
  };
  const tracker = new MinimapTracker(cv, render, { waitRender: true, ...JSON.parse(opt('options', '{}')) });

  // Kartenphasen und Anker
  const phases = [];
  for (let k = 0; k < big.length; k++) {
    if (big[k] && (k === 0 || !big[k - 1])) phases.push({ from: k, anchor: big[k] });
    if (big[k] && phases.length) phases[phases.length - 1].to = k;
  }

  const rows = [];
  const times = [];
  let seg = null;
  let pending = null;
  for (let k = 0; k < big.length; k++) {
    const now = k * FRAME_MS;
    if (big[k]) {
      if (!big[k - 1]) {
        // Phase beginnt: laufenden Abschnitt gegen diesen Anker prüfen
        if (seg) {
          const e = tracker.active ? Math.hypot(tracker.pos.x - big[k].x, tracker.pos.y - big[k].y) : NaN;
          rows.push({ ...seg, to: k - 1, err: e, scale: tracker.scale, walked: Math.hypot(big[k].x - seg.ax, big[k].y - seg.ay) });
          seg = null;
        }
        pending = big[k];
      }
      continue;
    }
    if (pending) {
      tracker.start(pending.x, pending.y, now);
      seg = { from: k, ax: pending.x, ay: pending.y, steps: 0, ok: 0, corr: [], scales: {} };
      pending = null;
    }
    if (!seg || (k - seg.from) % STEP) continue;
    const t0 = performance.now();
    const r = await tracker.step(corner(cv, meta, k), now);
    times.push(performance.now() - t0);
    seg.steps++;
    if (r.ok) {
      seg.ok++;
      seg.scales[r.scale] = (seg.scales[r.scale] || 0) + 1;
    }
    if (Number.isFinite(r.corr)) seg.corr.push(r.corr);
  }

  console.log(`${path.basename(dir)}: ${phases.length} Kartenphasen, Schritt alle ${STEP} Bilder`);
  for (const r of rows) {
    const c = [...r.corr].sort((a, b) => a - b);
    console.log(`  Bild ${r.from}-${r.to}: ${r.steps} Schritte, sicher ${((100 * r.ok) / Math.max(1, r.steps)).toFixed(0)} %, Korr median ${c.length ? c[c.length >> 1].toFixed(2) : '-'}, Zoom ${JSON.stringify(r.scales)}, Ende neben Anker ${Number.isFinite(r.err) ? `${r.err.toFixed(2)} Kartenpx = ${(r.err * r.scale).toFixed(1)} px auf der Minimap` : 'verloren'} (gelaufen ${r.walked.toFixed(1)} Kartenpx)`);
  }
  const ts = [...times].sort((a, b) => a - b);
  const errs = rows.filter((r) => Number.isFinite(r.err)).map((r) => r.err * r.scale);
  console.log(`  Ende-Fehler im Mittel ${(errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)).toFixed(1)} px auf der Minimap, verloren ${rows.length - errs.length}/${rows.length}; Zeit je Schritt median ${ts[ts.length >> 1].toFixed(1)} ms, max ${ts[ts.length - 1].toFixed(0)} ms`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
