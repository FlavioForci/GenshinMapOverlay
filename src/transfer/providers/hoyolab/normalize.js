'use strict';
const { TRANSFER_LIMITS } = require('../../envelope');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAP = 'hoyolab:ys_obc:2';
function id(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) fail('invalid-progress');
  return text;
}
function array(rows) {
  if (!Array.isArray(rows) || rows.length > TRANSFER_LIMITS.RECORDS || rows.some((_, i) => !Object.hasOwn(rows, i)) || Object.keys(rows).length !== rows.length) fail('invalid-progress');
}
function normalizeCatalog(rows) {
  array(rows); if (!rows.length) fail('catalog-unavailable'); const seen = new Set();
  return rows.map(row => {
    const key = id(row?.id), category = id(row?.label_id);
    if (seen.has(key) || !Number.isFinite(row.x_pos) || !Number.isFinite(row.y_pos)
      || Math.abs(row.x_pos) > TRANSFER_LIMITS.COORDINATE || Math.abs(row.y_pos) > TRANSFER_LIMITS.COORDINATE) fail('invalid-progress');
    seen.add(key);
    return { id: key, map: MAP, category, level: row.z_level === 0 && row.point_group === null ? null : 'hoyolab:unreviewed-layer', state: true, position: { x: row.x_pos || 0, y: row.y_pos || 0, space: 'hoyolab:x_pos-y_pos' } };
  });
}
function normalizeProgress(rows) {
  array(rows);
  return [...new Set(rows.map(row => id(row?.point_id)))];
}
module.exports = { normalizeCatalog, normalizeProgress };
