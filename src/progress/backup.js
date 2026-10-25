'use strict';

const { TextDecoder } = require('node:util');
const { ProgressError, LIMITS, validateState } = require('./schema');
const { foundIds } = require('./merge');
const FORMAT = 'genshin-map-overlay.backup';
const NAMESPACE = 'appsample:gim:2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALIDATION_ACTOR = '00000000-0000-4000-8000-000000000000';
function fail(code = 'invalid-backup') { throw new ProgressError(code); }
function record(value, fields) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) fail();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); }
}
function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (value.length > maximum) fail('limit-exceeded');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); }
}
function portable(value) {
  // Inspect version only after validating its data descriptor, without invoking accessors.
  record(value, ['format', 'version', 'namespace', 'profiles']);
  if (Number.isSafeInteger(value.version) && value.version > 1) fail('unsupported-version');
  if (value.format !== FORMAT || value.version !== 1 || value.namespace !== NAMESPACE) fail();
  array(value.profiles, LIMITS.PROFILES);
  if (!value.profiles.length) fail();
  const profiles = []; let count = 0;
  for (const item of value.profiles) {
    record(item, ['name', 'region', 'foundIds', 'enabledTypes', 'hideFound']);
    array(item.foundIds, LIMITS.MARKERS); array(item.enabledTypes, LIMITS.ENABLED_TYPES);
    count += item.foundIds.length;
    if (count > LIMITS.MARKERS) fail('limit-exceeded');
    if (!item.foundIds.every(id => Number.isSafeInteger(id) && id > 0)) fail();
    // Reuse authoritative canonical text/type validation via a synthetic profile.
    const reg = value => ({ value, clock: 1, actor: VALIDATION_ACTOR });
    if (!item.enabledTypes.every(key => typeof key === 'string')) fail();
    const enabledTypes = [...new Set(item.enabledTypes)].sort();
    try {
      validateState({ namespace: NAMESPACE, profiles: { [VALIDATION_ACTOR]: { name: reg(item.name), region: reg(item.region), enabledTypes: reg(enabledTypes), hideFound: reg(item.hideFound), markers: {} } } });
    } catch (error) { fail(error.code === 'limit-exceeded' ? error.code : 'invalid-backup'); }
    profiles.push({ name: item.name, region: item.region, foundIds: [...new Set(item.foundIds)].sort((a, b) => a - b), enabledTypes, hideFound: item.hideFound });
  }
  const result = { format: FORMAT, version: 1, namespace: NAMESPACE, profiles };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.PORTABLE_BODY_BYTES) fail('limit-exceeded');
  return result;
}

/** @typedef {{format:'genshin-map-overlay.backup',version:1,namespace:'appsample:gim:2',profiles:Array<{name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}>}} PortableBackup */

/** Export only effective progress; never include local IDs, clocks, actors or metadata. @param {import('./schema').ProgressState} state @param {string[]} profileIds @returns {string} */
function exportBackup(state, profileIds) {
  const valid = validateState(state);
  array(profileIds, LIMITS.PROFILES);
  if (!profileIds.length || new Set(profileIds).size !== profileIds.length) fail();
  const profiles = profileIds.map(id => {
    if (typeof id !== 'string' || !Object.hasOwn(valid.profiles, id)) fail('profile-not-found');
    const p = valid.profiles[id];
    return { name: p.name.value, region: p.region.value, foundIds: foundIds(p), enabledTypes: p.enabledTypes.value, hideFound: p.hideFound.value };
  });
  return JSON.stringify(portable({ format: FORMAT, version: 1, namespace: NAMESPACE, profiles }));
}

/** Validate the entire bounded UTF-8 body before returning detached portable data. @param {Buffer} bytes @returns {PortableBackup} */
function parseBackup(bytes) {
  if (!Buffer.isBuffer(bytes)) fail();
  if (bytes.length > LIMITS.PORTABLE_BODY_BYTES) fail('limit-exceeded');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  return portable(value);
}

/**
 * Copy effective progress into fresh UUID profiles, using only local stamps.
 * Validate portable input, every generated ID, clocks and aggregate state before
 * changing the draft. Existing explicit undo registers remain intact.
 * @param {import('./schema').LocalEnvelope} draft
 * @param {PortableBackup} backup
 * @param {{actor:string,uuid:()=>string}} options
 * @returns {string[]}
 */
function importProfiles(draft, backup, { actor, uuid }) {
  const input = portable(backup);
  if (typeof actor !== 'string' || !UUID.test(actor) || typeof uuid !== 'function') fail('invalid-command');
  if (Object.keys(draft.state.profiles).length + input.profiles.length > LIMITS.PROFILES) fail('limit-exceeded');
  const ids = input.profiles.map(() => uuid()); const used = new Set(Object.keys(draft.state.profiles));
  for (const id of ids) { if (typeof id !== 'string' || !UUID.test(id) || used.has(id)) fail('invalid-profile'); used.add(id); }
  const registers = input.profiles.reduce((count, item) => count + 4 + item.foundIds.length, 0);
  if (!Number.isSafeInteger(draft.clock) || draft.clock < 0) fail('invalid-clock');
  if (draft.clock > Number.MAX_SAFE_INTEGER - registers) fail('clock-exhausted');
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) fail('invalid-envelope');
  if (draft.revision === Number.MAX_SAFE_INTEGER) fail('revision-exhausted');
  let clock = draft.clock;
  const reg = value => ({ value, clock: ++clock, actor });
  const profiles = { ...draft.state.profiles };
  input.profiles.forEach((item, index) => {
    profiles[ids[index]] = {
      name: reg(item.name), region: reg(item.region), enabledTypes: reg(item.enabledTypes), hideFound: reg(item.hideFound),
      markers: Object.fromEntries(item.foundIds.map(id => [String(id), reg(true)])),
    };
  });
  const state = validateState({ namespace: NAMESPACE, profiles });
  draft.state = state; draft.clock = clock; draft.dirtyRevision = draft.revision + 1;
  return ids;
}

module.exports = { exportBackup, parseBackup, importProfiles };
