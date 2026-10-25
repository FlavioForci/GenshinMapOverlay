'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalCatalog } = require('../../src/transfer/catalog');
function data(reverse = false) {
  return { types: [{ key: 'o17', name: 'Localized chest' }, { key: 'o18', name: 'Seelie' }], markers: { count: 2, id: reverse ? [8, 42] : [42, 8], type: reverse ? [1, 0] : [0, 1], level: [4, 6], x: reverse ? [20, 10] : [10, 20], y: reverse ? [40, 30] : [30, 40] } };
}
test('catalog identity uses stable category keys and ignores ordering, names and unverified raw levels', () => {
  const a = canonicalCatalog(data()); const reordered = data(true);
  reordered.types = [{ key: 'o18', name: 'translated' }, { key: 'o17', name: 'other' }]; reordered.markers.type = [0, 1];
  assert.equal(a.namespace, 'appsample:gim:2');
  assert.equal(a.fingerprint, canonicalCatalog(reordered).fingerprint);
  assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(a.markers, [{ id: '42', category: 'o17', level: null, x: 10, y: 30 }, { id: '8', category: 'o18', level: null, x: 20, y: 40 }]);
  const changed = data(); changed.markers.x[0]++;
  assert.notEqual(a.fingerprint, canonicalCatalog(changed).fingerprint);
  changed.markers.x[0]--; changed.types[0].key = 'o99';
  assert.notEqual(a.fingerprint, canonicalCatalog(changed).fingerprint);
});
test('catalog rejects duplicate IDs, missing types, non-finite points and truncated columns', () => {
  for (const change of [d => d.markers.id[1] = 42, d => d.markers.type[0] = 9, d => d.markers.x[0] = NaN, d => d.markers.y.pop(), d => d.markers.id[0] = -1]) {
    const d = data(); change(d); assert.throws(() => canonicalCatalog(d));
  }
});
test('decoded canonical IDs must be positive safe integers before catalog construction', () => {
  for (const id of [0, -0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
    const d = data(); d.markers.id[0] = id;
    assert.throws(() => canonicalCatalog(d), `invalid canonical numeric ID: ${id}`);
  }
  const d = data(); d.markers.id[0] = Number.MAX_SAFE_INTEGER;
  assert.equal(canonicalCatalog(d).markers.some(p => p.id === '9007199254740991'), true);
});
