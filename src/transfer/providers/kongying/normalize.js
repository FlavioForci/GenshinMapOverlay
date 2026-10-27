'use strict';
const { TRANSFER_LIMITS } = require('../../envelope');
const MAP = 'kongying:v3:teyvat';
const fail = () => { throw Object.assign(new Error('catalog-unavailable'), { code: 'catalog-unavailable' }); };
function markerId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail();
  return String(value);
}
function list(value, limit = TRANSFER_LIMITS.RECORDS) {
  if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length) fail();
  return value;
}

/** Resolve the same tile inheritance as create_map_config, but fail if an
 * unknown area would silently fall back to the default map in the website. */
function catalogScope(config, areas) {
  const tiles = config?.tiles;
  if (!tiles || typeof tiles !== 'object' || Array.isArray(tiles) || typeof tiles['提瓦特-base0']?.code !== 'string') fail();
  const base = tiles['提瓦特-base0'].code;
  const resolve = (key, visited = new Set()) => {
    if (typeof key !== 'string' || !Object.hasOwn(tiles, key) || visited.has(key)) fail();
    visited.add(key);
    const value = tiles[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    if (value.code !== undefined) { if (typeof value.code !== 'string' || !value.code) fail(); return value.code; }
    return resolve(value.extend, visited);
  };
  const teyvat = [], other = [], ids = new Set();
  for (const area of list(areas, 4096)) {
    const id = markerId(area?.id);
    if (ids.has(id) || typeof area.isFinal !== 'boolean') fail();
    ids.add(id);
    if (area.isFinal) (resolve(area.code) === base ? teyvat : other).push(area.id);
  }
  if (!teyvat.length) fail();
  return { teyvat: teyvat.sort((a, b) => a - b), other: other.sort((a, b) => a - b) };
}

/** Native contract: exact public config + full area list + the explicit
 * Teyvat areaIdList used for the flat list_byinfo response. Marker rows have
 * no areaId, so coordinates must never establish their map implicitly. */
function normalizeCatalog(native) {
  const scope = catalogScope(native?.config, native?.areas);
  const requested = list(native?.areaIds, 4096).map(markerId).sort();
  if (JSON.stringify(requested) !== JSON.stringify(scope.teyvat.map(String).sort())) fail();
  const byId = new Map();
  for (const row of list(native?.markers)) {
    const id = markerId(row?.id);
    if (typeof row.position !== 'string' || row.position.length > 128) fail();
    const parts = row.position.split(',');
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    if (parts.length !== 2 || parts.some(value => !decimal.test(value.trim()))) fail();
    const [lat, lng] = parts.map(Number);
    if (![lat, lng].every(value => Number.isFinite(value) && Math.abs(value) <= TRANSFER_LIMITS.COORDINATE)) fail();
    const itemIds = [...new Set(list(row.itemList, 32).map(item => markerId(item?.itemId)))];
    if (!itemIds.length) fail();
    const category = itemIds.sort().join('+');
    if (category.length > TRANSFER_LIMITS.ID) fail();
    const record = { id, map: MAP, category, level: null, state: true,
      position: { x: lng || 0, y: lat || 0, space: 'kongying:leaflet-lng-lat' } };
    if (byId.has(id) && JSON.stringify(byId.get(id)) !== JSON.stringify(record)) fail();
    byId.set(id, record);
  }
  if (!byId.size) fail();
  return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
module.exports = { normalizeCatalog, catalogScope, markerId };
