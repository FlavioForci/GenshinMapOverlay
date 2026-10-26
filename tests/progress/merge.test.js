'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeStates, nextClock, foundIds } = require('../../src/progress/merge');
const { ProgressError } = require('../../src/progress/schema');
const { ACTOR_A, ACTOR_B, PROFILE_A, PROFILE_B, makeState } = require('./helpers');

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return value;
}

test('merge is commutative associative and idempotent', () => {
  const a = makeState({ found: { 42: true }, clock: 7 });
  const b = makeState({ actor: ACTOR_B, found: { 42: false, 43: true }, clock: 8 });
  const c = makeState({ actor: '00000000-0000-4000-8000-000000000003', found: { 44: true }, clock: 9 });
  assert.deepEqual(mergeStates(a, b), mergeStates(b, a));
  assert.deepEqual(mergeStates(mergeStates(a, b), c), mergeStates(a, mergeStates(b, c)));
  assert.deepEqual(mergeStates(a, a), a);
});

test('explicit undo survives older progress', () => {
  const foundAt7 = makeState({ found: { 42: true }, clock: 7 });
  const undoAt8 = makeState({ found: { 42: false }, clock: 8 });
  const merged = mergeStates(foundAt7, undoAt8);
  assert.deepEqual(foundIds(merged.profiles[PROFILE_A]), []);
  assert.equal(merged.profiles[PROFILE_A].markers['42'].value, false);
});

test('equal clocks use fixed ASCII actor order for every register', () => {
  const a = makeState({ actor: ACTOR_A, found: { 42: true }, name: 'A', enabledTypes: ['o10'] });
  const b = makeState({ actor: ACTOR_B, found: { 42: false }, name: 'B', region: 'Unknown', enabledTypes: ['o999999'], hideFound: true });
  assert.deepEqual(mergeStates(a, b), b);
  assert.deepEqual(mergeStates(b, a), b);
});

test('independent markers profiles and unknown keys survive immutable merge', () => {
  const a = freeze(makeState({ found: { 42: true, 900000001: true }, enabledTypes: ['o999999'] }));
  const b = makeState({ actor: ACTOR_B, clock: 2, found: { 43: true }, enabledTypes: ['o999999'] });
  b.profiles[PROFILE_B] = makeState({ profileId: PROFILE_B, found: { 5: true } }).profiles[PROFILE_B];
  freeze(b);
  const merged = mergeStates(a, b);
  assert.deepEqual(foundIds(merged.profiles[PROFILE_A]), [42, 43, 900000001]);
  assert.deepEqual(foundIds(merged.profiles[PROFILE_B]), [5]);
  merged.profiles[PROFILE_A].markers['42'].value = false;
  merged.profiles[PROFILE_A].enabledTypes.value.push('o9');
  merged.profiles[PROFILE_B].name.value = 'Changed';
  assert.equal(a.profiles[PROFILE_A].markers['42'].value, true);
  assert.deepEqual(b.profiles[PROFILE_A].enabledTypes.value, ['o999999']);
  assert.equal(b.profiles[PROFILE_B].name.value, 'Main');
});

test('contradictory equal-clock equal-actor registers are corruption', () => {
  for (const change of [p => { p.name.value = 'Different'; }, p => { p.region.value = 'Other'; }, p => { p.enabledTypes.value = ['o10']; }, p => { p.hideFound.value = true; }, p => { p.markers['42'].value = false; }]) {
    const a = makeState({ found: { 42: true } }); const b = structuredClone(a); change(b.profiles[PROFILE_A]);
    assert.throws(() => mergeStates(a, b), error => error instanceof ProgressError && error.code === 'register-conflict');
    assert.throws(() => mergeStates(b, a), error => error instanceof ProgressError && error.code === 'register-conflict');
  }
});

test('next clock includes every metadata marker and independent profile clock', () => {
  for (const field of ['name', 'region', 'enabledTypes', 'hideFound']) {
    const state = makeState(); state.profiles[PROFILE_A][field].clock = 50;
    assert.equal(nextClock(3, state), 51);
  }
  const state = makeState({ found: { 42: true }, clock: 7 });
  state.profiles[PROFILE_B] = makeState({ profileId: PROFILE_B, clock: 70 }).profiles[PROFILE_B];
  assert.equal(nextClock(3, state), 71);
  assert.equal(nextClock(100, state), 101);
  assert.equal(nextClock(0, { namespace: 'appsample:gim:2', profiles: {} }), 1);
});

test('clock overflow and unsafe input reject rather than wrap', () => {
  for (const clock of [-1, 0.1, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => nextClock(clock, makeState()), ProgressError);
  assert.throws(() => nextClock(Number.MAX_SAFE_INTEGER, makeState()), error => error.code === 'clock-exhausted');
  assert.throws(() => nextClock(0, makeState({ clock: Number.MAX_SAFE_INTEGER })), error => error.code === 'clock-exhausted');
});

test('found IDs are numerically sorted and omit explicit false registers', () => {
  assert.deepEqual(foundIds(makeState({ found: { 100: true, 2: true, 10: false } }).profiles[PROFILE_A]), [2, 100]);
});


test('metadata registers merge independently from marker registers', () => {
  const a = makeState({ clock: 3, name: 'Preferred name', found: { 42: true } });
  const b = makeState({ actor: ACTOR_B, clock: 2, region: 'Preferred region', enabledTypes: ['o999999'], hideFound: true, found: { 42: false } });
  b.profiles[PROFILE_A].region.clock = 4;
  b.profiles[PROFILE_A].hideFound.clock = 5;
  b.profiles[PROFILE_A].markers['42'].clock = 6;
  const merged = mergeStates(a, b).profiles[PROFILE_A];
  assert.equal(merged.name.value, 'Preferred name');
  assert.equal(merged.region.value, 'Preferred region');
  assert.deepEqual(merged.enabledTypes.value, ['o5']);
  assert.equal(merged.hideFound.value, true);
  assert.deepEqual(foundIds(merged), []);
});

test('a merge union must still satisfy the profile count bound', () => {
  const a = { namespace: 'appsample:gim:2', profiles: {} };
  const b = { namespace: 'appsample:gim:2', profiles: {} };
  for (let i = 0; i < 101; i++) {
    const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    Object.assign((i < 50 ? a : b).profiles, makeState({ profileId: id }).profiles);
  }
  assert.throws(() => mergeStates(a, b), error => error instanceof ProgressError && error.code === 'limit-exceeded');
});

test('merged serialization is deterministic for marker IDs outside array-index order', () => {
  const a = makeState({ found: { 9000000002: true } });
  const b = makeState({ actor: ACTOR_B, found: { 9000000001: false } });
  assert.equal(JSON.stringify(mergeStates(a, b)), JSON.stringify(mergeStates(b, a)));
});
