'use strict';
const { createHash } = require('node:crypto');
const { validateTransfer, TRANSFER_LIMITS, attachmentSchema: s } = require('./envelope');
const { createSpatialIndex, fitAffine } = require('./spatial-index');
const NAMESPACE = 'appsample:gim:2';
/** @typedef {{source:[number,number],target:[number,number],sourceId:string,canonicalId:string}} CalibrationPoint */
/** @typedef {{version:1,provider:import('./capabilities').ProviderId,map:string,sourceCatalogFingerprint:string,canonicalCatalogFingerprint:string,sourceCoordinateSpace:string,sourceMarkers:import('./catalog').CatalogPoint[],categoryPairs:Array<{source:string,target:string,permanent:boolean}>,levelPairs:Array<{source:string,target:string}>,pairs:Array<{sourceId:string,canonicalId:string}>,spatial:null|{coefficients:[number,number,number,number,number,number],radius:number,minMargin:number,maxResidual:number,anchors:CalibrationPoint[],heldOut:CalibrationPoint[]}}} MappingPack */
/** @typedef {{sourceId:string,status:'matched'|'ambiguous'|'unsupported'|'unknown',canonicalId:string|null,confidence:'exact'|'reviewed'|'spatial'|null,mappingVersion:string|null,reason:string}} MappingDecision */
const name = value => s.text(value, TRANSFER_LIMITS.ID);
function coordinate(value) { s.check(Number.isFinite(value) && Math.abs(value) <= TRANSFER_LIMITS.COORDINATE); return value || 0; }
function point(value) {
  s.object(value, ['id', 'category', 'level', 'x', 'y']);
  return { id: name(value.id), category: name(value.category), level: value.level === null ? null : name(value.level), x: coordinate(value.x), y: coordinate(value.y) };
}
function unique(rows, key) { const set = new Set(); for (const row of rows) { const value = key(row); s.check(!set.has(value)); set.add(value); } }
function list(value, normalize) { return s.array(value, TRANSFER_LIMITS.RECORDS).map(normalize); }
function correspondence(value) { s.object(value, ['sourceId', 'canonicalId']); return { sourceId: name(value.sourceId), canonicalId: name(value.canonicalId) }; }
function vector(value) { s.array(value, 2); s.check(value.length === 2); return value.map(coordinate); }
function calibration(value) { s.object(value, ['source', 'target', 'sourceId', 'canonicalId']); return { source: vector(value.source), target: vector(value.target), sourceId: name(value.sourceId), canonicalId: name(value.canonicalId) }; }
/** Validate a bundled, reviewed pack. This checks structure, not authorship: never load a pack from a transfer file.
 * @param {unknown} value @returns {MappingPack}
 */
function validateMappingPack(value) {
  s.object(value, ['version', 'provider', 'map', 'sourceCatalogFingerprint', 'canonicalCatalogFingerprint', 'sourceCoordinateSpace', 'sourceMarkers', 'categoryPairs', 'levelPairs', 'pairs', 'spatial']);
  s.check(value.version === 1);
  const result = { version: 1, provider: s.provider(value.provider), map: name(value.map), sourceCatalogFingerprint: s.text(value.sourceCatalogFingerprint), canonicalCatalogFingerprint: s.text(value.canonicalCatalogFingerprint), sourceCoordinateSpace: name(value.sourceCoordinateSpace), sourceMarkers: list(value.sourceMarkers, point), categoryPairs: [], levelPairs: [], pairs: list(value.pairs, correspondence), spatial: null };
  unique(result.sourceMarkers, p => p.id); unique(result.pairs, p => p.sourceId); unique(result.pairs, p => p.canonicalId);
  const sourceIds = new Set(result.sourceMarkers.map(p => p.id));
  for (const pair of result.pairs) s.check(sourceIds.has(pair.sourceId));
  result.categoryPairs = list(value.categoryPairs, pair => { s.object(pair, ['source', 'target', 'permanent']); s.check(typeof pair.permanent === 'boolean'); return { source: name(pair.source), target: name(pair.target), permanent: pair.permanent }; });
  result.levelPairs = list(value.levelPairs, pair => { s.object(pair, ['source', 'target']); return { source: name(pair.source), target: name(pair.target) }; });
  // Multiple spellings may name one verified floor, but category semantics must be bijective.
  unique(result.categoryPairs, p => p.source); unique(result.categoryPairs, p => p.target); unique(result.levelPairs, p => p.source);
  if (value.spatial !== null) {
    const v = value.spatial; s.object(v, ['coefficients', 'radius', 'minMargin', 'maxResidual', 'anchors', 'heldOut']);
    s.array(v.coefficients, 6); s.check(v.coefficients.length === 6 && v.coefficients.every(Number.isFinite));
    s.check(Number.isFinite(v.radius) && v.radius > 0 && v.radius <= TRANSFER_LIMITS.COORDINATE && Number.isFinite(v.minMargin) && v.minMargin >= 0 && v.minMargin <= TRANSFER_LIMITS.COORDINATE && Number.isFinite(v.maxResidual) && v.maxResidual >= 0 && v.maxResidual <= TRANSFER_LIMITS.COORDINATE);
    result.spatial = { coefficients: [...v.coefficients], radius: v.radius, minMargin: v.minMargin, maxResidual: v.maxResidual, anchors: list(v.anchors, calibration), heldOut: list(v.heldOut, calibration) };
    s.check(result.spatial.heldOut.length > 0);
    const all = [...result.spatial.anchors, ...result.spatial.heldOut];
    unique(all, p => p.sourceId); unique(all, p => p.canonicalId); unique(all, p => JSON.stringify(p.source));
    for (const p of all) s.check(sourceIds.has(p.sourceId));
    fitAffine(result.spatial.anchors); // singular/near-collinear calibration is a corrupt model
  }
  return result;
}
function checkedCatalog(value) {
  s.object(value, ['namespace', 'fingerprint', 'markers']); s.check(value.namespace === NAMESPACE);
  const result = { namespace: NAMESPACE, fingerprint: s.text(value.fingerprint), markers: list(value.markers, point) };
  for (const marker of result.markers) s.check(/^[1-9]\d*$/.test(marker.id) && Number.isSafeInteger(Number(marker.id)));
  unique(result.markers, p => p.id); return result;
}
function decision(id, status, reason, canonicalId = null, confidence = null, mappingVersion = null) { return { sourceId: id, status, canonicalId, confidence, mappingVersion, reason }; }
const transform = (p, c) => ({ ...p, x: c[0] * p.x + c[1] * p.y + c[2], y: c[3] * p.x + c[4] * p.y + c[5] });
function modelWorks(pack, byId) {
  const model = pack.spatial; if (!model) return false;
  const source = new Map(pack.sourceMarkers.map(p => [p.id, p]));
  const fitted = fitAffine(model.anchors);
  for (const p of [...model.anchors, ...model.heldOut]) {
    const a = source.get(p.sourceId), b = byId.get(p.canonicalId);
    if (!a || !b || a.x !== p.source[0] || a.y !== p.source[1] || b.x !== p.target[0] || b.y !== p.target[1]) return false;
    const predicted = transform(a, model.coefficients), refit = transform(a, fitted);
    // Evaluate in output units, including offset drift, instead of comparing raw coefficients.
    if (Math.hypot(predicted.x - refit.x, predicted.y - refit.y) > Math.max(1e-8, model.maxResidual * 1e-6)) return false;
    if (Math.hypot(predicted.x - b.x, predicted.y - b.y) > model.maxResidual) return false;
  }
  const [a, b, , d, e] = model.coefficients;
  return Math.abs(a * e - b * d) > Number.EPSILON * Math.max(Math.abs(a * e), Math.abs(b * d), Number.MIN_VALUE);
}
function nearest(rows, x, y, radius, margin) {
  const ranked = rows.map(p => ({ point: p, distance: Math.hypot(p.x - x, p.y - y) })).sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id));
  if (!ranked.length || ranked[0].distance > radius) return { status: 'unknown', point: null };
  if (ranked[1] && (ranked[1].distance === ranked[0].distance || ranked[1].distance - ranked[0].distance < margin)) return { status: 'ambiguous', point: null };
  return { status: 'matched', point: ranked[0].point };
}
// Schema version 1 is not a mapping revision. Bind provenance to all reviewed semantic content.
function mappingVersion(pack) {
  const sorted = (rows, key) => [...rows].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
  const stable = { ...pack, sourceMarkers: sorted(pack.sourceMarkers, 'id'), categoryPairs: sorted(pack.categoryPairs, 'source'), levelPairs: sorted(pack.levelPairs, 'source'), pairs: sorted(pack.pairs, 'sourceId'), spatial: pack.spatial && { ...pack.spatial, anchors: sorted(pack.spatial.anchors, 'sourceId'), heldOut: sorted(pack.spatial.heldOut, 'sourceId') } };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
// Compute all source decisions, including unimported markers, before projecting imported observations.
function buildMatches(catalog, pack) {
  const byId = new Map(catalog.markers.map(p => [p.id, p]));
  const categories = new Map(pack.categoryPairs.map(p => [p.source, p]));
  const levels = new Map(pack.levelPairs.map(p => [p.source, p.target]));
  const pairs = new Map(pack.pairs.map(p => [p.sourceId, p.canonicalId]));
  const reserved = new Set(pack.pairs.map(p => p.canonicalId));
  const matches = new Map(), pending = [], unknownFloors = [];
  const spatialEnabled = modelWorks(pack, byId);
  const version = mappingVersion(pack);
  for (const source of pack.sourceMarkers) {
    const category = categories.get(source.category);
    const save = (status, reason, id = null, confidence = null) => matches.set(source.id, decision(source.id, status, reason, id, confidence, id === null ? null : version));
    if (!category || !category.permanent) { save('unsupported', 'category-not-permanent-or-reviewed'); continue; }
    const pairId = pairs.get(source.id);
    if (pairId !== undefined) {
      const target = byId.get(pairId);
      if (!target) save('unknown', 'reviewed-destination-absent');
      else if (target.category !== category.target) save('unsupported', 'category-mismatch');
      else if (source.level !== null && target.level !== null && levels.get(source.level) !== target.level) save('unsupported', 'level-mismatch');
      else save('matched', 'reviewed-pair', target.id, 'reviewed');
      continue;
    }
    if (!spatialEnabled) { save('unknown', 'spatial-model-unavailable'); continue; }
    const transformed = transform(source, pack.spatial.coefficients);
    if (!Number.isFinite(transformed.x) || !Number.isFinite(transformed.y)) { save('unknown', 'invalid-projection'); continue; }
    if (source.level === null || !levels.has(source.level)) {
      unknownFloors.push({ ...transformed, category: category.target });
      save('ambiguous', 'level-unverified'); continue;
    }
    pending.push({ ...transformed, category: category.target, level: levels.get(source.level) });
  }
  if (!spatialEnabled) return matches;
  const { radius, minMargin } = pack.spatial;
  const index = createSpatialIndex(catalog.markers, radius), sourceIndex = createSpatialIndex(pending, radius);
  const unknownFloorIndex = createSpatialIndex(unknownFloors, radius);
  for (const source of pending) {
    const nearby = index.query(source.x, source.y, radius + minMargin).filter(p => p.category === source.category);
    let result;
    // Unknown floors in the local candidate set cannot silently disappear from a stacked cluster.
    if (nearby.some(p => p.level === null)) result = decision(source.id, 'ambiguous', 'destination-level-unverified');
    else {
      const forward = nearest(nearby.filter(p => p.level === source.level), source.x, source.y, radius, minMargin);
      if (!forward.point) result = decision(source.id, forward.status, forward.status === 'ambiguous' ? 'insufficient-margin' : 'no-candidate');
      else if (reserved.has(forward.point.id)) result = decision(source.id, 'ambiguous', 'reviewed-destination-reserved');
      else {
        const target = forward.point;
        const floorUncertain = unknownFloorIndex.query(target.x, target.y, radius + minMargin).some(p => p.category === source.category);
        const reverse = nearest(sourceIndex.query(target.x, target.y, radius + minMargin).filter(p => p.category === source.category && p.level === source.level), target.x, target.y, radius, minMargin);
        result = !floorUncertain && reverse.point?.id === source.id ? decision(source.id, 'matched', 'reciprocal-nearest', target.id, 'spatial', version) : decision(source.id, 'ambiguous', 'non-reciprocal-or-collision');
      }
    }
    matches.set(source.id, result);
  }
  return matches;
}
/** Match only explicit found observations; file mappingEvidence is never an authority.
 * @param {import('./envelope').TransferEnvelope} envelope @param {import('./catalog').CanonicalCatalog} catalog @param {MappingPack|null} pack @returns {MappingDecision[]}
 */
function matchRecords(envelope, catalog, pack) {
  const input = validateTransfer(envelope), c = checkedCatalog(catalog);
  const p = pack === null ? null : validateMappingPack(pack);
  const exact = input.provider === 'appsample' && input.map === NAMESPACE;
  const compatible = p && input.provider === p.provider && input.map === p.map && input.catalog.fingerprint === p.sourceCatalogFingerprint && c.fingerprint === p.canonicalCatalogFingerprint;
  const byId = new Map(c.markers.map(row => [row.id, row]));
  const sources = new Map(p?.sourceMarkers.map(row => [row.id, row]) || []);
  const matches = compatible ? buildMatches(c, p) : new Map();
  return input.records.map(record => {
    const reject = (status, reason) => decision(record.id, status, reason);
    if (!record.state) return reject('unsupported', 'not-found');
    if (exact) {
      const target = byId.get(record.id);
      if (!target) return reject('unknown', 'canonical-id-absent');
      if (record.category !== null && record.category !== target.category) return reject('unsupported', 'category-mismatch');
      if (record.level !== null && target.level !== null && record.level !== target.level) return reject('unsupported', 'level-mismatch');
      return decision(record.id, 'matched', 'namespace-and-current-id', target.id, 'exact', 'identity:appsample:gim:2');
    }
    if (!compatible) return reject('unknown', 'mapping-pack-unavailable-or-stale');
    const source = sources.get(record.id);
    if (!source) return reject('unknown', 'source-id-absent');
    if (record.category !== null && record.category !== source.category) return reject('unsupported', 'source-category-mismatch');
    if (record.level !== null && source.level !== null && record.level !== source.level) return reject('unsupported', 'source-level-mismatch');
    if (record.position && (record.position.space !== p.sourceCoordinateSpace || record.position.x !== source.x || record.position.y !== source.y)) return reject('unknown', 'source-coordinate-mismatch');
    return matches.get(record.id);
  });
}
/** Reverse only bijective, independently revalidated decisions; unexportable IDs are retained as exclusions.
 * @param {string[]} canonicalIds @param {import('./catalog').CanonicalCatalog} catalog @param {MappingPack} pack @returns {{ids:string[],excluded:string[]}}
 */
function reverseIds(canonicalIds, catalog, pack) {
  const c = checkedCatalog(catalog), p = validateMappingPack(pack);
  s.array(canonicalIds, TRANSFER_LIMITS.RECORDS); canonicalIds.forEach(name);
  const wanted = [...new Set(canonicalIds)].sort();
  const current = new Set(c.markers.map(row => row.id));
  if (p.provider === 'appsample' && p.map === NAMESPACE) return { ids: wanted.filter(id => current.has(id)), excluded: wanted.filter(id => !current.has(id)) };
  const matches = p.canonicalCatalogFingerprint === c.fingerprint ? buildMatches(c, p) : new Map();
  const reverse = new Map();
  for (const match of matches.values()) if (match.status === 'matched') {
    if (!reverse.has(match.canonicalId)) reverse.set(match.canonicalId, []);
    reverse.get(match.canonicalId).push(match.sourceId);
  }
  const ids = [], excluded = [];
  for (const id of wanted) { const source = reverse.get(id); if (source?.length === 1) ids.push(source[0]); else excluded.push(id); }
  return { ids: ids.sort(), excluded };
}
/** Current bundled pack revision for provenance revalidation, after strict normalization.
 * @param {MappingPack} pack @returns {string}
 */
function mappingPackVersion(pack) { return mappingVersion(validateMappingPack(pack)); }
module.exports = { validateMappingPack, matchRecords, reverseIds, mappingPackVersion };
