// Künstliche Kartenbilder aus den Kacheln, für match-test.js und bench-track.js.
const jpeg = require('jpeg-js');

function createRenderer(store) {
  const tileCache = new Map();

  async function tileRgba(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const bytes = await store.tile(z, x, y);
    const rgba = bytes ? jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true }).data : null;
    if (tileCache.size > 2500) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, rgba);
    return rgba;
  }

  // Ausschnitt um Kartenpunkt cx/cy; s = Bildschirmpixel je Kartenpixel
  async function renderView(cv, cx, cy, s, W, H) {
    const x0 = cx - W / (2 * s);
    const y0 = cy - H / (2 * s);
    const zs = Math.min(15, Math.max(11, 13 + Math.ceil(Math.log2(s) - 0.25)));
    const srcPerMap = 2 ** (zs - 13);
    const sx0 = x0 * srcPerMap;
    const sy0 = y0 * srcPerMap;
    const sx1 = (x0 + W / s) * srcPerMap;
    const sy1 = (y0 + H / s) * srcPerMap;
    const tx0 = Math.floor(sx0 / 256);
    const ty0 = Math.floor(sy0 / 256);
    const tx1 = Math.floor(sx1 / 256);
    const ty1 = Math.floor(sy1 / 256);
    const mw = (tx1 - tx0 + 1) * 256;
    const mh = (ty1 - ty0 + 1) * 256;
    const mosaic = new cv.Mat(mh, mw, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 255));
    const half = 2 ** (zs - 1);
    const needed = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) needed.push([tx, ty]);
    await Promise.all(needed.map(([tx, ty]) => tileRgba(zs, tx - half, half - ty - 1).catch(() => null)));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = await tileRgba(zs, tx - half, half - ty - 1).catch(() => null);
        if (!tile) continue;
        for (let row = 0; row < 256; row++) {
          mosaic.data.set(tile.subarray(row * 1024, row * 1024 + 1024), (((ty - ty0) * 256 + row) * mw + (tx - tx0) * 256) * 4);
        }
      }
    }
    const roi = mosaic.roi(new cv.Rect(Math.round(sx0 - tx0 * 256), Math.round(sy0 - ty0 * 256), Math.round(sx1 - sx0), Math.round(sy1 - sy0)));
    const out = new cv.Mat();
    cv.resize(roi, out, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    roi.delete();
    mosaic.delete();
    return { mat: out, truth: { s, tx: -s * x0, ty: -s * y0 } };
  }

  return { tileRgba, renderView };
}

module.exports = { createRenderer };
