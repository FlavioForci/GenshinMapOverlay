'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRecords, reverseIds, validateMappingPack, mappingPackVersion } = require('../../src/transfer/mapping');
const { createSpatialIndex, fitAffine } = require('../../src/transfer/spatial-index');
const { makeTransfer } = require('./helpers');
const point = (id, x, y = 0, category = 'chest', level = 'surface') => ({ id, category, level, x, y });
const catalog = (markers = [point('42', 0), point('43', 20)]) => ({ namespace: 'appsample:gim:2', fingerprint: 'c'.repeat(64), markers });
function pack(markers = [point('a', 0), point('b', 20)]) {
  return { version: 1, provider: 'hoyolab', map: 'hoyolab:2', sourceCatalogFingerprint: 's'.repeat(64), canonicalCatalogFingerprint: 'c'.repeat(64), sourceCoordinateSpace: 'synthetic-pixels', sourceMarkers: markers, categoryPairs: [{ source: 'chest', target: 'chest', permanent: true }], levelPairs: [{ source: 'surface', target: 'surface' }], pairs: [], spatial: null };
}
function envelope(ids = ['a'], overrides = {}) {
  return makeTransfer({ provider: 'hoyolab', map: 'hoyolab:2', catalog: { generation: 'synthetic', fingerprint: 's'.repeat(64) }, records: ids.map(id => ({ id, map: 'hoyolab:2', category: 'chest', level: 'surface', state: true, position: null })), ...overrides });
}
const run = (p = pack(), c = catalog(), e = envelope()) => matchRecords(e, c, p);
function spatial(p = pack()) {
  const anchors = [ { source: [100, 100], target: [100, 100], sourceId: 'anchor-a', canonicalId: '90' }, { source: [200, 100], target: [200, 100], sourceId: 'anchor-b', canonicalId: '91' }, { source: [100, 200], target: [100, 200], sourceId: 'anchor-c', canonicalId: '92' } ];
  p.sourceMarkers.push(...anchors.map(a => point(a.sourceId, ...a.source)), point('check', 200, 200));
  p.spatial = { coefficients: [1, 0, 0, 0, 1, 0], radius: 3, minMargin: 1, maxResidual: 0.01, anchors, heldOut: [{ source: [200, 200], target: [200, 200], sourceId: 'check', canonicalId: '93' }] };
  return p;
}
function spatialCatalog(markers) { return catalog([...markers, point('90', 100, 100), point('91', 200, 100), point('92', 100, 200), point('93', 200, 200)]); }

test('provider numerals and file-supplied evidence cannot authorize cross-provider identity', () => {
  const e = envelope(['42']); e.records[0].mappingEvidence = { namespace: 'appsample:gim:2', id: '42', mappingVersion: '1' };
  assert.equal(run(null, catalog(), e)[0].status, 'unknown');
  const app = makeTransfer({ records: [{ ...e.records[0], map: 'appsample:gim:2', category: null, level: 'unverified-4' }] });
  assert.equal(matchRecords(app, catalog([point('42', 0, 0, 'chest', null)]), null)[0].canonicalId, '42');
  app.map = app.records[0].map = 'appsample:gim:7';
  assert.equal(matchRecords(app, catalog(), null)[0].status, 'unknown');
});
test('AppSample identity rejects actual known category/floor contradictions and retains unknown IDs', () => {
  for (const [id, categoryValue, floor, want] of [['42', 'puzzle', 'surface', 'unsupported'], ['42', 'chest', 'cave', 'unsupported'], ['999', 'chest', 'surface', 'unknown']]) {
    const e = makeTransfer({ records: [{ id, map: 'appsample:gim:2', category: categoryValue, level: floor, state: true, position: null }] });
    assert.equal(matchRecords(e, catalog(), null)[0].status, want);
  }
});
test('reviewed pairs round-trip exactly, ignore source order and precede nearby spatial pins', () => {
  const p = spatial(); p.pairs = [{ sourceId: 'a', canonicalId: '43' }, { sourceId: 'b', canonicalId: '42' }];
  const c = spatialCatalog([point('42', 0), point('43', 20)]);
  const matched = run(p, c, envelope(['b', 'a']));
  assert.deepEqual(matched.map(d => [d.canonicalId, d.confidence]), [['42', 'reviewed'], ['43', 'reviewed']]);
  assert.deepEqual(reverseIds(matched.map(d => d.canonicalId), c, p), { ids: ['a', 'b'], excluded: [] });
  assert.deepEqual(reverseIds(['42', '999', '42'], c, p), { ids: ['b'], excluded: ['999'] });
});
test('wrong provider/map/catalog and absent source IDs remain unknown', () => {
  const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }];
  for (const alter of [e => e.provider = 'mapgenie', e => e.map = e.records[0].map = 'hoyolab:7', e => e.catalog.fingerprint = 'stale', e => e.records[0].id = 'absent']) {
    const e = envelope(); alter(e); assert.equal(run(p, catalog(), e)[0].status, 'unknown');
  }
  const c = catalog(); c.fingerprint = 'stale'; assert.equal(run(p, c)[0].status, 'unknown');
});
test('unreviewed categories, puzzle semantics and respawning categories cannot map', () => {
  for (const modify of [p => p.categoryPairs = [], p => p.categoryPairs[0].permanent = false, p => p.categoryPairs[0].target = 'puzzle']) {
    const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }]; modify(p);
    assert.equal(run(p)[0].status, 'unsupported');
  }
});
test('record contradictions and false observations cannot claim a completion', () => {
  const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }];
  for (const modify of [r => r.category = 'puzzle', r => r.level = 'cave', r => r.state = false, r => r.position = { x: 999, y: 0, space: 'synthetic-pixels' }]) {
    const e = envelope(); modify(e.records[0]); assert.notEqual(run(p, catalog(), e)[0].status, 'matched');
  }
});
test('spatial matching and reverse use reciprocal unique neighbors from full catalogs', () => {
  const p = spatial(); const c = spatialCatalog([point('42', 0.2), point('43', 20.2)]);
  assert.equal(run(p, c)[0].confidence, 'spatial');
  assert.deepEqual(reverseIds(['42', '43'], c, p), { ids: ['a', 'b'], excluded: [] });
  p.sourceMarkers.push(point('unimported', 0.1));
  assert.notEqual(run(p, c)[0].status, 'matched');
  assert.deepEqual(reverseIds(['42'], c, p), { ids: [], excluded: ['42'] });
});
test('equal distances, insufficient margins, duplicate pins and destination collisions are ambiguous', () => {
  for (const points of [[point('42', -1), point('43', 1)], [point('42', 0.1), point('43', 0.9)], [point('42', 0), point('43', 0)]]) {
    assert.equal(run(spatial(), spatialCatalog(points))[0].status, 'ambiguous');
  }
  const p = spatial(pack([point('a', 0), point('b', 0)]));
  assert.equal(run(p, spatialCatalog([point('42', 0)]), envelope(['a', 'b'])).every(d => d.status !== 'matched'), true);
});
test('unknown source or destination floors never assume surface and stacked floors remain ambiguous', () => {
  for (const floor of [null, '0', 'cave']) {
    const p = spatial(pack([point('a', 0, 0, 'chest', floor)]));
    assert.notEqual(run(p, spatialCatalog([point('42', 0)]), envelope(['a'], { records: [{ id: 'a', map: 'hoyolab:2', category: 'chest', level: floor, state: true, position: null }] }))[0].status, 'matched');
  }
  assert.equal(run(spatial(), spatialCatalog([point('42', 0, 0, 'chest', null), point('43', 0, 0, 'chest', 'cave')]))[0].status, 'ambiguous');
});
test('known level translations separate stacked markers', () => {
  const p = spatial(); p.sourceMarkers[0].level = 'above'; p.levelPairs.push({ source: 'above', target: 'surface' });
  const e = envelope(); e.records[0].level = 'above';
  assert.equal(run(p, spatialCatalog([point('42', 0), point('43', 0, 0, 'chest', 'cave')]), e)[0].canonicalId, '42');
});
test('stale transforms, held-out residual failures and mismatched anchor catalogs disable spatial matching', () => {
  for (const modify of [p => p.spatial.coefficients[2] = 5, p => p.spatial.heldOut[0].target[0] += 1, p => p.spatial.anchors[0].source[0] += 1]) {
    const p = spatial(); modify(p); assert.notEqual(run(p, spatialCatalog([point('42', 0)]))[0].status, 'matched');
  }
});
test('pack validator rejects corrupt, one-to-many, unsafe, unbounded and singular calibration data', () => {
  for (const modify of [p => p.version = 2, p => p.extra = true, p => p.sourceMarkers.push(point('a', 1)), p => p.pairs = [{ sourceId: 'a', canonicalId: '42' }, { sourceId: 'b', canonicalId: '42' }], p => p.pairs = [{ sourceId: 'absent', canonicalId: '42' }], p => p.sourceMarkers[0].x = Infinity, p => p.spatial.radius = -1, p => p.spatial.anchors[2].source = [300, 100], p => p.spatial.heldOut[0].sourceId = 'anchor-a', p => p.sourceCoordinateSpace = 'x'.repeat(129)]) {
    const p = spatial(); modify(p); assert.throws(() => validateMappingPack(p));
  }
  const p = spatial(); const copy = validateMappingPack(p); p.sourceMarkers[0].x = 9; assert.equal(copy.sourceMarkers[0].x, 0);
});
test('affine fit recovers independently specified scale, rotation, shear and translation', () => {
  const anchors = [{ source: [0, 0], target: [7, -4] }, { source: [4, 0], target: [15, -6] }, { source: [0, 4], target: [11, 8] }, { source: [4, 4], target: [19, 6] }];
  const coefficients = fitAffine(anchors);
  for (const [i, wanted] of [2, 1, 7, -0.5, 3, -4].entries()) assert.ok(Math.abs(coefficients[i] - wanted) < 1e-10);
  const [a, b, c, d, e, f] = coefficients;
  assert.ok(Math.abs(a * 3 + b * -2 + c - 11) < 1e-10);
  assert.ok(Math.abs(d * 3 + e * -2 + f - -11.5) < 1e-10);
  assert.throws(() => fitAffine([{ source: [0, 0], target: [1, 1] }, { source: [1, 1], target: [2, 2] }, { source: [2, 2], target: [3, 3] }]));
});
test('uniform grid returns exact radius results across negative/cell boundaries and large queries', () => {
  const points = [point('a', -1, -1), point('b', 0, 0), point('c', 3, 4), point('d', 10, 10)];
  const index = createSpatialIndex(points, 2);
  assert.deepEqual(index.query(0, 0, 5).map(p => p.id).sort(), ['a', 'b', 'c']);
  assert.equal(index.query(0, 0, 1e12).length, 4);
  assert.deepEqual(index.query(-1, -1, 0).map(p => p.id), ['a']);
  assert.throws(() => createSpatialIndex(points, 0)); assert.throws(() => index.query(NaN, 0, 1));
});
test('unimported source with unknown floor blocks nearby spatial claims and reverse export', () => {
  const p = spatial(); p.sourceMarkers.push(point('unknown-floor', 0, 0, 'chest', null));
  const c = spatialCatalog([point('42', 0)]);
  assert.equal(run(p, c)[0].status, 'ambiguous');
  assert.deepEqual(reverseIds(['42'], c, p), { ids: [], excluded: ['42'] });
});
test('unimported source whose floor has no reviewed translation blocks nearby spatial claims', () => {
  const p = spatial(); p.sourceMarkers.push(point('untranslated-floor', 0, 0, 'chest', '0'));
  assert.equal(run(p, spatialCatalog([point('42', 0)]))[0].status, 'ambiguous');
});
test('reviewed pairs remain usable when the independently checked spatial model fails', () => {
  const p = spatial(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }]; p.spatial.coefficients[2] = 9;
  assert.equal(run(p, spatialCatalog([point('42', 0)]))[0].confidence, 'reviewed');
});
test('spatial matching applies a nontrivial independently labeled affine model in both directions', () => {
  const p = pack([point('a', 3, -2)]);
  p.sourceMarkers.push(point('anchor-a', 0, 0), point('anchor-b', 4, 0), point('anchor-c', 0, 4), point('check', 4, 4));
  p.spatial = { coefficients: [2, 1, 7, -0.5, 3, -4], radius: 0.5, minMargin: 0.1, maxResidual: 0.001, anchors: [
    { source: [0, 0], target: [7, -4], sourceId: 'anchor-a', canonicalId: '90' },
    { source: [4, 0], target: [15, -6], sourceId: 'anchor-b', canonicalId: '91' },
    { source: [0, 4], target: [11, 8], sourceId: 'anchor-c', canonicalId: '92' },
  ], heldOut: [{ source: [4, 4], target: [19, 6], sourceId: 'check', canonicalId: '93' }] };
  const c = catalog([point('42', 11, -11.5), point('90', 7, -4), point('91', 15, -6), point('92', 11, 8), point('93', 19, 6)]);
  assert.equal(run(p, c)[0].canonicalId, '42');
  assert.deepEqual(reverseIds(['42'], c, p), { ids: ['a'], excluded: [] });
});
test('grid queries stay finite even when tiny cells overflow cell coordinates', () => {
  const index = createSpatialIndex([point('edge', 1, 1), point('origin', 0, 0)], Number.MIN_VALUE);
  assert.deepEqual(index.query(1, 1, 0).map(p => p.id), ['edge']);
  assert.equal(index.query(0, 0, 1e12).length, 2);
});
test('nearest-neighbor margin includes candidates just outside the match radius', () => {
  const p = spatial();
  assert.equal(run(p, spatialCatalog([point('42', 2.9), point('43', 3.1)]))[0].status, 'ambiguous');
});
test('explicit reviewed destinations are reserved against unimported and imported spatial contenders', () => {
  const p = spatial(); p.pairs = [{ sourceId: 'b', canonicalId: '42' }];
  const c = spatialCatalog([point('42', 0)]);
  assert.equal(run(p, c)[0].status, 'ambiguous');
  assert.deepEqual(reverseIds(['42'], c, p), { ids: ['b'], excluded: [] });
});
test('mapping provenance changes with reviewed semantics and remains stable under catalog/pair ordering', () => {
  const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }, { sourceId: 'b', canonicalId: '43' }];
  const first = run(p)[0].mappingVersion;
  p.sourceMarkers.reverse(); p.pairs.reverse();
  assert.equal(run(p)[0].mappingVersion, first);
  p.pairs = [{ sourceId: 'a', canonicalId: '43' }, { sourceId: 'b', canonicalId: '42' }];
  assert.notEqual(run(p)[0].mappingVersion, first);
});
test('spatial matches are invariant to source/catalog and imported-record ordering', () => {
  const p = spatial(); const c = spatialCatalog([point('42', 0.2), point('43', 20.2)]);
  const a = run(p, c, envelope(['a', 'b']));
  p.sourceMarkers.reverse(); c.markers.reverse();
  const b = run(p, c, envelope(['b', 'a'])).reverse();
  assert.deepEqual(a, b);
});
test('pack validation never evaluates own accessors or accepts non-bijective category semantics', () => {
  const p = pack(); let read = false;
  Object.defineProperty(p, 'sourceMarkers', { enumerable: true, get() { read = true; return []; } });
  assert.throws(() => validateMappingPack(p)); assert.equal(read, false);
  const duplicate = pack(); duplicate.categoryPairs.push({ source: 'puzzle', target: 'chest', permanent: true });
  assert.throws(() => validateMappingPack(duplicate));
});
test('affine least-squares uses all anchors and tolerates large source origins', () => {
  const c = fitAffine([
    { source: [1e9, -1e9], target: [7, -4] },
    { source: [1e9 + 4, -1e9], target: [15, -6] },
    { source: [1e9, -1e9 + 4], target: [11, 8] },
    { source: [1e9 + 4, -1e9 + 4], target: [19, 6] },
    { source: [1e9 + 2, -1e9 + 2], target: [13, 1] },
  ]);
  assert.ok(Math.abs(c[0] * (1e9 + 3) + c[1] * (-1e9 - 2) + c[2] - 11) < 1e-5);
  assert.ok(Math.abs(c[3] * (1e9 + 3) + c[4] * (-1e9 - 2) + c[5] + 11.5) < 1e-5);
});

test('public mapping revision helper validates input and identifies current reviewed semantic content', () => {
  const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: '42' }];
  const revision = mappingPackVersion(p);
  assert.match(revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(run(p)[0].mappingVersion, revision);
  p.pairs[0].canonicalId = '43';
  assert.notEqual(mappingPackVersion(p), revision);
  p.version = 2; assert.throws(() => mappingPackVersion(p));
});
test('exact AppSample manual found flags retain identity without inferred resource permanence', () => {
  const c = catalog([point('42', 0, 0, 'synthetic-resource', null)]);
  const e = makeTransfer({ records: [{ id: '42', map: 'appsample:gim:2', category: 'synthetic-resource', level: null, state: true, position: null }] });
  assert.equal(matchRecords(e, c, null)[0].confidence, 'exact');
  const p = pack(); p.categoryPairs = [{ source: 'chest', target: 'synthetic-resource', permanent: false }];
  p.pairs = [{ sourceId: 'a', canonicalId: '42' }];
  assert.equal(run(p, c)[0].status, 'unsupported');
});
for (const id of ['0', '01', 'source-pin', '9007199254740992', '-1', '1.5', '1e3', '+1']) {
  test(`canonical catalog ID ${JSON.stringify(id)} cannot authorize exact, reviewed or reverse matches`, () => {
    const c = catalog([point(id, 0)]);
    const e = makeTransfer({ records: [{ id, map: 'appsample:gim:2', category: 'chest', level: 'surface', state: true, position: null }] });
    assert.throws(() => matchRecords(e, c, null));
    const p = pack(); p.pairs = [{ sourceId: 'a', canonicalId: id }];
    assert.throws(() => run(p, c));
    assert.throws(() => reverseIds([id], c, p));
  });
}
test('opaque external source ID zero round-trips to a valid positive safe canonical ID', () => {
  const p = pack([point('0', 0)]); p.pairs = [{ sourceId: '0', canonicalId: '9007199254740991' }];
  const c = catalog([point('9007199254740991', 0)]);
  assert.equal(run(p, c, envelope(['0']))[0].canonicalId, '9007199254740991');
  assert.deepEqual(reverseIds(['9007199254740991'], c, p), { ids: ['0'], excluded: [] });
});
