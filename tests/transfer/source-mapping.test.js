'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { matchRecords } = require('../../src/transfer/mapping');
const { makeTransfer } = require('./helpers');
const target = { id: '42', category: 'o5', level: null, x: 100, y: 200 };
const catalog = { namespace: 'appsample:gim:2', fingerprint: 'b'.repeat(64), markers: [target] };
const pack = { version: 1, provider: 'hoyolab', map: 'hoyolab:ys_obc:2', recordScoped: true,
  sourceCatalogFingerprint: 'a'.repeat(64), canonicalCatalogFingerprint: 'c'.repeat(64), sourceCoordinateSpace: 'hoyolab:x_pos-y_pos',
  sourceMarkers: [{ id: '7', category: '5', level: null, x: 10, y: 20 }], categoryPairs: [{ source: '5', target: 'o5', permanent: true }],
  levelPairs: [], pairs: [{ sourceId: '7', canonicalId: '42' }], spatial: null };
const source = { id: '7', map: pack.map, category: '5', level: null, state: true, position: { x: 10, y: 20, space: pack.sourceCoordinateSpace } };
test('reviewed source pairs survive unrelated catalog additions but require every imported source row to match trusted metadata', () => {
  const { rebaseMapping } = require('../../src/transfer/source-mapping');
  const rebased = rebaseMapping(pack, [target], catalog);
  const file = makeTransfer({ provider: 'hoyolab', map: pack.map, catalog: { generation: 'new-public-data', fingerprint: 'd'.repeat(64) }, records: [source] });
  assert.equal(matchRecords(file, catalog, rebased)[0].canonicalId, '42');
  for (const change of [{ category: null }, { category: '6' }, { position: null }, { position: { ...source.position, x: 11 } }]) {
    assert.notEqual(matchRecords({ ...file, records: [{ ...source, ...change }] }, catalog, rebased)[0].status, 'matched');
  }
});
test('reviewed source pairs stop applying after their canonical target changes or disappears', () => {
  const { rebaseMapping } = require('../../src/transfer/source-mapping');
  for (const markers of [[], [{ ...target, category: 'o6' }], [{ ...target, x: 101 }]]) {
    assert.equal(rebaseMapping(pack, [target], { ...catalog, markers }), null);
  }
  assert.equal(rebaseMapping(pack, [], catalog), null);
});

test('row-scoped packs bind per-record coordinate spaces and cannot enable a spatial model', () => {
  const { rebaseMapping } = require('../../src/transfer/source-mapping');
  const { validateMappingPack } = require('../../src/transfer/mapping');
  const mixed = { ...pack, sourceCoordinateSpace: 'per-record', sourceMarkers: [{ ...pack.sourceMarkers[0], space: 'legacy-space' }] };
  const rebased = rebaseMapping(mixed, [target], catalog);
  const file = makeTransfer({ provider: pack.provider, map: pack.map, records: [{ ...source, position: { ...source.position, space: 'legacy-space' } }] });
  assert.equal(matchRecords(file, catalog, rebased)[0].canonicalId, '42');
  file.records[0].position.space = 'per-record';
  assert.notEqual(matchRecords(file, catalog, rebased)[0].status, 'matched');
  for (const patch of [{ recordScoped: false }, { spatial: {} }, { pairs: [] }, { sourceMarkers: [] }]) assert.throws(() => validateMappingPack({ ...pack, ...patch }));
});

test('source mappings cannot treat missing floor metadata as a match for a reviewed known floor', () => {
  const { rebaseMapping } = require('../../src/transfer/source-mapping');
  const withFloor = { ...pack, sourceMarkers: [{ ...pack.sourceMarkers[0], level: 'verified-floor' }] };
  const rebased = rebaseMapping(withFloor, [target], catalog);
  const file = makeTransfer({ provider: pack.provider, map: pack.map, records: [source] });
  assert.notEqual(matchRecords(file, catalog, rebased)[0].status, 'matched');
});

test('unrelated catalog updates preserve imported pair provenance and re-export authorization', () => {
  const { rebaseMapping } = require('../../src/transfer/source-mapping');
  const { planImport, planExport } = require('../../src/transfer/planner');
  const file = makeTransfer({ provider: pack.provider, map: pack.map, records: [source] });
  const rebased = rebaseMapping(pack, [target], catalog);
  const imported = planImport(file, { markers: {} }, catalog, rebased);
  const changed = { ...catalog, fingerprint: 'e'.repeat(64), markers: [...catalog.markers, { ...target, id: '999', x: 999 }] };
  const current = rebaseMapping(pack, [target], changed);
  assert.equal(matchRecords(file, changed, current)[0].mappingVersion, imported.decisions[0].mappingVersion);
  const result = planExport({ markers: { 42: { value: true } } }, imported.attachment, { provider: pack.provider, map: pack.map, catalog: changed, pack: current,
    metadata: { producer: file.producer, adapterVersion: file.adapterVersion, exportedAt: file.exportedAt } });
  assert.equal(result.envelope.records.length, 1); assert.equal(result.envelope.records[0].id, source.id);
  assert.equal(result.report.counts.unsupported, 0);
});
