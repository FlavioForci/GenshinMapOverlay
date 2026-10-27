'use strict';
const { TRANSFER_LIMITS } = require('../../envelope');
const MAP = 'bwiki:ys:Data:Map4';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function id(value, code = 'catalog-unavailable') {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > TRANSFER_LIMITS.ID || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(code);
  return value;
}
function category(value, code = 'catalog-unavailable') {
  const result = typeof value === 'number' ? String(value) : value;
  if (typeof result !== 'string' || !/^[1-9]\d*$/.test(result) || !Number.isSafeInteger(Number(result))) fail(code);
  return result;
}
function coordinate(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) fail('catalog-unavailable');
    value = Number(value);
  }
  if (!Number.isFinite(value) || Math.abs(value) > TRANSFER_LIMITS.COORDINATE) fail('catalog-unavailable');
  return value || 0;
}

/** Native input is loaded window.pointsData: {[markType]: row[]}; flat row[]
 * is also accepted for offline mapping. Rows use id, markType, point.lng/lat,
 * optional version 4 and optional raw layer. No provider floor is inferred.
 */
function snapshotCatalog(native) {
  if (!native || typeof native !== 'object') fail('catalog-unavailable');
  const groups = Array.isArray(native) ? [[null, native]] : Object.entries(native);
  if (!groups.length) fail('catalog-unavailable');
  const byId = new Map(), conflicts = new Set(), signature = [];
  let count = 0;
  for (const [key, rows] of groups) {
    if (key !== null) category(key);
    if (!Array.isArray(rows)) fail('catalog-unavailable');
    for (const raw of rows) {
      if (++count > TRANSFER_LIMITS.RECORDS || !raw || typeof raw !== 'object') fail('catalog-unavailable');
      const markerId = id(raw.id), markType = category(raw.markType);
      // Live Map4 includes stale category containers. Such IDs cannot gain
      // mapping metadata from either occurrence, but remain valid progress IDs.
      if (key !== null && markType !== key) conflicts.add(markerId);
      if (raw.version !== undefined && raw.version !== 4 && raw.version !== '4') fail('catalog-unavailable');
      const layer = raw.layer === undefined || raw.layer === '' ? null : raw.layer;
      if (layer !== null && (typeof layer !== 'string' || layer.length > TRANSFER_LIMITS.ID)) fail('catalog-unavailable');
      const record = { id: markerId, map: MAP, category: markType, level: layer !== null && layer !== 'G' ? 'bwiki:unreviewed-layer' : null, state: true, position: {
        x: coordinate(raw.point?.lng), y: coordinate(raw.point?.lat), space: raw.version === undefined ? 'bwiki:lng-lat:legacy' : 'bwiki:lng-lat:v4',
      } };
      const encoded = JSON.stringify([record, layer]);
      signature.push(JSON.stringify([key, record, layer]));
      if (byId.has(markerId) && byId.get(markerId).encoded !== encoded) conflicts.add(markerId);
      else if (!byId.has(markerId)) byId.set(markerId, { record, encoded });
    }
  }
  if (!count) fail('catalog-unavailable');
  const records = [...byId.values()].map(item => item.record).filter(row => !conflicts.has(row.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { records, conflicts: [...conflicts].sort(), signature: JSON.stringify(signature.sort()) };
}
function normalizeCatalog(native) { return snapshotCatalog(native).records; }
module.exports = { MAP, normalizeCatalog, snapshotCatalog, markerId: id, category };
