'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_PROFILE_PREFERENCES } = require('../config');
const { ProgressError, LIMITS, validateState } = require('./schema');
const { nextClock } = require('./merge');
const { readFileBounded } = require('./atomic-file');

const LOCAL = Object.freeze({ kind: 'local' });
const pending = new WeakMap();
const MAX_LEGACY_BYTES = LIMITS.PORTABLE_BODY_BYTES;

function recovery() { throw new ProgressError('local-recovery-required'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function readLegacy(file, readFile) {
  try {
    const value = await readFile(file);
    if (!Buffer.isBuffer(value) || value.length > MAX_LEGACY_BYTES) recovery();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    recovery();
  }
}
function parse(bytes) {
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { recovery(); }
  if (!object(value)) recovery();
  return value;
}
function legacyProfile(foundBytes, settingsBytes, actor, profileId) {
  const found = parse(foundBytes);
  const settings = parse(settingsBytes);
  let ids = [];
  if (found !== null) {
    if (!Array.isArray(found.ids) || !found.ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) recovery();
    ids = [...new Set(found.ids)];
  }
  const types = settings && Object.hasOwn(settings, 'enabledTypes') ? settings.enabledTypes : DEFAULT_PROFILE_PREFERENCES.enabledTypes;
  const hideFound = settings && Object.hasOwn(settings, 'hideFound') ? settings.hideFound : DEFAULT_PROFILE_PREFERENCES.hideFound;
  if (!Array.isArray(types) || !types.every(key => typeof key === 'string') || typeof hideFound !== 'boolean') recovery();
  const register = value => ({ value, clock: 1, actor });
  const profile = {
    name: register('Local progress'), region: register(''),
    enabledTypes: register([...new Set(types)].sort()), hideFound: register(hideFound),
    markers: Object.fromEntries(ids.map(id => [String(id), register(true)])),
  };
  try { validateState({ namespace: 'appsample:gim:2', profiles: { [profileId]: profile } }); } catch { recovery(); }
  return profile;
}

async function migrate({ repository, userData, readFile, uuid = randomUUID }) {
  const identity = await repository.init();
  const before = await repository.load(LOCAL);
  if (before.migrationComplete) return before;
  const reader = readFile || (file => readFileBounded(file, MAX_LEGACY_BYTES, fs));
  const found = await readLegacy(path.join(userData, 'found.json'), reader);
  const settings = await readLegacy(path.join(userData, 'settings.json'), reader);
  const profileId = uuid();
  const profile = legacyProfile(found, settings, identity.writerId, profileId);
  await repository.preserveLegacyBackup({ found, settings });
  return repository.transact(LOCAL, draft => {
    if (draft.migrationComplete) return;
    // An incomplete migration is an uninitialized store; silently overwriting
    // preexisting canonical progress or colliding IDs would lose recovery data.
    if (Object.keys(draft.state.profiles).length !== 0) recovery();
    const clock = nextClock(draft.clock, draft.state);
    for (const field of ['name', 'region', 'enabledTypes', 'hideFound']) profile[field].clock = clock;
    for (const marker of Object.values(profile.markers)) marker.clock = clock;
    draft.state.profiles[profileId] = profile;
    draft.clock = clock;
    draft.selectedProfileId = profileId;
    draft.migrationComplete = true;
  });
}

/**
 * Import legacy files exactly once. Only ENOENT means absent; malformed/read
 * failures require local recovery, and source files are never modified. Raw
 * bytes are durably archived before one atomic profile/preferences/flag commit.
 * Concurrent callers on the owning repository share the same attempt. A failed
 * attempt may be retried; a completed flag prevents all later legacy reads.
 * @param {{repository:import('./repository').ProgressRepository,userData:string,readFile?:(file:string)=>Promise<Buffer>,uuid?:()=>string}} options
 * @returns {Promise<import('./schema').LocalEnvelope>}
 */
function migrateLegacy(options) {
  const repository = options.repository;
  if (pending.has(repository)) return pending.get(repository);
  const operation = migrate(options);
  pending.set(repository, operation);
  operation.then(() => pending.delete(repository), () => pending.delete(repository));
  return operation;
}

module.exports = { migrateLegacy };
