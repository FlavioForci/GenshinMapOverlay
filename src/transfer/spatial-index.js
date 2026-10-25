'use strict';
function check(condition) { if (!condition) throw new Error('invalid-spatial-data'); }
/** Uniform grid with bounded-cell traversal; huge queries scan occupied cells instead.
 * @param {import('./catalog').CatalogPoint[]} markers @param {number} cellSize
 */
function createSpatialIndex(markers, cellSize) {
  check(Number.isFinite(cellSize) && cellSize > 0);
  const cells = new Map();
  for (const marker of markers) {
    check(Number.isFinite(marker.x) && Number.isFinite(marker.y));
    const key = `${Math.floor(marker.x / cellSize)},${Math.floor(marker.y / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(marker);
  }
  return { query(x, y, radius) {
    check(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(radius) && radius >= 0);
    const minX = Math.floor((x - radius) / cellSize), maxX = Math.floor((x + radius) / cellSize);
    const minY = Math.floor((y - radius) / cellSize), maxY = Math.floor((y + radius) / cellSize);
    const result = [];
    const add = rows => { for (const marker of rows || []) if (Math.hypot(marker.x - x, marker.y - y) <= radius) result.push(marker); };
    if (![minX, maxX, minY, maxY].every(Number.isSafeInteger) || (maxX - minX + 1) * (maxY - minY + 1) > cells.size * 4) {
      for (const rows of cells.values()) add(rows);
    } else for (let cx = minX; cx <= maxX; cx++) for (let cy = minY; cy <= maxY; cy++) add(cells.get(`${cx},${cy}`));
    return result;
  } };
}
/** Least-squares affine fit, using centered/scaled QR to avoid squared condition numbers.
 * Coefficient order: [xx, xy, xOffset, yx, yy, yOffset].
 * @param {Array<{source:[number,number],target:[number,number]}>} anchors
 * @returns {[number,number,number,number,number,number]}
 */
function fitAffine(anchors) {
  check(Array.isArray(anchors) && anchors.length >= 3 && anchors.length <= 250000);
  for (const p of anchors) check(p && Array.isArray(p.source) && Array.isArray(p.target) && p.source.length === 2 && p.target.length === 2 && [...p.source, ...p.target].every(Number.isFinite));
  const n = anchors.length;
  const meanX = anchors.reduce((s, p) => s + p.source[0] / n, 0), meanY = anchors.reduce((s, p) => s + p.source[1] / n, 0);
  let sx = 0, sy = 0;
  for (const p of anchors) { sx = Math.max(sx, Math.abs(p.source[0] - meanX)); sy = Math.max(sy, Math.abs(p.source[1] - meanY)); }
  check(sx > 0 && sy > 0);
  const columns = [anchors.map(() => 1), anchors.map(p => (p.source[0] - meanX) / sx), anchors.map(p => (p.source[1] - meanY) / sy)];
  const q = [], r = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let j = 0; j < 3; j++) {
    const v = columns[j].slice();
    for (let k = 0; k < j; k++) { r[k][j] = q[k].reduce((sum, item, i) => sum + item * v[i], 0); for (let i = 0; i < n; i++) v[i] -= r[k][j] * q[k][i]; }
    let squared = 0; for (const value of v) squared += value * value;
    r[j][j] = Math.sqrt(squared); check(r[j][j] > Math.sqrt(n) * 1e-10);
    q.push(v.map(value => value / r[j][j]));
  }
  const solve = dimension => {
    const values = q.map(col => col.reduce((sum, item, i) => sum + item * anchors[i].target[dimension], 0));
    for (let j = 2; j >= 0; j--) { for (let k = j + 1; k < 3; k++) values[j] -= r[j][k] * values[k]; values[j] /= r[j][j]; }
    const a = values[1] / sx, b = values[2] / sy;
    return [a, b, values[0] - a * meanX - b * meanY];
  };
  const coefficients = [...solve(0), ...solve(1)]; check(coefficients.every(Number.isFinite));
  return coefficients;
}
module.exports = { createSpatialIndex, fitAffine };
