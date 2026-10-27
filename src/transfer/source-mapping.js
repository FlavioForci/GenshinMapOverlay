'use strict';
const { validateMappingPack } = require('./mapping');
const { attachmentSchema: s, TRANSFER_LIMITS } = require('./envelope');

/** Revalidate bundled explicit correspondences against current canonical rows.
 * Inputs are fixed application assets, never a mapping supplied by an import.
 * Unrelated additions may change a catalog hash; each paired target must still
 * have exactly the reviewed identity, category, floor and coordinates.
 */
function rebaseMapping(pack, targets, catalog) {
  const checked = validateMappingPack(pack);
  s.check(checked.recordScoped === true && catalog.namespace === 'appsample:gim:2');
  s.array(targets, TRANSFER_LIMITS.RECORDS);
  const facts = new Map();
  for (const row of targets) {
    s.object(row, ['id', 'category', 'level', 'x', 'y']);
    s.check(!facts.has(row.id)); facts.set(row.id, row);
  }
  const current = new Map(catalog.markers.map(row => [row.id, row]));
  const pairs = checked.pairs.filter(pair => {
    const a = facts.get(pair.canonicalId), b = current.get(pair.canonicalId);
    return a && b && ['id', 'category', 'level', 'x', 'y'].every(key => a[key] === b[key]);
  });
  if (!pairs.length) return null;
  const ids = new Set(pairs.map(pair => pair.sourceId));
  return validateMappingPack({ ...checked, canonicalCatalogFingerprint: catalog.fingerprint,
    sourceMarkers: checked.sourceMarkers.filter(row => ids.has(row.id)), pairs });
}

module.exports = { rebaseMapping };
