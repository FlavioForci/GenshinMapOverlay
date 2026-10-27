'use strict';
const { TRANSFER_LIMITS, validateTransfer } = require('../../envelope');
const MAP = 'appsample:gim:2';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function markerId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  fail('invalid-progress');
}
function progressIds(value) {
  if (!Array.isArray(value) || value.length > TRANSFER_LIMITS.RECORDS) fail('invalid-progress');
  return value.map(markerId);
}

/** Snapshot the decoded catalog exported by the site's module 3580. Raw `level`
 * is deliberately excluded: it controls marker features, not validated floors.
 */
function snapshotCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || !catalog[2] || !Object.keys(catalog[2]).length) fail('catalog-unavailable');
  const byId = new Map();
  for (const [map, categories] of Object.entries(catalog)) {
    if (!/^[1-9]\d*$/.test(map) || !categories || typeof categories !== 'object') fail('catalog-unavailable');
    for (const [category, rows] of Object.entries(categories)) {
      if (!category || category.length > TRANSFER_LIMITS.ID || !Array.isArray(rows)) fail('catalog-unavailable');
      for (const row of rows) {
        let id; try { id = markerId(row?.id); } catch { fail('catalog-unavailable'); }
        if (byId.size >= TRANSFER_LIMITS.RECORDS || byId.has(id) || row.mid !== Number(map) || row.type !== category
          || !Number.isFinite(row.lng) || !Number.isFinite(row.lat)
          || Math.abs(row.lng) > TRANSFER_LIMITS.COORDINATE || Math.abs(row.lat) > TRANSFER_LIMITS.COORDINATE) fail('catalog-unavailable');
        byId.set(id, { id, map: 'appsample:gim:' + map, category, level: null, state: true,
          position: { x: row.lng || 0, y: row.lat || 0, space: 'appsample-normalized' } });
      }
    }
  }
  const rows = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const teyvat = rows.filter(row => row.map === MAP);
  if (!teyvat.length) fail('catalog-unavailable');
  return { byId, teyvat, signature: JSON.stringify(rows) };
}

/** Only known Teyvat IDs enter a Teyvat envelope. Unknown IDs cannot safely be
 * assigned a map; the caller reports their count, alongside other-map marks.
 */
async function normalizeProgress({ catalog, cloudIds, localIds, generation }) {
  const cloud = progressIds(cloudIds);
  let local; try { local = progressIds(localIds); } catch { fail('invalid-local-progress'); }
  const found = new Set([...cloud, ...local]);
  if (found.size > TRANSFER_LIMITS.RECORDS) fail('invalid-progress');
  const records = []; let otherMaps = 0, unknown = 0;
  for (const id of found) {
    const row = catalog.byId.get(id);
    if (!row) unknown++;
    else if (row.map !== MAP) otherMaps++;
    else records.push(row);
  }
  records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(catalog.teyvat)));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const envelope = validateTransfer({
    format: 'genshin-map-overlay.transfer', version: 1,
    producer: { name: 'Genshin Map Overlay AppSample source', version: '0.1.0' },
    exportedAt: new Date().toISOString(), provider: 'appsample', adapterVersion: '0.1.0', map: MAP,
    catalog: { generation, fingerprint },
    coverage: { categories: [...new Set(records.map(row => row.category))].sort(), levels: [], complete: false }, records,
  });
  return { envelope, summary: { found: records.length, otherMaps, unknown } };
}

module.exports = { snapshotCatalog, normalizeProgress };
