'use strict';

const { createHash } = require('node:crypto');
const { PROVIDER_IDS } = require('../../src/transfer/capabilities');

/** @typedef {{id:string,map:string,category:string|null,level:string|null,state:boolean,position:{x:number,y:number,space:string}|null,mappingEvidence?:{namespace:'appsample:gim:2',id:string,mappingVersion:string}}} TransferRecord */

function requireValue(condition) {
  if (!condition) throw Object.assign(new Error('invalid-catalog-input'), { code: 'invalid-catalog-input' });
}
function shape(value, fields, optional = []) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireValue(fields.every(key => Object.hasOwn(value, key)) && keys.every(key => [...fields, ...optional].includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function text(value) { requireValue(typeof value === 'string' && value.length > 0); }
function records(value, map) {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
    const item = descriptor.value;
    shape(item, ['id', 'map', 'category', 'level', 'state', 'position'], ['mappingEvidence']);
    text(item.id); requireValue(item.map === map);
    for (const field of ['category', 'level']) if (item[field] !== null) text(item[field]);
    requireValue(typeof item.state === 'boolean');
    if (item.position !== null) {
      shape(item.position, ['x', 'y', 'space']);
      requireValue(Number.isFinite(item.position.x) && Number.isFinite(item.position.y));
      text(item.position.space);
    }
    if (Object.hasOwn(item, 'mappingEvidence')) {
      shape(item.mappingEvidence, ['namespace', 'id', 'mappingVersion']);
      requireValue(item.mappingEvidence.namespace === 'appsample:gim:2');
      text(item.mappingEvidence.id); text(item.mappingEvidence.mappingVersion);
    }
  }
}

/** Measure normalized metadata only; this tool neither imports progress nor asserts completeness.
 * Duplicate rows are included in the counts and fingerprint for honest partial-catalog reporting.
 * Fingerprints are SHA-256 of JSON [provider,map,sorted [id,map,category,level,[x,y,space]|null] rows].
 * State, mapping claims, input property order and input row order do not affect catalog identity.
 * @param {{provider:import('../../src/transfer/capabilities').ProviderId,map:string,catalog:TransferRecord[],progress:TransferRecord[]}} input
 */
function catalogReport(input) {
  shape(input, ['provider', 'map', 'catalog', 'progress']);
  const { provider, map, catalog, progress } = input;
  requireValue(PROVIDER_IDS.includes(provider)); text(map);
  records(catalog, map); records(progress, map);
  const rows = catalog.map(record => JSON.stringify([record.id, record.map, record.category, record.level, record.position === null ? null : [record.position.x, record.position.y, record.position.space]])).sort();
  const catalogFingerprint = createHash('sha256').update(JSON.stringify([provider, map, rows.map(row => JSON.parse(row))])).digest('hex');
  const categories = new Set(); const levels = new Set();
  let maxIdLength = 0; let maxStringLength = 0; let maxAbsCoordinate = 0;
  for (const collection of [catalog, progress]) for (const record of collection) {
    maxIdLength = Math.max(maxIdLength, Array.from(record.id).length);
    const strings = [record.id, record.map, record.category, record.level];
    if (record.position !== null) {
      maxAbsCoordinate = Math.max(maxAbsCoordinate, Math.abs(record.position.x), Math.abs(record.position.y));
      strings.push(record.position.space);
    }
    if (record.mappingEvidence) strings.push(...Object.values(record.mappingEvidence));
    for (const value of strings) if (value !== null) maxStringLength = Math.max(maxStringLength, Array.from(value).length);
  }
  for (const record of catalog) {
    if (record.category !== null) categories.add(record.category);
    if (record.level !== null) levels.add(record.level);
  }
  return { provider, map, catalogFingerprint, catalogCount: catalog.length, progressRecordCount: progress.length, progressBytes: Buffer.byteLength(JSON.stringify(progress), 'utf8'), categories: [...categories].sort(), levels: [...levels].sort(), maxIdLength, maxStringLength, maxAbsCoordinate };
}

// Explicit developer CLI arguments are the only source of filesystem paths.
// Transfer JSON is an array of strict records; no path, URL or executable field is read.
if (require.main === module) {
  try {
    const fs = require('node:fs');
    const flags = ['--provider', '--map', '--catalog', '--progress', '--out'];
    const args = process.argv.slice(2); const values = {};
    if (args.length !== flags.length * 2) throw new Error('invalid-catalog-arguments');
    for (let i = 0; i < args.length; i += 2) {
      if (!flags.includes(args[i]) || Object.hasOwn(values, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid-catalog-arguments');
      values[args[i]] = args[i + 1];
    }
    const read = filename => {
      if (fs.statSync(filename).size > 256 * 1024 * 1024) throw new Error('catalog-file-too-large');
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    };
    const report = catalogReport({ provider: values['--provider'], map: values['--map'], catalog: read(values['--catalog']), progress: read(values['--progress']) });
    fs.writeFileSync(values['--out'], JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    // Never echo potentially private path/input contents in diagnostics.
    process.stderr.write(['invalid-catalog-arguments', 'catalog-file-too-large', 'invalid-catalog-input'].includes(error.message) ? error.message + '\n' : 'catalog-report-failed\n');
    process.exitCode = 1;
  }
}

module.exports = { catalogReport };
