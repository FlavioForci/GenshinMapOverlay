// Testet die Kartenerkennung.
//   node tools/match-test.js                    künstliche Screenshots aus den Kacheln
//   node tools/match-test.js testbilder/*.png   echte Screenshots, mit Markern → testbilder/out
//   node tools/match-test.js --render a.png     Kartenbild um einen Teleporter (Test ohne Spiel)
// Optionen: --levels 11,12,13  --count 10  --seed 1
//   zu --render: --zoom 0.8  --pick 5  --size 2400x1350
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { DataStore } = require('../src/data/store');
const TILESET = require('../src/data/tileset');
const MatcherCore = require('../src/tracker/matcher-core');
const ReferenceBuilder = require('../src/tracker/reference-builder');
const { createRenderer } = require('./synth');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const levels = opt('levels', '10,11,12,13,14').split(',').map(Number);
// Läuft oft neben dem Spiel, darum niedrige Priorität.
require('os').setPriority(require('os').constants.priority.PRIORITY_BELOW_NORMAL);
const cacheDir = opt('cache', path.join(process.env.APPDATA || '.', 'Genshin Map Overlay', 'cache'));
const store = new DataStore(cacheDir);

let seed = Number(opt('seed', 1));
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

async function loadCv() {
  const mod = require('@techstark/opencv-js');
  if (typeof mod.then === 'function') return mod;
  if (mod.Mat) return mod;
  return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
}

const { tileRgba, renderView } = createRenderer(store);

async function loadReference(cv) {
  const file = path.join(cacheDir, 'reference', `refdb-v1-${TILESET.version}-${levels.join('_')}.bin`);
  if (fs.existsSync(file)) return MatcherCore.deserializeReference(fs.readFileSync(file)).ref;
  console.log(`Referenz wird gebaut (Zoomstufen ${levels.join(', ')}) …`);
  const started = Date.now();
  await store.prefetchTiles(levels, (done, total) => {
    if (done % 50 === 0 || done === total) process.stdout.write(`\r  Kacheln ${done}/${total}`);
  });
  process.stdout.write('\n');
  const ref = await ReferenceBuilder.build(cv, TILESET, levels, tileRgba, null, (done, total) => {
    process.stdout.write(`\r  Block ${done}/${total}`);
  });
  process.stdout.write('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, MatcherCore.serializeReference(ref, { levels, tileset: TILESET.version }));
  console.log(`  ${ref.count} Merkmale in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return ref;
}

// Spielähnlicher machen: Farbstich, Rauschen, UI-Balken, Symbole.
function distort(cv, mat) {
  const W = mat.cols;
  const H = mat.rows;
  const d = mat.data;
  const gain = [0.8 + rand() * 0.4, 0.8 + rand() * 0.4, 0.8 + rand() * 0.4];
  const offset = -20 + rand() * 40;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] * gain[c] + offset + (rand() - 0.5) * 18;
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  const dark = new cv.Scalar(20, 24, 32, 255);
  cv.rectangle(mat, new cv.Point(0, 0), new cv.Point(Math.round(W * 0.05), H), dark, -1);
  cv.rectangle(mat, new cv.Point(Math.round(W * 0.88), Math.round(H * 0.2)), new cv.Point(W, Math.round(H * 0.8)), dark, -1);
  cv.rectangle(mat, new cv.Point(0, 0), new cv.Point(W, Math.round(H * 0.06)), dark, -1);
  for (let k = 0; k < 60; k++) {
    const p = new cv.Point(Math.round(rand() * W), Math.round(rand() * H));
    const color = new cv.Scalar(150 + rand() * 105, 150 + rand() * 105, 150 + rand() * 105, 255);
    cv.circle(mat, p, 9 + Math.round(rand() * 8), color, -1);
    cv.circle(mat, p, 4, new cv.Scalar(30, 30, 30, 255), -1);
  }
}

function reprojectionError(res, truth, W, H) {
  let worst = 0;
  for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]]) {
    const mx = (px - truth.tx) / truth.s;
    const my = (py - truth.ty) / truth.s;
    worst = Math.max(worst, Math.hypot(res.s * mx + res.tx - px, res.s * my + res.ty - py));
  }
  return worst;
}

async function synthetic(cv, matcher) {
  const data = await store.loadMarkers();
  const centers = [];
  for (let i = 0; i < data.markers.count; i++) {
    if (data.types[data.markers.type[i]].key === 'o3') centers.push([data.markers.x[i], data.markers.y[i]]);
  }
  const W = 1920;
  const H = 1080;
  const count = Number(opt('count', 10));
  let globalOk = 0;
  let trackOk = 0;
  for (let k = 0; k < count; k++) {
    const [cx, cy] = centers[Math.floor(rand() * centers.length)];
    const s = 2 ** (-1.5 + rand() * 2.5);
    const view = await renderView(cv, cx, cy, s, W, H);
    distort(cv, view.mat);
    const res = matcher.locate(view.mat.data, W, H, null);
    const err = res.s ? reprojectionError(res, view.truth, W, H) : Infinity;
    const good = res.ok && err < 15;
    if (good) globalOk++;
    console.log(`#${k} zoom ${s.toFixed(2)}  global: ${res.ok ? 'ok ' : 'NEIN'} Fehler ${err.toFixed(1)} px, ${res.inliers}/${res.pairs} Paare, Streuung ${res.spread.map((v) => v.toFixed(2)).join('/')}, ${res.ms} ms [Merkmale ${res.timing.detect}, Abgleich ${res.timing.match}] [z${res.levels.join(",")}]`);
    view.mat.delete();

    if (good) {
      // Leicht verschoben/gezoomt, wie beim Ziehen der Karte im Spiel.
      const s2 = s * (0.9 + rand() * 0.2);
      const next = await renderView(cv, cx + (rand() - 0.5) * 300 / s, cy + (rand() - 0.5) * 200 / s, s2, W, H);
      distort(cv, next.mat);
      const tr = matcher.locate(next.mat.data, W, H, res);
      const err2 = tr.s ? reprojectionError(tr, next.truth, W, H) : Infinity;
      if (tr.ok && err2 < 15) trackOk++;
      console.log(`     nachgeführt: ${tr.ok ? 'ok ' : 'NEIN'} Fehler ${err2.toFixed(1)} px, ${tr.inliers}/${tr.pairs} Paare, ${tr.ms} ms [Merkmale ${tr.timing.detect}, Abgleich ${tr.timing.match}] [z${tr.levels.join(",")}]`);
      next.mat.delete();
    }
  }
  console.log(`\nErgebnis: global ${globalOk}/${count}, nachgeführt ${trackOk}/${globalOk}`);
}

function decodeImage(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { data: img.data, width: img.width, height: img.height };
}

async function realImages(cv, matcher) {
  const data = await store.loadMarkers();
  const showTypes = new Set(['o3', 'o2', 'o5', 'o6', 'o141', 'o194', 'o403', 'o508', 'o626', 'o833']);
  for (const file of files) {
    const img = decodeImage(file);
    const res = matcher.locate(img.data, img.width, img.height, null);
    console.log(`${path.basename(file)} (${img.width}×${img.height}): ${res.ok ? 'erkannt' : 'NICHT erkannt'} – zoom ${res.s.toFixed(3)}, ${res.inliers}/${res.pairs} Paare, Streuung ${res.spread.map((v) => v.toFixed(2)).join('/')}, ${res.ms} ms`);
    if (!res.s) continue;

    // Marker einzeichnen, zum Prüfen per Auge.
    const png = new PNG({ width: img.width, height: img.height });
    png.data.set(img.data);
    let drawn = 0;
    for (let i = 0; i < data.markers.count; i++) {
      if (!showTypes.has(data.types[data.markers.type[i]].key)) continue;
      const x = Math.round(res.s * data.markers.x[i] + res.tx);
      const y = Math.round(res.s * data.markers.y[i] + res.ty);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      drawn++;
      for (let dy = -9; dy <= 9; dy++) {
        for (let dx = -9; dx <= 9; dx++) {
          const r = Math.hypot(dx, dy);
          if (r < 7 || r > 9) continue;
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          const o = (py * img.width + px) * 4;
          png.data[o] = 255;
          png.data[o + 1] = 40;
          png.data[o + 2] = 200;
          png.data[o + 3] = 255;
        }
      }
    }
    const outDir = path.join(path.dirname(file), 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, path.basename(file).replace(/\.\w+$/, '.png'));
    fs.writeFileSync(outFile, PNG.sync.write(png));
    console.log(`   ${drawn} Marker eingezeichnet → ${outFile}`);
  }
}

async function renderToFile(cv) {
  const data = await store.loadMarkers();
  const centers = [];
  for (let i = 0; i < data.markers.count; i++) {
    if (data.types[data.markers.type[i]].key === 'o3') centers.push([data.markers.x[i], data.markers.y[i]]);
  }
  const [cx, cy] = centers[Number(opt('pick', 0)) % centers.length];
  const s = Number(opt('zoom', 0.8));
  const [W, H] = opt('size', '2400x1350').split('x').map(Number);
  const view = await renderView(cv, cx, cy, s, W, H);
  const png = new PNG({ width: W, height: H });
  png.data.set(view.mat.data);
  view.mat.delete();
  fs.writeFileSync(opt('render'), PNG.sync.write(png));
  console.log(`gespeichert: ${opt('render')} (Mitte ${cx.toFixed(0)}/${cy.toFixed(0)}, Zoom ${s})`);
}

(async () => {
  const cv = await loadCv();
  if (opt('render')) {
    await renderToFile(cv);
    return;
  }
  const ref = await loadReference(cv);
  const perLevel = ref.levels.map((z) => `z${z}: ${ref.level.filter((l) => l === z).length}`).join(', ');
  console.log(`Referenz: ${ref.count} Merkmale (${perLevel})`);
  const coarse = levels.filter((z) => z <= 13);
  const matcherOptions = { globalLevels: coarse.length ? coarse : null, ...JSON.parse(opt('options', '{}')) };
  const matcher = new MatcherCore.Matcher(cv, ref, matcherOptions);
  if (files.length) await realImages(cv, matcher);
  else await synthetic(cv, matcher);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
