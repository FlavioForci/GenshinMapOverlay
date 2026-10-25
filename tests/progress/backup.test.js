'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportBackup, parseBackup, importProfiles } = require('../../src/progress/backup');
const { foundIds } = require('../../src/progress/merge');
const { ACTOR_A, ACTOR_B, PROFILE_A, PROFILE_B, makeState } = require('./helpers');
const bytes = value => Buffer.from(JSON.stringify(value));
function portable() { return { format: 'genshin-map-overlay.backup', version: 1, namespace: 'appsample:gim:2', profiles: [{ name: '<旅人> 🐉', region: '未知', foundIds: [42, 900000001], enabledTypes: ['o5', 'o900000001'], hideFound: true }] }; }
function draft() { return { version: 1, state: makeState({ found: { 42: false } }), clock: 1, revision: 1, dirtyRevision: 1, acknowledgedRevision: 0, selectedProfileId: PROFILE_A, migrationComplete: true, sync: null }; }

test('portable backups preserve effective unknown progress without private persistence fields', () => {
  const state = makeState({ name: '<旅人> 🐉', region: '未知', found: { 42: true, 99: false, 900000001: true }, enabledTypes: ['o5', 'o900000001'], hideFound: true });
  const output = exportBackup(state, [PROFILE_A]);
  assert.deepEqual(JSON.parse(output), portable());
  for (const secret of ['clock', 'actor', ACTOR_A, PROFILE_A, 'sync', 'path', 'token', 'revision']) assert.equal(output.includes(secret), false);
  assert.deepEqual(parseBackup(Buffer.from(output)), portable());
});

test('backup import creates a fresh profile and restamps effective progress', () => {
  const d = draft(); const existing = structuredClone(d.state.profiles[PROFILE_A]);
  assert.deepEqual(importProfiles(d, portable(), { actor: ACTOR_B, uuid: () => PROFILE_B }), [PROFILE_B]);
  const imported = d.state.profiles[PROFILE_B];
  assert.deepEqual(foundIds(imported), [42, 900000001]);
  assert.equal(imported.markers['42'].actor, ACTOR_B);
  assert.equal(imported.name.value, '<旅人> 🐉');
  assert.deepEqual(d.state.profiles[PROFILE_A], existing);
  assert.equal(d.state.profiles[PROFILE_A].markers['42'].value, false);
  assert.ok(imported.markers['42'].clock > 1);
});

for (const [label, mutate, code] of [
  ['newer', b => { b.version = 2; }, 'unsupported-version'],
  ['wrong namespace', b => { b.namespace = 'other'; }, 'invalid-backup'],
  ['extra private field', b => { b.token = 'private'; }, 'invalid-backup'],
  ['invalid marker', b => { b.profiles[0].foundIds.push('42'); }, 'invalid-backup'],
  ['invalid type', b => { b.profiles[0].enabledTypes.push('o0'); }, 'invalid-backup'],
  ['invalid name', b => { b.profiles[0].name = ' '; }, 'invalid-backup'],
  ['invalid boolean', b => { b.profiles[0].hideFound = 1; }, 'invalid-backup'],
  ['excess profiles', b => { b.profiles = Array(101).fill(b.profiles[0]); }, 'limit-exceeded'],
]) test(`portable parsing rejects whole ${label} backup`, () => {
  const b = portable(); mutate(b);
  assert.throws(() => parseBackup(bytes(b)), { code });
});

test('malformed, invalid UTF-8 and oversized bytes reject before import', () => {
  assert.throws(() => parseBackup(Buffer.from('{')), { code: 'invalid-backup' });
  assert.throws(() => parseBackup(Buffer.from([0xff])), { code: 'invalid-backup' });
  assert.throws(() => parseBackup(Buffer.alloc(4 * 1024 * 1024 + 1)), { code: 'limit-exceeded' });
  assert.throws(() => parseBackup('{}'), { code: 'invalid-backup' });
});

test('all portable profiles and generated identities validate before draft mutation', () => {
  for (const variant of ['last-invalid', 'collision', 'aggregate-limit', 'clock-overflow']) {
    const d = draft(); const b = portable(); b.profiles.push(structuredClone(b.profiles[0]));
    let index = 0;
    if (variant === 'last-invalid') b.profiles[1].foundIds = [0];
    if (variant === 'aggregate-limit') d.state.profiles = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, structuredClone(d.state.profiles[PROFILE_A])]));
    if (variant === 'clock-overflow') d.clock = Number.MAX_SAFE_INTEGER - 5;
    const before = structuredClone(d);
    assert.throws(() => importProfiles(d, b, { actor: ACTOR_B, uuid: () => variant === 'collision' ? PROFILE_A : `20000000-0000-4000-8000-${String(++index).padStart(12, '0')}` }));
    assert.deepEqual(d, before);
  }
});

test('export validates selected profile identities and portable byte ceiling', () => {
  assert.throws(() => exportBackup(makeState(), ['missing']));
  assert.throws(() => exportBackup(makeState(), [PROFILE_A, PROFILE_A]));
  const enabledTypes = Array.from({ length: 4096 }, (_, i) => `o${999999999999999 - i}`).sort();
  const profile = makeState({ enabledTypes }).profiles[PROFILE_A];
  const state = { namespace: 'appsample:gim:2', profiles: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, structuredClone(profile)])) };
  // Maximum valid type lists across 100 profiles exceed the portable body.
  assert.throws(() => exportBackup(state, Object.keys(state.profiles)), { code: 'limit-exceeded' });
});

for (const invalid of [[{ toString: null }, 'o5'], [null, 'o5'], [1, 'o5']]) test(`malformed type values reject safely: ${JSON.stringify(invalid)}`, () => {
  const b = portable(); b.profiles[0].enabledTypes = invalid;
  assert.throws(() => parseBackup(bytes(b)), { code: 'invalid-backup' });
});
