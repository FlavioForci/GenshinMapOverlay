'use strict';
const { validateMappingPack } = require('../../src/transfer/mapping');
const { catalogReport } = require('./catalog-report');

/** Package independently checked correspondences as fixed application assets.
 * This offline helper is never exposed to transfer files or the renderer.
 */
function packageSourcePairs({ provider, map, sourceCatalog, canonicalCatalog, candidates }) {
  const sources = new Map(sourceCatalog.map(row => [row.id, row]));
  const targets = new Map(canonicalCatalog.markers.map(row => [row.id, row]));
  const usedSources = new Set(), usedTargets = new Set(), categories = new Map();
  const sourceMarkers = [], targetFacts = [], pairs = [];
  for (const candidate of candidates) {
    const source = sources.get(candidate.sourceId), target = targets.get(candidate.canonicalId);
    if (!source || !target || !source.position || !source.category || usedSources.has(source.id) || usedTargets.has(target.id)) throw new Error('invalid-reviewed-pair');
    if (categories.has(source.category) && categories.get(source.category) !== target.category) throw new Error('conflicting-reviewed-category');
    usedSources.add(source.id); usedTargets.add(target.id); categories.set(source.category, target.category);
    sourceMarkers.push({ id: source.id, category: source.category, level: source.level,
      x: source.position.x, y: source.position.y, space: source.position.space });
    targetFacts.push(target); pairs.push({ sourceId: source.id, canonicalId: target.id });
  }
  const pack = validateMappingPack({ version: 1, provider, map, recordScoped: true,
    sourceCatalogFingerprint: catalogReport({ provider, map, catalog: sourceCatalog, progress: [] }).catalogFingerprint,
    canonicalCatalogFingerprint: canonicalCatalog.fingerprint, sourceCoordinateSpace: 'per-record', sourceMarkers,
    categoryPairs: [...categories].sort().map(([source, target]) => ({ source, target, permanent: true })), levelPairs: [], pairs, spatial: null });
  return { pack, targets: targetFacts.sort((a, b) => a.id.localeCompare(b.id)) };
}

module.exports = { packageSourcePairs };
