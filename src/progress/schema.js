'use strict';

/** @template T @typedef {{value:T, clock:number, actor:string}} Register */
/** @typedef {{name:Register<string>, region:Register<string>, enabledTypes:Register<string[]>, hideFound:Register<boolean>, markers:Record<string,Register<boolean>>}} Profile */
/** @typedef {{namespace:'appsample:gim:2', profiles:Record<string,Profile>}} ProgressState */
/** @typedef {{kind:'local'}|{kind:'account',accountKey:string}} Scope */
/** @typedef {{version:1,state:ProgressState,clock:number,revision:number,dirtyRevision:number,acknowledgedRevision:number,selectedProfileId:string|null,migrationComplete:boolean,sync:null}} LocalEnvelope */

const LIMITS = Object.freeze({
  LOCAL_ENVELOPE_BYTES: 16 * 1024 * 1024,
  PORTABLE_BODY_BYTES: 4 * 1024 * 1024,
  PROFILES: 100,
  MARKERS: 200000,
  ENABLED_TYPES: 4096,
  NAME_CODE_POINTS: 80,
  REGION_CODE_POINTS: 80,
  RECOVERY_BACKUPS: 10,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAMESPACE = 'appsample:gim:2';

class ProgressError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProgressError';
    this.code = code;
  }
}

function fail(code) { throw new ProgressError(code); }
function requireValue(condition, code) { if (!condition) fail(code); }
function counter(value) { return Number.isSafeInteger(value) && value >= 0; }

// Inspect descriptors before reading values so untrusted accessors never run.
function record(value, code, fields) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, code);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    requireValue(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), code);
  }
  if (fields) requireValue(keys.length === fields.length && fields.every(key => Object.hasOwn(value, key)), code);
  return keys;
}

function register(value, validate) {
  record(value, 'invalid-state', ['value', 'clock', 'actor']);
  requireValue(counter(value.clock) && value.clock > 0, 'invalid-state');
  requireValue(typeof value.actor === 'string' && UUID.test(value.actor), 'invalid-state');
  return { value: validate(value.value), clock: value.clock, actor: value.actor };
}
function text(value, max, name = false) {
  requireValue(typeof value === 'string', 'invalid-state');
  requireValue(Array.from(value).length <= max, 'limit-exceeded');
  if (name) requireValue(value.length > 0 && value === value.trim(), 'invalid-state');
  return value;
}
function boolean(value) {
  requireValue(typeof value === 'boolean', 'invalid-state');
  return value;
}
function types(value) {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'invalid-state');
  requireValue(value.length <= LIMITS.ENABLED_TYPES, 'limit-exceeded');
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length === value.length + 1, 'invalid-state');
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'invalid-state');
    const key = descriptor.value;
    requireValue(typeof key === 'string' && /^o[1-9]\d{0,14}$/.test(key) && Number.isSafeInteger(Number(key.slice(1))), 'invalid-state');
    requireValue(i === 0 || result[i - 1] < key, 'invalid-state');
    result.push(key);
  }
  return result;
}

/** Validate and copy canonical data, preserving unknown valid catalog identities. @returns {ProgressState} */
function validateState(value) {
  record(value, 'invalid-state', ['namespace', 'profiles']);
  requireValue(value.namespace === NAMESPACE, 'invalid-state');
  const profileIds = record(value.profiles, 'invalid-state');
  requireValue(profileIds.length <= LIMITS.PROFILES, 'limit-exceeded');
  const profiles = {};
  let markerCount = 0;
  for (const id of profileIds) {
    requireValue(UUID.test(id), 'invalid-state');
    const profile = value.profiles[id];
    record(profile, 'invalid-state', ['name', 'region', 'enabledTypes', 'hideFound', 'markers']);
    const markerIds = record(profile.markers, 'invalid-state');
    markerCount += markerIds.length;
    requireValue(markerCount <= LIMITS.MARKERS, 'limit-exceeded');
    const markers = {};
    for (const markerId of markerIds) {
      requireValue(/^[1-9]\d*$/.test(markerId) && Number.isSafeInteger(Number(markerId)), 'invalid-state');
      markers[markerId] = register(profile.markers[markerId], boolean);
    }
    profiles[id] = {
      name: register(profile.name, item => text(item, LIMITS.NAME_CODE_POINTS, true)),
      region: register(profile.region, item => text(item, LIMITS.REGION_CODE_POINTS)),
      enabledTypes: register(profile.enabledTypes, types),
      hideFound: register(profile.hideFound, boolean),
      markers,
    };
  }
  return { namespace: NAMESPACE, profiles };
}

function maxClock(state) {
  let clock = 0;
  for (const profile of Object.values(state.profiles)) {
    for (const field of ['name', 'region', 'enabledTypes', 'hideFound']) clock = Math.max(clock, profile[field].clock);
    for (const marker of Object.values(profile.markers)) clock = Math.max(clock, marker.clock);
  }
  return clock;
}

/** Validate local persistence. Account sync and transfer extension schemas are future owners' responsibilities. @returns {LocalEnvelope} */
function validateEnvelope(value, scope) {
  record(scope, 'invalid-scope');
  if (scope.kind === 'account') {
    record(scope, 'invalid-scope', ['kind', 'accountKey']);
    requireValue(typeof scope.accountKey === 'string' && /^[0-9a-f]{64}$/.test(scope.accountKey), 'invalid-scope');
    fail('unsupported-scope');
  }
  record(scope, 'invalid-scope', ['kind']);
  requireValue(scope.kind === 'local', 'invalid-scope');
  record(value, 'invalid-envelope');
  if (Number.isSafeInteger(value.version) && value.version > 1) fail('unsupported-version');
  record(value, 'invalid-envelope', ['version', 'state', 'clock', 'revision', 'dirtyRevision', 'acknowledgedRevision', 'selectedProfileId', 'migrationComplete', 'sync']);
  requireValue(value.version === 1, 'invalid-envelope');
  const state = validateState(value.state);
  for (const field of ['clock', 'revision', 'dirtyRevision', 'acknowledgedRevision']) requireValue(counter(value[field]), 'invalid-envelope');
  requireValue(value.clock >= maxClock(state), 'invalid-envelope');
  requireValue(value.acknowledgedRevision <= value.dirtyRevision && value.dirtyRevision <= value.revision, 'invalid-envelope');
  requireValue(value.selectedProfileId === null || (typeof value.selectedProfileId === 'string' && Object.hasOwn(state.profiles, value.selectedProfileId)), 'invalid-envelope');
  requireValue(typeof value.migrationComplete === 'boolean' && value.sync === null, 'invalid-envelope');
  const result = {
    version: 1, state, clock: value.clock, revision: value.revision,
    dirtyRevision: value.dirtyRevision, acknowledgedRevision: value.acknowledgedRevision,
    selectedProfileId: value.selectedProfileId, migrationComplete: value.migrationComplete, sync: null,
  };
  requireValue(Buffer.byteLength(JSON.stringify(result), 'utf8') <= LIMITS.LOCAL_ENVELOPE_BYTES, 'limit-exceeded');
  return result;
}

module.exports = { ProgressError, LIMITS, validateState, validateEnvelope };
