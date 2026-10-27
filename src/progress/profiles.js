'use strict';

const { ProgressError, LIMITS } = require('./schema');
const { DEFAULT_PROFILE_PREFERENCES } = require('../config');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code = 'invalid-command') { throw new ProgressError(code); }
function command(value, required, optional = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!required.includes(key) && !optional.includes(key)) fail();
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  if (!required.every(key => Object.hasOwn(descriptors, key))) fail();
}
function text(value, maximum, trim = false) {
  if (typeof value !== 'string') fail();
  const result = trim ? value.trim() : value;
  if (Array.from(result).length > maximum) fail('limit-exceeded');
  if (trim && !result.length) fail();
  return result;
}
function types(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (value.length > LIMITS.ENABLED_TYPES) fail('limit-exceeded');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    const key = descriptor.value;
    if (typeof key !== 'string' || !/^o[1-9]\d{0,14}$/.test(key) || !Number.isSafeInteger(Number(key.slice(1)))) fail();
    result.push(key);
  }
  return [...new Set(result)].sort();
}
function actorId(actor) { if (typeof actor !== 'string' || !UUID.test(actor)) fail(); }
function profile(draft, id) {
  if (typeof id !== 'string' || !UUID.test(id) || !Object.hasOwn(draft.state.profiles, id)) fail('profile-not-found');
  return draft.state.profiles[id];
}
function same(a, b) { return Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]) : a === b; }
function budget(draft, count) {
  if (!count) return;
  if (!Number.isSafeInteger(draft.clock) || draft.clock < 0) fail('invalid-clock');
  if (draft.clock > Number.MAX_SAFE_INTEGER - count) fail('clock-exhausted');
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) fail('invalid-envelope');
  if (draft.revision === Number.MAX_SAFE_INTEGER) fail('revision-exhausted');
}
function apply(draft, target, values, actor) {
  const changes = Object.entries(values).filter(([field, value]) => !target[field] || !same(target[field].value, value));
  budget(draft, changes.length);
  for (const [field, value] of changes) target[field] = { value, clock: ++draft.clock, actor };
  if (changes.length) draft.dirtyRevision = draft.revision + 1;
}

/**
 * Draft commands are main-process helpers for an already validated, clock-covered
 * repository transaction. They validate their inputs before modifying the draft;
 * the repository validates aggregate state/size at commit. Marker edits are O(1).
 * @param {import('./schema').LocalEnvelope} draft
 * @param {{id:string,name:string,region:string}} input
 * @param {string} actor
 * @returns {string}
 */
function createProfile(draft, input, actor) {
  command(input, ['id', 'name', 'region']); actorId(actor);
  const { id } = input;
  if (typeof id !== 'string' || !UUID.test(id) || Object.hasOwn(draft.state.profiles, id)) fail('invalid-profile');
  if (Object.keys(draft.state.profiles).length >= LIMITS.PROFILES) fail('limit-exceeded');
  const values = { name: text(input.name, LIMITS.NAME_CODE_POINTS, true), region: text(input.region, LIMITS.REGION_CODE_POINTS), enabledTypes: [...DEFAULT_PROFILE_PREFERENCES.enabledTypes].sort(), hideFound: DEFAULT_PROFILE_PREFERENCES.hideFound };
  budget(draft, 4);
  const created = { markers: {} };
  apply(draft, created, values, actor);
  draft.state.profiles[id] = created;
  return id;
}

/** @param {import('./schema').LocalEnvelope} draft @param {{id:string,name?:string,region?:string}} input @param {string} actor @returns {void} */
function renameProfile(draft, input, actor) {
  command(input, ['id'], ['name', 'region']); actorId(actor);
  const target = profile(draft, input.id); const values = {};
  if (Object.hasOwn(input, 'name')) values.name = text(input.name, LIMITS.NAME_CODE_POINTS, true);
  if (Object.hasOwn(input, 'region')) values.region = text(input.region, LIMITS.REGION_CODE_POINTS);
  apply(draft, target, values, actor);
}

/** @param {import('./schema').LocalEnvelope} draft @param {{profileId:string,id:number,found:boolean}} input @param {string} actor @returns {void} */
function setFound(draft, input, actor) {
  command(input, ['profileId', 'id', 'found']); actorId(actor);
  const target = profile(draft, input.profileId);
  if (!Number.isSafeInteger(input.id) || input.id <= 0 || typeof input.found !== 'boolean') fail();
  apply(draft, target.markers, { [String(input.id)]: input.found }, actor);
}

/** @param {import('./schema').LocalEnvelope} draft @param {{profileId:string,enabledTypes?:string[],hideFound?:boolean}} input @param {string} actor @returns {void} */
function setPreferences(draft, input, actor) {
  command(input, ['profileId'], ['enabledTypes', 'hideFound']); actorId(actor);
  const target = profile(draft, input.profileId); const values = {};
  if (Object.hasOwn(input, 'enabledTypes')) values.enabledTypes = types(input.enabledTypes);
  if (Object.hasOwn(input, 'hideFound')) {
    if (typeof input.hideFound !== 'boolean') fail();
    values.hideFound = input.hideFound;
  }
  apply(draft, target, values, actor);
}

module.exports = { createProfile, renameProfile, setFound, setPreferences };
