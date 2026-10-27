'use strict';
const { TRANSFER_LIMITS: LIMITS, attachmentSchema: s } = require('./envelope');
/** @typedef {{provider:string,map:string,catalog:{generation:string,fingerprint:string},record:import('./envelope').TransferRecord,mapping:{canonicalId:string,confidence:'exact'|'reviewed'|'spatial',mappingVersion:string}|null}} RetainedRecord */
/** @typedef {{digest:string,provider:string,map:string,counts:Record<string,number>,createdProfile:boolean}} ImportReceipt */
/** @typedef {{version:1,records:RetainedRecord[],imports:ImportReceipt[]}} ProfileAttachment */
const COUNTS = ['matched', 'alreadyFound', 'ambiguous', 'unsupported', 'unknown', 'invalid', 'ignoredNotFound', 'duplicates'];
const sourceKey = value => JSON.stringify([value.provider, value.map, value.record.id]);
function retained(value) {
  s.object(value, ['provider', 'map', 'catalog', 'record', 'mapping']);
  const map = s.text(value.map, LIMITS.ID);
  let mapping = null;
  if (value.mapping !== null) {
    s.object(value.mapping, ['canonicalId', 'confidence', 'mappingVersion']);
    const id = s.text(value.mapping.canonicalId, LIMITS.ID);
    s.check(/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && ['exact', 'reviewed', 'spatial'].includes(value.mapping.confidence));
    mapping = { canonicalId: id, confidence: value.mapping.confidence, mappingVersion: s.text(value.mapping.mappingVersion) };
  }
  return { provider: s.provider(value.provider), map, catalog: s.catalog(value.catalog), record: s.record(value.record, map), mapping };
}
function receipt(value) {
  s.object(value, ['digest', 'provider', 'map', 'counts', 'createdProfile']);
  s.check(typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) && typeof value.createdProfile === 'boolean');
  s.object(value.counts, COUNTS); const counts = {};
  for (const key of COUNTS) { s.check(Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0); counts[key] = value.counts[key]; }
  return { digest: value.digest, provider: s.provider(value.provider), map: s.text(value.map, LIMITS.ID), counts, createdProfile: value.createdProfile };
}
/** Validate all attachments with envelope-wide limits; unknown source realms/IDs remain opaque. @param {unknown} value @param {string[]} profileIds @returns {Record<string,ProfileAttachment>} */
function validateAttachments(value, profileIds) {
  const keys = s.object(value); const allowed = new Set(profileIds); const profiles = {};
  let records = 0; let receipts = 0;
  // Count/inspect every array before normalization; duplicate collapse cannot bypass limits.
  for (const id of keys) {
    s.check(allowed.has(id)); const a = value[id]; s.object(a, ['version', 'records', 'imports']);
    if (Number.isSafeInteger(a.version) && a.version > 1) s.fail('unsupported-version');
    s.check(a.version === 1); s.array(a.records, LIMITS.RECORDS); s.array(a.imports, LIMITS.RECEIPTS);
    records += a.records.length; receipts += a.imports.length;
    s.check(records <= LIMITS.RECORDS && receipts <= LIMITS.RECEIPTS);
  }
  for (const id of keys) {
    const a = value[id];
    profiles[id] = { version: 1, records: s.observations(a.records, retained, sourceKey), imports: a.imports.map(receipt) };
  }
  return profiles;
}
/** Later explicit imports replace observations by provider/map/id, never by source timestamps. @param {ProfileAttachment|undefined} previous @param {ProfileAttachment} incoming @returns {ProfileAttachment} */
function mergeAttachment(previous, incoming) {
  const next = validateAttachments({ next: incoming }, ['next']).next;
  if (previous === undefined) return next;
  const before = validateAttachments({ previous }, ['previous']).previous;
  const records = new Map(before.records.map(value => [sourceKey(value), value]));
  for (const value of next.records) records.set(sourceKey(value), value);
  return validateAttachments({ merged: { version: 1, records: [...records.values()], imports: [...before.imports, ...next.imports] } }, ['merged']).merged;
}
module.exports = { validateAttachments, mergeAttachment };
