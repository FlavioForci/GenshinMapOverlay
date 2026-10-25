'use strict';
const { createHash } = require('node:crypto');
const { TRANSFER_LIMITS, attachmentSchema: schema } = require('./envelope');
const NAMESPACE = 'appsample:gim:2';
/** @typedef {{id:string,category:string,level:string|null,x:number,y:number}} CatalogPoint */
/** @typedef {{namespace:'appsample:gim:2',fingerprint:string,markers:CatalogPoint[]}} CanonicalCatalog */
/** Stable semantic identity of the current DataStore Teyvat catalog. Main-process only.
 * DataStore's raw level numbers have not been verified as floors and are deliberately excluded.
 * @param {{types:Array<{key:string}>,markers:{count:number,id:ArrayLike<number>,type:ArrayLike<number>,level:ArrayLike<number>,x:ArrayLike<number>,y:ArrayLike<number>}}} data
 * @returns {CanonicalCatalog}
 */
function canonicalCatalog(data) {
  const { markers: m, types } = data;
  schema.check(Array.isArray(types) && m && Number.isSafeInteger(m.count) && m.count >= 0 && m.count <= TRANSFER_LIMITS.RECORDS);
  for (const key of ['id', 'type', 'level', 'x', 'y']) schema.check(m[key] && m[key].length === m.count);
  const ids = new Set();
  const markers = Array.from({ length: m.count }, (_, i) => {
    schema.check(Number.isSafeInteger(m.id[i]) && m.id[i] > 0 && !ids.has(m.id[i])); ids.add(m.id[i]);
    schema.check(Number.isSafeInteger(m.type[i]) && types[m.type[i]]);
    const category = schema.text(types[m.type[i]].key, TRANSFER_LIMITS.ID);
    schema.check(Number.isFinite(m.x[i]) && Number.isFinite(m.y[i]) && Math.abs(m.x[i]) <= TRANSFER_LIMITS.COORDINATE && Math.abs(m.y[i]) <= TRANSFER_LIMITS.COORDINATE);
    return { id: String(m.id[i]), category, level: null, x: m.x[i] || 0, y: m.y[i] || 0 };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fingerprint = createHash('sha256').update(JSON.stringify({ namespace: NAMESPACE, markers })).digest('hex');
  return { namespace: NAMESPACE, fingerprint, markers };
}
module.exports = { canonicalCatalog };
