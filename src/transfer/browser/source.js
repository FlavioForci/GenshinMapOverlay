'use strict';
const { TRANSFER_LIMITS, validateTransfer, attachmentSchema: schema } = require('../envelope');

/** Shared source-file contract. Catalog hashes match the main-process research
 * tool so reviewed mapping assets and independent browser reads share identity.
 * Only explicit found IDs become records; missing IDs never mean not-found.
 */
async function buildSourceTransfer({ provider, map, generation, catalog, foundIds }) {
  const base = { format: 'genshin-map-overlay.transfer', version: 1,
    producer: { name: 'Genshin Map Overlay source', version: '0.1.0' }, exportedAt: new Date().toISOString(),
    provider, adapterVersion: '0.1.0', map, catalog: { generation, fingerprint: 'pending' },
    coverage: { categories: [], levels: [], complete: false }, records: catalog };
  const checked = validateTransfer(base);
  const metadata = checked.records.map(row => JSON.stringify([row.id, row.map, row.category, row.level,
    row.position === null ? null : [row.position.x, row.position.y, row.position.space]])).sort().map(row => JSON.parse(row));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider, map, metadata])));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  schema.array(foundIds, TRANSFER_LIMITS.RECORDS);
  const ids = [...new Set(foundIds.map(id => schema.text(id, TRANSFER_LIMITS.ID)))].sort();
  const byId = new Map(checked.records.map(row => [row.id, row])); let unknown = 0;
  const records = ids.map(id => {
    const row = byId.get(id);
    if (row) return { ...row, state: true };
    unknown++;
    return { id, map, category: null, level: null, state: true, position: null };
  });
  const categories = [...new Set(records.map(row => row.category).filter(value => value !== null))].sort();
  const envelope = validateTransfer({ ...base, catalog: { generation, fingerprint }, records,
    coverage: { categories: categories.length <= TRANSFER_LIMITS.COVERAGE ? categories : [], levels: [], complete: false } });
  return { envelope, summary: { found: records.length, unknown } };
}

module.exports = { buildSourceTransfer };
