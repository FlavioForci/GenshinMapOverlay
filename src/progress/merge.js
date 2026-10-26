'use strict';

const { ProgressError, validateState } = require('./schema');

const FIELDS = ['name', 'region', 'enabledTypes', 'hideFound'];

function sameValue(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((value, i) => value === b[i])
    : a === b;
}
function winner(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.clock !== b.clock) return a.clock > b.clock ? a : b;
  // Relational string comparison uses fixed UTF-16/ASCII order for UUID actors.
  if (a.actor !== b.actor) return a.actor > b.actor ? a : b;
  if (!sameValue(a.value, b.value)) throw new ProgressError('register-conflict');
  return a;
}

/** Merge independently versioned fields without mutating or aliasing either input. @returns {import('./schema').ProgressState} */
function mergeStates(a, b) {
  const left = validateState(a);
  const right = validateState(b);
  const profiles = {};
  for (const id of [...new Set([...Object.keys(left.profiles), ...Object.keys(right.profiles)])].sort()) {
    const first = left.profiles[id];
    const second = right.profiles[id];
    if (!first || !second) {
      profiles[id] = first || second;
      continue;
    }
    const profile = {};
    for (const field of FIELDS) profile[field] = winner(first[field], second[field]);
    profile.markers = {};
    for (const markerId of [...new Set([...Object.keys(first.markers), ...Object.keys(second.markers)])].sort((a, b) => Number(a) - Number(b))) {
      profile.markers[markerId] = winner(first.markers[markerId], second.markers[markerId]);
    }
    profiles[id] = profile;
  }
  // The union may exceed aggregate limits even when each input fits.
  return validateState({ namespace: left.namespace, profiles });
}

/** Advance beyond the saved clock and every metadata/marker register. */
function nextClock(clock, state) {
  if (!Number.isSafeInteger(clock) || clock < 0) throw new ProgressError('invalid-clock');
  const valid = validateState(state);
  let maximum = clock;
  for (const profile of Object.values(valid.profiles)) {
    for (const field of FIELDS) maximum = Math.max(maximum, profile[field].clock);
    for (const marker of Object.values(profile.markers)) maximum = Math.max(maximum, marker.clock);
  }
  if (maximum === Number.MAX_SAFE_INTEGER) throw new ProgressError('clock-exhausted');
  return maximum + 1;
}

/** Effective found identities, excluding durable explicit undo registers. @param {import('./schema').Profile} profile @returns {number[]} */
function foundIds(profile) {
  return Object.entries(profile.markers).filter(([, register]) => register.value === true).map(([id]) => Number(id)).sort((a, b) => a - b);
}

module.exports = { mergeStates, nextClock, foundIds };
