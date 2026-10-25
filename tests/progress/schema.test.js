'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProgressError, LIMITS, validateState, validateEnvelope } = require('../../src/progress/schema');
const { ACTOR_A, PROFILE_A, makeState } = require('./helpers');

function envelope(state = makeState()) {
  return { version: 1, state, clock: 1, revision: 1, dirtyRevision: 1, acknowledgedRevision: 0, selectedProfileId: PROFILE_A, migrationComplete: true, sync: null };
}
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof ProgressError && (!code || error.code === code));
}

test('unknown identities and profile text survive validation', () => {
  const state = makeState({ found: { 900000001: true }, name: '旅人 <img onerror=alert(1)>', enabledTypes: ['o5', 'o999999'] });
  const valid = validateState(state);
  assert.equal(valid.profiles[PROFILE_A].markers['900000001'].value, true);
  assert.equal(valid.profiles[PROFILE_A].name.value, '旅人 <img onerror=alert(1)>');
  assert.ok(valid.profiles[PROFILE_A].enabledTypes.value.includes('o999999'));
  assert.deepEqual(state, valid);
});

test('empty initial state and local envelope validate', () => {
  const value = envelope({ namespace: 'appsample:gim:2', profiles: {} });
  Object.assign(value, { clock: 0, revision: 0, dirtyRevision: 0, selectedProfileId: null, migrationComplete: false });
  assert.deepEqual(validateEnvelope(value, { kind: 'local' }), value);
});

test('wrong namespaces and undeclared canonical fields are rejected', () => {
  for (const change of [s => { s.namespace = 'appsample:gim:3'; }, s => { s.version = 2; }, s => { s.profiles[PROFILE_A].extra = true; }, s => { s.profiles[PROFILE_A].name.extra = true; }]) {
    const state = makeState(); change(state); rejects(() => validateState(state));
  }
});

test('register clocks actors and values must have their declared types', () => {
  for (const clock of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const state = makeState(); state.profiles[PROFILE_A].name.clock = clock; rejects(() => validateState(state));
  }
  for (const actor of ['no-uuid', ACTOR_A.toUpperCase().replace('4000', 'ABCD'), '__proto__', null]) {
    const state = makeState(); state.profiles[PROFILE_A].name.actor = actor; rejects(() => validateState(state));
  }
  for (const change of [p => { p.markers['42'] = { value: 'true', clock: 1, actor: ACTOR_A }; }, p => { p.hideFound.value = 1; }, p => { p.region.value = null; }, p => { delete p.name.actor; }]) {
    const state = makeState(); change(state.profiles[PROFILE_A]); rejects(() => validateState(state));
  }
});

test('marker and profile keys must be canonical safe identities', () => {
  for (const key of ['0', '-1', '01', '1.5', '1e2', '9007199254740992', 'constructor', 'prototype', '__proto__']) {
    const state = makeState();
    Object.defineProperty(state.profiles[PROFILE_A].markers, key, { value: { value: true, clock: 1, actor: ACTOR_A }, enumerable: true });
    rejects(() => validateState(state));
  }
  for (const key of ['bad', PROFILE_A.toUpperCase().replace('4000', 'ABCD'), 'constructor', '__proto__']) {
    const state = makeState(); state.profiles = Object.fromEntries([[key, state.profiles[PROFILE_A]]]); rejects(() => validateState(state));
  }
  assert.equal(validateState(makeState({ found: { [Number.MAX_SAFE_INTEGER]: true } })).profiles[PROFILE_A].markers['9007199254740991'].value, true);
});

test('enabled types must be sorted unique safe keys within the type limit', () => {
  for (const enabledTypes of [['o0'], ['o01'], ['o-1'], ['o9007199254740992'], ['o1000000000000000'], ['o5', 'o5'], ['o5', 'o10'], [5], 'o5']) {
    const state = makeState(); state.profiles[PROFILE_A].enabledTypes.value = enabledTypes; rejects(() => validateState(state));
  }
  const types = Array.from({ length: 4096 }, (_, i) => `o${i + 1}`).sort();
  assert.equal(validateState(makeState({ enabledTypes: types })).profiles[PROFILE_A].enabledTypes.value.length, 4096);
  rejects(() => validateState(makeState({ enabledTypes: [...types, 'o999999'].sort() })), 'limit-exceeded');
});

test('Unicode name and region bounds reject without truncation', () => {
  assert.equal(validateState(makeState({ name: '旅'.repeat(80), region: '🗺'.repeat(80) })).profiles[PROFILE_A].region.value, '🗺'.repeat(80));
  for (const name of ['', ' ', ' Main', 'Main ', '旅'.repeat(81)]) rejects(() => validateState(makeState({ name })));
  rejects(() => validateState(makeState({ region: '🗺'.repeat(81) })), 'limit-exceeded');
});

test('profile and aggregate marker bounds reject the first excess item', () => {
  const profile = makeState().profiles[PROFILE_A];
  const profiles = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, structuredClone(profile)]));
  assert.equal(Object.keys(validateState({ namespace: 'appsample:gim:2', profiles }).profiles).length, 100);
  profiles['20000000-0000-4000-8000-000000000001'] = profile;
  rejects(() => validateState({ namespace: 'appsample:gim:2', profiles }), 'limit-exceeded');
  const state = makeState();
  const markers = state.profiles[PROFILE_A].markers;
  for (let i = 1; i <= 200000; i++) markers[i] = { value: false, clock: 1, actor: ACTOR_A };
  assert.equal(Object.keys(validateState(state).profiles[PROFILE_A].markers).length, 200000);
  state.profiles['10000000-0000-4000-8000-000000000002'] = makeState({ found: { 42: true } }).profiles[PROFILE_A];
  rejects(() => validateState(state), 'limit-exceeded');
});

test('prototype shaped accessors hidden fields symbols and sparse arrays are rejected', () => {
  const cases = [
    () => Object.assign(Object.create({ polluted: true }), makeState()),
    () => { const s = makeState(); Object.defineProperty(s, 'hidden', { value: true }); return s; },
    () => { const s = makeState(); s[Symbol('hidden')] = true; return s; },
    () => { const s = makeState(); Object.defineProperty(s.profiles[PROFILE_A].name, 'value', { get() { throw Error('must not execute'); } }); return s; },
    () => { const s = makeState(); s.profiles[PROFILE_A].enabledTypes.value = new Array(1); return s; },
    () => { const s = makeState(); s.profiles[PROFILE_A].enabledTypes.value.extra = true; return s; },
    () => { const s = makeState(); Object.defineProperty(s.profiles, '__proto__', { value: {} }); return s; },
  ];
  for (const create of cases) rejects(() => validateState(create()));
});

test('envelope counters selection scope and local sync are validated', () => {
  assert.deepEqual(validateEnvelope(envelope(), { kind: 'local' }), envelope());
  for (const field of ['clock', 'revision', 'dirtyRevision', 'acknowledgedRevision']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const e = envelope(); e[field] = value; rejects(() => validateEnvelope(e, { kind: 'local' }));
    }
  }
  for (const change of [e => { e.selectedProfileId = ACTOR_A; }, e => { e.migrationComplete = 1; }, e => { e.sync = {}; }, e => { e.extensions = {}; }, e => { e.revision = 0; }, e => { e.acknowledgedRevision = 2; }, e => { e.clock = 0; }]) {
    const e = envelope(); change(e); rejects(() => validateEnvelope(e, { kind: 'local' }));
  }
  for (const scope of [null, {}, { kind: 'unknown' }, { kind: 'local', accountKey: 'x' }, { kind: 'account', accountKey: 'x' }]) rejects(() => validateEnvelope(envelope(), scope));
});

test('newer envelope schemas are rejected without rewriting them', () => {
  const value = { ...envelope(), version: 2, future: { preserved: true } };
  const original = structuredClone(value);
  rejects(() => validateEnvelope(value, { kind: 'local' }), 'unsupported-version');
  assert.deepEqual(value, original);
});

test('local envelope byte limit includes UTF-8 and rejects rather than truncating', () => {
  const value = envelope();
  const records = Array.from({ length: 120000 }, (_, i) => ({ provider: 'bwiki', map: 'other', catalog: { generation: 'old', fingerprint: 'opaque' }, record: { id: String(i), map: 'other', category: '🐉'.repeat(128), level: '🐉'.repeat(128), state: true, position: null }, mapping: null }));
  value.extensions = { transfer: { version: 1, profiles: { [PROFILE_A]: { version: 1, records, imports: [] } } } };
  // Valid attachment strings fit under 128 MiB in UTF-16 code units but exceed it as UTF-8.
  const serialized = JSON.stringify(value);
  assert.ok(serialized.length <= LIMITS.LOCAL_ENVELOPE_BYTES);
  assert.ok(Buffer.byteLength(serialized) > LIMITS.LOCAL_ENVELOPE_BYTES);
  rejects(() => validateEnvelope(value, { kind: 'local' }), 'limit-exceeded');
  assert.equal(value.extensions.transfer.profiles[PROFILE_A].records.length, 120000);
});


test('validated states and envelopes are detached copies', () => {
  const source = envelope();
  const valid = validateEnvelope(source, { kind: 'local' });
  valid.state.profiles[PROFILE_A].enabledTypes.value.push('o9');
  valid.state.profiles[PROFILE_A].name.value = 'Changed';
  assert.deepEqual(source.state.profiles[PROFILE_A].enabledTypes.value, ['o5']);
  assert.equal(source.state.profiles[PROFILE_A].name.value, 'Main');
});

test('account scope is rejected until its sync schema is implemented', () => {
  rejects(() => validateEnvelope(envelope(), { kind: 'account', accountKey: 'a'.repeat(64) }), 'unsupported-scope');
});
