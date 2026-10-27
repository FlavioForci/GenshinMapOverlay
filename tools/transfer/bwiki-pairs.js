'use strict';

// Offline review aid. This never reads a save, writes a destination or enables
// a runtime transform. Only explicitly returned, subsequently reviewed pairs
// may enter a row-bound mapping pack. See the dated BWIKI research document.
const { normalizeCatalog } = require('../../src/transfer/providers/bwiki/normalize');

const RULES = Object.freeze({ residual: 2, margin: 12, trainingRadius: 20, heldOutP95: 8, independentMax: 8 });
const REGIONS = Object.freeze([
  { name: 'sumeru', calibration: ['277', 'o403'], independent: [['278', 'o8'], ['341', 'o470']] },
  { name: 'fontaine', calibration: ['354', 'o508'], independent: [['355', 'o8']] },
  { name: 'nod-krai', calibration: ['2001', 'o694'], independent: [['2002', 'o8']] },
]);
const CHESTS = Object.freeze([['60', 'o46'], ['63', 'o45'], ['61', 'o44'], ['62', 'o17'], ['265', 'o269']]);

function requireValue(ok) { if (!ok) throw new Error('invalid-bwiki-pair-input'); }
function nativePosition(position) {
  requireValue(position && Number.isFinite(position.x) && Number.isFinite(position.y));
  if (position.space === 'bwiki:lng-lat:v4') return [position.x, position.y];
  requireValue(position.space === 'bwiki:lng-lat:legacy' && Math.abs(position.x) <= 180 && Math.abs(position.y) < 90);
  // Exact inspected first-party legacy projection, including integer rounding.
  const a = 6378206, b = 6356584.314245179, e = Math.sqrt(1 - (b / a) ** 2), scale = 0.0004883406312203475;
  const phi = position.y * Math.PI / 180, sin = Math.sin(phi);
  return [Math.round(a * position.x * Math.PI / 180 * scale), Math.round(-a * Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - e * sin) / (1 + e * sin)) ** (e / 2)) * scale)];
}
function project(point, matrix) { return matrix.map(row => row[0] * point[0] + row[1] * point[1] + row[2]); }
function cross(a, b, p) { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = rows => { const out = []; for (const point of rows) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop(); out.push(point); } return out; };
  const low = half(sorted), high = half([...sorted].reverse());
  return low.slice(0, -1).concat(high.slice(0, -1));
}
function inHull(point, hull) { return hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], point) >= -1e-9); }
function nearest(point, rows) {
  let best = Infinity, second = Infinity, index = -1;
  rows.forEach((row, i) => {
    const distance = Math.hypot(point[0] - row.x, point[1] - row.y);
    if (distance < best) { second = best; best = distance; index = i; }
    else if (distance < second) second = distance;
  });
  return { index, distance: best, margin: second - best };
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b), i = (sorted.length - 1) * fraction, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function residualSummary(values) {
  requireValue(values.length > 0 && values.every(Number.isFinite));
  return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
}
function solve(matrix, rhs) {
  const m = matrix.map((row, i) => [...row, rhs[i]]);
  for (let k = 0; k < 3; k++) {
    let pivot = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    requireValue(Math.abs(m[pivot][k]) > 1e-12);
    [m[k], m[pivot]] = [m[pivot], m[k]];
    const divisor = m[k][k];
    for (let j = k; j < 4; j++) m[k][j] /= divisor;
    for (let i = 0; i < 3; i++) if (i !== k) {
      const factor = m[i][k];
      for (let j = k; j < 4; j++) m[i][j] -= factor * m[k][j];
    }
  }
  return m.map(row => row[3]);
}
function affine(samples) {
  requireValue(samples.length >= 20);
  const mean = [0, 1].map(axis => samples.reduce((sum, item) => sum + item.source[axis], 0) / samples.length);
  const gram = Array.from({ length: 3 }, () => [0, 0, 0]), rhs = [[0, 0, 0], [0, 0, 0]];
  for (const sample of samples) {
    const row = [sample.source[0] - mean[0], sample.source[1] - mean[1], 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) gram[i][j] += row[i] * row[j];
      for (let axis = 0; axis < 2; axis++) rhs[axis][i] += row[i] * sample.target[axis];
    }
  }
  return rhs.map(values => { const row = solve(gram, values); return [row[0], row[1], row[2] - row[0] * mean[0] - row[1] * mean[1]]; });
}

function generateCandidates({ sourceCatalog, canonical }) {
  requireValue(canonical?.namespace === 'appsample:gim:2' && Array.isArray(canonical.markers));
  const canonicalIds = new Set();
  for (const row of canonical.markers) {
    requireValue(typeof row.id === 'string' && !canonicalIds.has(row.id) && typeof row.category === 'string' && row.level === null && Number.isFinite(row.x) && Number.isFinite(row.y));
    canonicalIds.add(row.id);
  }
  const raw = Object.values(sourceCatalog).flat(), ground = new Set();
  requireValue(raw.length > 0);
  // Normalization excludes all identity conflicts, including raw-layer conflicts.
  // G is the source's ground layer; other explicit layers are never candidates.
  for (const row of raw) if (row.layer === undefined || row.layer === '' || row.layer === 'G') ground.add(String(row.id));
  const normalized = normalizeCatalog(sourceCatalog), source = normalized.filter(row => ground.has(row.id));
  // Conflicting/stale-container IDs cannot become candidates, but every valid
  // raw occurrence remains a possible spatial competitor. Collapse only equal
  // occurrences of the same source identity and coordinates.
  const blockerRows = new Map();
  for (const row of raw) {
    const record = normalizeCatalog([row])[0];
    blockerRows.set(JSON.stringify([record.id, record.category, record.position]), record);
  }
  const sourceByCategory = category => source.filter(row => row.category === category);
  const blockersByCategory = category => [...blockerRows.values()].filter(row => row.category === category);
  const targetByCategory = category => canonical.markers.filter(row => row.category === category);
  const regions = [], pairs = [], excludedCategories = new Set();
  for (const region of REGIONS) {
    const [category, targetCategory] = region.calibration, calibrators = sourceByCategory(category), targets = targetByCategory(targetCategory);
    requireValue(calibrators.length >= 40 && targets.length >= 40);
    // Lexical source order, alternating records: no source ID is equated with a
    // destination ID. Independent categories below never enter this fitting.
    const training = calibrators.filter((_, i) => i % 2 === 0), heldOut = calibrators.filter((_, i) => i % 2 === 1);
    let coefficients = [[0.56967, 0, 1048576 + 0.486 / 360 * 2097152], [0, 0.56967, 1048576 - 0.088 / 360 * 2097152]], samples;
    for (let iteration = 0; iteration < 6; iteration++) {
      samples = training.flatMap(row => {
        const position = nativePosition(row.position), match = nearest(project(position, coefficients), targets);
        return match.distance < RULES.trainingRadius ? [{ source: position, target: [targets[match.index].x, targets[match.index].y], sourceId: row.id, canonicalId: targets[match.index].id }] : [];
      });
      coefficients = affine(samples);
    }
    const evidence = residualSummary(heldOut.map(row => nearest(project(nativePosition(row.position), coefficients), targets).distance));
    requireValue(evidence.p95 <= RULES.heldOutP95);
    const independent = region.independent.map(([sourceCategory, canonicalCategory]) => {
      const rows = sourceByCategory(sourceCategory), targetRows = targetByCategory(canonicalCategory);
      requireValue(rows.length >= 5 && targetRows.length >= 5);
      const result = { sourceCategory, canonicalCategory, ...residualSummary(rows.map(row => nearest(project(nativePosition(row.position), coefficients), targetRows).distance)) };
      requireValue(result.max <= RULES.independentMax);
      return result;
    });
    // Chest extensions cannot extrapolate outside the hull of the actual
    // region's calibration+holdout oculi. Hull membership does not fit the model.
    const domain = convexHull(calibrators.map(row => nativePosition(row.position)));
    for (const [sourceCategory, canonicalCategory] of [region.calibration, ...region.independent, ...CHESTS]) {
      const rows = sourceByCategory(sourceCategory), targetRows = targetByCategory(canonicalCategory);
      const extension = CHESTS.some(([category]) => category === sourceCategory);
      // All same-category source rows block ambiguity, including explicit
      // non-ground layers and rows outside this model's extension domain.
      const blockers = blockersByCategory(sourceCategory);
      // A malformed legacy coordinate may hide a competing native-space row.
      // Never silently discard that potential blocker or guess a version.
      if (blockers.some(row => row.position.space === 'bwiki:lng-lat:legacy' && (Math.abs(row.position.x) > 180 || Math.abs(row.position.y) >= 90))) {
        requireValue(extension); excludedCategories.add(sourceCategory); continue;
      }
      const projectedBlockers = blockers.map(row => { const xy = project(nativePosition(row.position), coefficients); return { x: xy[0], y: xy[1] }; });
      const projected = rows.map(row => { const xy = project(nativePosition(row.position), coefficients); return { x: xy[0], y: xy[1] }; });
      rows.forEach((record, i) => {
        if (extension && !inHull(nativePosition(record.position), domain)) return;
        const match = nearest([projected[i].x, projected[i].y], targetRows), target = targetRows[match.index];
        if (match.distance > RULES.residual || match.margin < RULES.margin) return;
        const reverse = nearest([target.x, target.y], projectedBlockers);
        if (blockers[reverse.index].id !== record.id || reverse.margin < RULES.margin) return;
        pairs.push({ source: record, target, region: region.name, residual: match.distance, margin: match.margin, sourceMargin: reverse.margin,
          reason: 'permanent-category; ground-or-unspecified-layer; region-calibrated; independent-category-heldout; bidirectional-margin; global-layer-blockers' + (extension ? ';calibration-hull-extension' : ''),
          calibrationRole: extension ? 'extension' : sourceCategory === category ? (calibrators.indexOf(record) % 2 === 0 ? 'training' : 'held-out') : 'independent-category' });
      });
    }
    regions.push({ name: region.name, calibration: region.calibration, coefficients, trainingCount: samples.length, training: samples,
      heldOut: evidence, independent, extensionDomain: domain });
  }
  // A point accepted by multiple regional models is never resolved by choosing
  // the smallest residual. All source or destination collisions are excluded.
  const sourceCounts = new Map(), targetCounts = new Map();
  for (const pair of pairs) { sourceCounts.set(pair.source.id, (sourceCounts.get(pair.source.id) || 0) + 1); targetCounts.set(pair.target.id, (targetCounts.get(pair.target.id) || 0) + 1); }
  const accepted = pairs.filter(pair => sourceCounts.get(pair.source.id) === 1 && targetCounts.get(pair.target.id) === 1);
  for (const region of regions) region.candidateCount = accepted.filter(pair => pair.region === region.name).length;
  return { format: 'bwiki-offline-pair-candidates', version: 1, rules: RULES, normalizedCount: normalized.length, eligibleGroundCount: source.length,
    canonicalFingerprint: canonical.fingerprint, regions, excludedCategories: [...excludedCategories].sort(), excludedModelOrIdCollisions: pairs.length - accepted.length,
    pairs: accepted.sort((a, b) => a.source.id.localeCompare(b.source.id, 'en')) };
}

if (require.main === module) {
  try {
    const fs = require('node:fs'), args = process.argv.slice(2), values = {}, flags = ['--source', '--canonical', '--out'];
    requireValue(args.length === 6);
    for (let i = 0; i < args.length; i += 2) { requireValue(flags.includes(args[i]) && !Object.hasOwn(values, args[i]) && args[i + 1] && !args[i + 1].startsWith('--')); values[args[i]] = args[i + 1]; }
    const read = path => { requireValue(fs.statSync(path).size <= 256 * 1024 * 1024); return JSON.parse(fs.readFileSync(path, 'utf8')); };
    const result = generateCandidates({ sourceCatalog: read(values['--source']), canonical: read(values['--canonical']) });
    fs.writeFileSync(values['--out'], JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ pairs: result.pairs.length, regions: result.regions.map(({ name, candidateCount }) => ({ name, candidateCount })) }) + '\n');
  } catch { process.stderr.write('bwiki-pair-generation-failed\n'); process.exitCode = 1; }
}

module.exports = { generateCandidates, nativePosition };
