'use strict';
const { TRANSFER_LIMITS } = require('../../envelope');
const fail = () => { throw Object.assign(new Error('catalog-unavailable'), { code: 'catalog-unavailable' }); };
function positiveId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  fail();
}
function coordinate(value) {
  // Public MapGenie JSON uses decimal strings. Do not coerce null, whitespace,
  // objects, or future shapes into coordinates that look valid.
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail();
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > TRANSFER_LIMITS.COORDINATE) fail();
  return number || 0;
}

/** Normalize the native locations array (not an API response wrapper).
 * Evidence: dated public fixture, 2026-10-24. This does not establish current
 * website progress/profile contracts or any cross-provider correspondence.
 */
function normalizeCatalog(native) {
  if (!Array.isArray(native) || !native.length || native.length > TRANSFER_LIMITS.RECORDS) fail();
  const ids = new Set();
  return Array.from(native, row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.map_id !== 121) fail();
    const id = positiveId(row.id);
    if (ids.has(id)) fail();
    ids.add(id);
    return { id, map: 'mapgenie:43:121', category: positiveId(row.category_id), level: null, state: true,
      position: { x: coordinate(row.longitude), y: coordinate(row.latitude), space: 'mapgenie:lng-lat' } };
  });
}
module.exports = { normalizeCatalog };
