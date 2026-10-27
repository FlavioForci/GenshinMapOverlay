'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fitAffine, createSpatialIndex } = require('../../src/transfer/spatial-index');
const { normalizeCatalog } = require('../../src/transfer/providers/hoyolab/normalize');
const { decodeMarkers } = require('../../src/data/store');
const { canonicalCatalog } = require('../../src/transfer/catalog');
const { packageSourcePairs } = require('./source-pairs');

// These classes represent one-time exploration progress. Resource, fish and
// enemy classes never enter this reviewed correspondence set.
const CATEGORIES = [2, 3, 5, 6, 8, 9, 17, 18, 44, 45, 46, 64, 69, 75, 141, 148, 194, 205, 212, 269, 403, 411, 508, 509, 554, 577, 626, 694, 703, 806, 833, 835];
const BASE = [11646.403163584597, -0.31895268049174774, -6087.385643159917, -0.017687459575813354, -11646.509633465248, 2323.02157278935];
const transform = (p, c) => ({ ...p, x: c[0] * p.x + c[1] * p.y + c[2], y: c[3] * p.x + c[4] * p.y + c[5] });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function nearest(rows, point, radius, margin) {
  const ranked = rows.map(row => ({ row, d: distance(row, point) })).sort((a, b) => a.d - b.d);
  return ranked[0]?.d <= radius && (!ranked[1] || ranked[1].d - ranked[0].d >= margin) ? ranked[0] : null;
}
function rawCanonical(snapshot) {
  const cols = snapshot.data, result = []; let id = 0;
  for (let i = 0; i < cols.id.length; i++) {
    id = snapshot.encoding?.delta?.includes('id') ? id + cols.id[i] : cols.id[i];
    if (cols.mid[i] === 2) result.push({ id: String(id), category: cols.type[i], x: Number(cols.lng[i]), y: Number(cols.lat[i]), layered: /(?:^|;)l=/.test(cols.meta[i] || '') });
  }
  return result;
}
function calibrate(name, category, offset, source, canonical, areaIds) {
  const initial = [...BASE]; initial[2] += offset;
  const h = source.filter(row => row.label_id === category && areaIds.includes(row.area_id)).map(row => ({ id: String(row.id), x: row.x_pos, y: row.y_pos }));
  const a = canonical.filter(row => row.category === 'o' + category).sort((a, b) => Number(a.id) - Number(b.id));
  const candidates = [];
  for (const row of a) {
    const predicted = transform(row, initial), match = nearest(h, predicted, 0.6, 2);
    if (match) candidates.push({ source: [row.x, row.y], target: [match.row.x, match.row.y], sourceId: row.id, canonicalId: match.row.id });
  }
  if (candidates.length < 24 || new Set(candidates.map(row => row.canonicalId)).size !== candidates.length) throw new Error('calibration-insufficient');
  const anchors = candidates.filter((_, i) => i % 2 === 0), heldOut = candidates.filter((_, i) => i % 2 === 1);
  const coefficients = fitAffine(anchors);
  const residual = p => distance(transform({ x: p.source[0], y: p.source[1] }, coefficients), { x: p.target[0], y: p.target[1] });
  const maxHeldOut = Math.max(...heldOut.map(residual));
  if (maxHeldOut > 0.35) throw new Error('held-out-calibration-failed');
  return { name, areaIds, coefficients, anchors, heldOut, maxHeldOut };
}
function buildHoYoLabPairs({ native, snapshot, names }) {
  const sourceCatalog = normalizeCatalog(native.data.point_list), source = native.data.point_list, canonical = rawCanonical(snapshot);
  const labels = new Set(CATEGORIES.map(String));
  const models = [calibrate('mainland', 5, 0, source, canonical, [1]),
    calibrate('inazuma', 194, 2203.34, source, canonical, [3]),
    calibrate('natlan-volcano', 626, -2000, source, canonical, [11])];
  models[0].areaIds = [1, 2, 4, 8, 11, 13, 16];
  const candidates = [], stats = {};
  for (const category of labels) {
    const h = source.filter(row => String(row.label_id) === category).map(row => ({ ...row, id: String(row.id), x: row.x_pos, y: row.y_pos }));
    const a = canonical.filter(row => row.category === 'o' + category);
    const hIndex = createSpatialIndex(h, 3);
    const projected = models.map(model => { const points = a.map(row => transform(row, model.coefficients)); return { model, index: createSpatialIndex(points, 3) }; });
    for (const row of h) {
      if (row.z_level !== 0 || row.point_group !== null) continue;
      const possible = [];
      for (const { model, index } of projected) {
        if (!model.areaIds.includes(row.area_id)) continue;
        const forward = nearest(index.query(row.x, row.y, 2.6), row, 0.6, 2);
        if (!forward || forward.row.layered) continue;
        const reverse = nearest(hIndex.query(forward.row.x, forward.row.y, 2.6), forward.row, 0.6, 2);
        if (reverse?.row.id !== row.id) continue;
        possible.push({ sourceId: row.id, canonicalId: forward.row.id, model: model.name, residual: forward.d });
      }
      if (possible.length === 1) { candidates.push(possible[0]); stats[possible[0].model] = (stats[possible[0].model] || 0) + 1; }
    }
  }
  // A target claimed through multiple regional models is uncertain, regardless
  // of whether both observations were present in a player's save.
  const count = new Map(); for (const row of candidates) count.set(row.canonicalId, (count.get(row.canonicalId) || 0) + 1);
  const unique = candidates.filter(row => count.get(row.canonicalId) === 1).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const catalog = canonicalCatalog(decodeMarkers(snapshot, names, 'en'));
  return { ...packageSourcePairs({ provider: 'hoyolab', map: 'hoyolab:ys_obc:2', sourceCatalog, canonicalCatalog: catalog, candidates: unique }),
    report: { models, counts: stats, accepted: unique.length, maxResidual: Math.max(...unique.map(row => row.residual)), categories: CATEGORIES }, candidates: unique };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('usage: hoyolab-pairs INPUT_DIRECTORY OUTPUT_DIRECTORY');
  const read = file => JSON.parse(fs.readFileSync(path.join(input, file), 'utf8'));
  const result = buildHoYoLabPairs({ native: read('hoyolab-catalog.json'), snapshot: read('appsample-catalog.json'), names: read('appsample-names.json') });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'mapping.json'), JSON.stringify(result.pack));
  fs.writeFileSync(path.join(output, 'mapping-targets.json'), JSON.stringify(result.targets));
  fs.writeFileSync(path.join(input, 'hoyolab-pair-report.json'), JSON.stringify({ ...result.report, candidates: result.candidates }, null, 2));
  process.stdout.write(JSON.stringify({ accepted: result.report.accepted, models: result.report.counts, maxResidual: result.report.maxResidual }) + '\n');
}
module.exports = { buildHoYoLabPairs };
