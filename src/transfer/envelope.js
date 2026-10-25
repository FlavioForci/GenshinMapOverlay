'use strict';

/** @typedef {{recordIndex:number|null,code:string}} ValidationIssue */
/** @typedef {{id:string,map:string,category:string|null,level:string|null,state:boolean,position:{x:number,y:number,space:string}|null,mappingEvidence?:{namespace:'appsample:gim:2',id:string,mappingVersion:string}}} TransferRecord */
/** @typedef {{format:'genshin-map-overlay.transfer',version:1,producer:{name:string,version:string},exportedAt:string,provider:import('./capabilities').ProviderId,adapterVersion:string,map:string,catalog:{generation:string,fingerprint:string},coverage:{categories:string[],levels:string[],complete:boolean},records:TransferRecord[]}} TransferEnvelope */
const TRANSFER_LIMITS = Object.freeze({ BYTES: 64 * 1024 * 1024, RECORDS: 250000, ID: 128, TEXT: 256, COVERAGE: 4096, COORDINATE: 1e12, RECEIPTS: 1000 });
const PROVIDERS = new Set(['appsample', 'hoyolab', 'mapgenie', 'kongying', 'bwiki']);
const duplicateCounts = new WeakMap();
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
class TransferValidationError extends Error {
  constructor(code, invalidCount, issues) {
    super(code); this.name = 'TransferValidationError'; this.code = code;
    this.invalidCount = invalidCount;
    this.issues = issues.slice(0, 100).map(({ recordIndex, code }) => ({ recordIndex, code }));
  }
}
function fail(code = 'invalid-transfer') { throw new TransferValidationError(code, 1, [{ recordIndex: null, code }]); }
function check(condition) { if (!condition) fail(); }
// Descriptor inspection rejects getters, exotic prototypes, symbols and poisoned keys before reading data.
function object(value, fields, optional = []) {
  check(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    check(typeof key === 'string' && !FORBIDDEN_KEYS.has(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    if (fields) check(fields.includes(key) || optional.includes(key));
  }
  if (fields) check(fields.every(key => Object.hasOwn(value, key)));
  return keys;
}
function array(value, maximum) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum);
  check(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i)); check(d && d.enumerable && Object.hasOwn(d, 'value'));
  }
  return value;
}
function text(value, max = TRANSFER_LIMITS.TEXT) {
  check(typeof value === 'string' && value.length > 0 && value.length <= max * 2 && Array.from(value).length <= max);
  return value;
}
function provider(value) { check(PROVIDERS.has(value)); return value; }
function timestamp(value) {
  text(value);
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  check(parts && Number.isFinite(Date.parse(value)));
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  // Date.parse alone rolls nonexistent dates such as February 30 into March.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(hour, minute, second, 0);
  check(calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day && calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute && calendar.getUTCSeconds() === second);
  return value;
}
function catalog(value) {
  object(value, ['generation', 'fingerprint']);
  return { generation: text(value.generation), fingerprint: text(value.fingerprint) };
}
function record(value, map) {
  object(value, ['id', 'map', 'category', 'level', 'state', 'position'], ['mappingEvidence']);
  const result = { id: text(value.id, TRANSFER_LIMITS.ID), map: text(value.map, TRANSFER_LIMITS.ID), category: value.category === null ? null : text(value.category, TRANSFER_LIMITS.ID), level: value.level === null ? null : text(value.level, TRANSFER_LIMITS.ID), state: value.state, position: null };
  check(result.map === map && typeof value.state === 'boolean');
  if (value.position !== null) {
    object(value.position, ['x', 'y', 'space']);
    const { x, y, space } = value.position;
    check(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= TRANSFER_LIMITS.COORDINATE && Math.abs(y) <= TRANSFER_LIMITS.COORDINATE);
    result.position = { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y, space: text(space, TRANSFER_LIMITS.ID) };
  }
  if (Object.hasOwn(value, 'mappingEvidence')) {
    object(value.mappingEvidence, ['namespace', 'id', 'mappingVersion']);
    check(value.mappingEvidence.namespace === 'appsample:gim:2');
    // This is only untrusted source evidence. Mapping code must independently authorize it.
    result.mappingEvidence = { namespace: 'appsample:gim:2', id: text(value.mappingEvidence.id, TRANSFER_LIMITS.ID), mappingVersion: text(value.mappingEvidence.mappingVersion) };
  }
  return result;
}
function observations(values, normalize, keyOf) {
  const invalid = new Set(); const issues = []; const entries = new Map();
  const mark = index => { if (!invalid.has(index)) { invalid.add(index); if (issues.length < 100) issues.push({ recordIndex: index, code: 'invalid-record' }); } };
  for (let i = 0; i < values.length; i++) {
    let value;
    try { value = normalize(values[i]); } catch (error) { if (!(error instanceof TransferValidationError)) throw error; mark(i); continue; }
    const key = keyOf(value); const encoded = JSON.stringify(value); const existing = entries.get(key);
    if (existing) {
      existing.indices.push(i);
      if (existing.conflict) mark(i);
      else if (existing.encoded !== encoded) { existing.conflict = true; for (const index of existing.indices) mark(index); }
    } else entries.set(key, { value, encoded, indices: [i], conflict: false });
  }
  if (invalid.size) throw new TransferValidationError('invalid-transfer', invalid.size, issues);
  return [...entries.values()].map(entry => entry.value);
}
function coverage(value) {
  object(value, ['categories', 'levels', 'complete']); check(typeof value.complete === 'boolean');
  const strings = items => [...new Set(array(items, TRANSFER_LIMITS.COVERAGE).map(item => text(item, TRANSFER_LIMITS.ID)))].sort();
  return { categories: strings(value.categories), levels: strings(value.levels), complete: value.complete };
}
/** Fully validate and detach a single provider/map envelope before returning any observations. @param {unknown} value @returns {TransferEnvelope} */
function validateTransfer(value) {
  object(value, ['format', 'version', 'producer', 'exportedAt', 'provider', 'adapterVersion', 'map', 'catalog', 'coverage', 'records']);
  check(value.format === 'genshin-map-overlay.transfer' && value.version === 1);
  object(value.producer, ['name', 'version']);
  const producer = { name: text(value.producer.name), version: text(value.producer.version) };
  const exportedAt = timestamp(value.exportedAt);
  const result = { format: 'genshin-map-overlay.transfer', version: 1, producer, exportedAt, provider: provider(value.provider), adapterVersion: text(value.adapterVersion), map: text(value.map, TRANSFER_LIMITS.ID), catalog: catalog(value.catalog), coverage: coverage(value.coverage), records: [] };
  array(value.records, TRANSFER_LIMITS.RECORDS);
  result.records = observations(value.records, row => record(row, result.map), row => row.id);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > TRANSFER_LIMITS.BYTES) fail('transfer-too-large');
  duplicateCounts.set(result, (duplicateCounts.get(value) || 0) + value.records.length - result.records.length);
  return result;
}
/** @param {Uint8Array} bytes @returns {TransferEnvelope} */
function parseTransfer(bytes) {
  if (!(bytes instanceof Uint8Array)) fail();
  if (bytes.byteLength > TRANSFER_LIMITS.BYTES) fail('transfer-too-large');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  return validateTransfer(value);
}
/** @param {TransferEnvelope} value @returns {Uint8Array} */
function serializeTransfer(value) { return new TextEncoder().encode(JSON.stringify(validateTransfer(value))); }
/** Timestamp/producer-independent content identity using browser Web Crypto. @param {TransferEnvelope} value @returns {Promise<string>} */
async function digestTransfer(value) {
  const v = validateTransfer(value);
  const ordered = { provider: v.provider, map: v.map, catalog: v.catalog, coverage: v.coverage, records: v.records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** In-memory count from the original validated file, propagated through revalidation.
 * Serialization emits collapsed observations; reparsing those new bytes starts at zero.
 * @param {TransferEnvelope} value @returns {number}
 */
function getTransferDuplicateCount(value) { return duplicateCounts.get(validateTransfer(value)); }
// Shared strict schema primitives for the local-only attachment codec.
const attachmentSchema = Object.freeze({ object, array, text, provider, catalog, record, observations, check, fail });
module.exports = { TransferValidationError, TRANSFER_LIMITS, parseTransfer, validateTransfer, serializeTransfer, digestTransfer, getTransferDuplicateCount, attachmentSchema };
