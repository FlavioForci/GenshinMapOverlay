'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfile, renameProfile, setFound, setPreferences } = require('../../src/progress/profiles');
const { validateEnvelope } = require('../../src/progress/schema');
const { ACTOR_A, ACTOR_B, PROFILE_A, PROFILE_B, makeState } = require('./helpers');
function draft() { return { version: 1, state: makeState(), clock: 1, revision: 1, dirtyRevision: 1, acknowledgedRevision: 0, selectedProfileId: PROFILE_A, migrationComplete: true, sync: null }; }

test('desired values are replayable and explicit false remains a register', () => {
  const d = draft();
  setFound(d, { profileId: PROFILE_A, id: 42, found: true }, ACTOR_B);
  const once = structuredClone(d);
  setFound(d, { profileId: PROFILE_A, id: 42, found: true }, ACTOR_B);
  assert.deepEqual(d, once);
  setFound(d, { profileId: PROFILE_A, id: 42, found: false }, ACTOR_B);
  assert.deepEqual(d.state.profiles[PROFILE_A].markers['42'], { value: false, clock: 3, actor: ACTOR_B });
  assert.equal(d.dirtyRevision, 2);
  assert.equal(d.revision, 1);
  const absent = draft();
  setFound(absent, { profileId: PROFILE_A, id: 9, found: false }, ACTOR_B);
  assert.equal(absent.state.profiles[PROFILE_A].markers['9'].value, false);
});

test('profile creation uses defaults, trims Unicode names and preserves region', () => {
  const d = draft();
  assert.equal(createProfile(d, { id: PROFILE_B, name: '  <旅人> 🐉  ', region: 'Europe' }, ACTOR_B), PROFILE_B);
  const p = d.state.profiles[PROFILE_B];
  assert.equal(p.name.value, '<旅人> 🐉');
  assert.equal(p.region.value, 'Europe');
  assert.deepEqual(p.enabledTypes.value, ['o141', 'o194', 'o403', 'o5', 'o508', 'o6', 'o626', 'o694', 'o833']);
  assert.equal(p.hideFound.value, false);
  assert.equal(d.clock, 5);
  assert.equal(p.name.actor, ACTOR_B);
  assert.equal(validateEnvelope({ ...d, revision: 2 }, { kind: 'local' }).dirtyRevision, 2);
});

test('metadata and preferences change only requested effective registers', () => {
  const d = draft();
  renameProfile(d, { id: PROFILE_A, name: ' Main ', region: '' }, ACTOR_B);
  setPreferences(d, { profileId: PROFILE_A, enabledTypes: ['o5', 'o5'], hideFound: false }, ACTOR_B);
  assert.equal(d.clock, 1);
  renameProfile(d, { id: PROFILE_A, name: '旅人 <b>', region: '未知' }, ACTOR_B);
  setPreferences(d, { profileId: PROFILE_A, enabledTypes: ['o900000001', 'o5', 'o6', 'o5'], hideFound: true }, ACTOR_B);
  assert.equal(d.clock, 5);
  assert.deepEqual(d.state.profiles[PROFILE_A].enabledTypes.value, ['o5', 'o6', 'o900000001']);
  const before = structuredClone(d);
  setPreferences(d, { profileId: PROFILE_A, enabledTypes: ['o6', 'o5', 'o900000001'], hideFound: true }, ACTOR_B);
  assert.deepEqual(d, before);
});

for (const [label, operation] of [
  ['bad marker', d => setFound(d, { profileId: PROFILE_A, id: '42', found: true }, ACTOR_A)],
  ['bad boolean', d => setFound(d, { profileId: PROFILE_A, id: 42, found: 1 }, ACTOR_A)],
  ['bad actor', d => setFound(d, { profileId: PROFILE_A, id: 42, found: true }, 'actor')],
  ['unknown profile', d => renameProfile(d, { id: PROFILE_B, name: 'No' }, ACTOR_A)],
  ['empty name', d => renameProfile(d, { id: PROFILE_A, name: '  ' }, ACTOR_A)],
  ['long Unicode name', d => renameProfile(d, { id: PROFILE_A, name: '🐉'.repeat(81) }, ACTOR_A)],
  ['duplicate profile', d => createProfile(d, { id: PROFILE_A, name: 'No', region: '' }, ACTOR_A)],
  ['invalid preference patch', d => setPreferences(d, { profileId: PROFILE_A, enabledTypes: ['o0'], hideFound: true }, ACTOR_A)],
  ['unknown patch field', d => setPreferences(d, { profileId: PROFILE_A, secret: 'No' }, ACTOR_A)],
]) test(`invalid operation leaves draft unchanged: ${label}`, () => {
  const d = draft(); const before = structuredClone(d);
  assert.throws(() => operation(d));
  assert.deepEqual(d, before);
});

test('clock overflow is atomic and no-op remains possible at exhaustion', () => {
  const d = draft(); d.clock = Number.MAX_SAFE_INTEGER - 1;
  const before = structuredClone(d);
  assert.throws(() => renameProfile(d, { id: PROFILE_A, name: 'New', region: 'EU' }, ACTOR_A), { code: 'clock-exhausted' });
  assert.deepEqual(d, before);
  d.clock = Number.MAX_SAFE_INTEGER;
  setPreferences(d, { profileId: PROFILE_A, hideFound: false }, ACTOR_A);
  assert.equal(d.clock, Number.MAX_SAFE_INTEGER);
});

test('bulk desired setters do not rescan unrelated marker registers', () => {
  const d = draft();
  Object.defineProperty(d.state.profiles[PROFILE_A].markers, '999', { enumerable: true, get() { throw Error('full-state rescan'); } });
  for (let id = 1; id <= 500; id++) setFound(d, { profileId: PROFILE_A, id, found: true }, ACTOR_B);
  assert.equal(d.clock, 501);
});
