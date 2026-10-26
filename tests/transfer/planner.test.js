'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planImport, planExport } = require('../../src/transfer/planner');
const { parseTransfer } = require('../../src/transfer/envelope');
const { mappingPackVersion } = require('../../src/transfer/mapping');
const { makeTransfer } = require('./helpers');
const catalog = { namespace: 'appsample:gim:2', fingerprint: 'synthetic-canonical', markers: ['42', '43', '99', '100'].map((id, x) => ({ id, x, y: 0, category: 'chest', level: null })) };
const record = (id, state = true, map = catalog.namespace) => ({ id, map, state, category: null, level: null, position: null });
const profile = (values = {}) => ({ markers: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }])) });
const metadata = { producer: { name: 'synthetic', version: '1' }, exportedAt: '2000-01-01T00:00:00.000Z', adapterVersion: '1' };
const options = (extra = {}) => ({ provider: 'appsample', map: catalog.namespace, catalog, pack: null, metadata, ...extra });
const incoming = records => makeTransfer({ records });
function reviewed() {
  return { version: 1, provider: 'hoyolab', map: 'synthetic:2', sourceCatalogFingerprint: 'synthetic-source', canonicalCatalogFingerprint: catalog.fingerprint, sourceCoordinateSpace: 'synthetic', sourceMarkers: [{ id: 'a', x: 0, y: 0, category: 'chest', level: null }], categoryPairs: [{ source: 'chest', target: 'chest', permanent: true }], levelPairs: [], pairs: [{ sourceId: 'a', canonicalId: '42' }], spatial: null };
}
const external = records => makeTransfer({ provider: 'hoyolab', map: 'synthetic:2', catalog: { generation: 'synthetic', fingerprint: 'synthetic-source' }, records });

test('merge planning preserves missing/false and counts each normalized record including duplicate metadata', () => {
  const e = incoming([record('42'), record('43'), record('43'), record('100', false), record('unknown')]);
  const validated = parseTransfer(Buffer.from(JSON.stringify(e)));
  const before = profile({ 42: false, 99: true, 100: false });
  const plan = planImport(validated, before, catalog, null);
  assert.deepEqual(plan.foundIds, ['42', '43']);
  assert.deepEqual(plan.counts, { matched: 2, alreadyFound: 0, ambiguous: 0, unsupported: 0, unknown: 1, invalid: 0, ignoredNotFound: 1, duplicates: 1 });
  assert.equal(before.markers['100'].value, false);
  assert.equal(plan.attachment.records.length, 4); assert.deepEqual(plan.attachment.imports, []);
  assert.equal(planImport(validated, profile({ 42: true }), catalog, null).counts.alreadyFound, 1);
});

test('unsupported scopes retain observations without completing a canonical marker', () => {
  const e = makeTransfer({ map: 'another-realm', records: [record('42', true, 'another-realm')] });
  const plan = planImport(e, profile(), catalog, null);
  assert.deepEqual(plan.foundIds, []); assert.equal(plan.attachment.records[0].mapping, null);
});

test('mapped undo suppresses originals while unknown IDs pass back only to their own provider/map', () => {
  const attachment = planImport(incoming([record('42'), record('unknown')]), profile(), catalog, null).attachment;
  const output = planExport(profile({ 42: false, 43: true }), attachment, options()).envelope;
  assert.equal(output.records.some(r => r.id === '42' && r.state), false);
  assert.ok(output.records.some(r => r.id === 'unknown' && r.state));
  assert.ok(output.records.some(r => r.id === '43' && r.state));
  const elsewhere = planExport(profile({ 42: false }), attachment, options({ provider: 'bwiki', map: 'synthetic:2' })).envelope;
  assert.deepEqual(elsewhere.records, []);
});

test('reviewed originals and reverse output deduplicate and stale claims never pass through', () => {
  const pack = reviewed(); const e = external([record('a', true, pack.map), record('unknown', true, pack.map)]);
  const attachment = planImport(e, profile(), catalog, pack).attachment;
  const out = options({ provider: pack.provider, map: pack.map, pack });
  assert.deepEqual(planExport(profile({ 42: true }), attachment, out).envelope.records.map(r => r.id), ['a', 'unknown']);
  const stale = { ...pack, pairs: [] };
  const result = planExport(profile({ 42: true }), attachment, { ...out, pack: stale });
  assert.deepEqual(result.envelope.records.map(r => r.id), ['unknown']);
  assert.ok(result.report.counts.unknown >= 1);
});

test('forged transfer evidence and portable attachment mappings fail closed even when their shape is valid', () => {
  const pack = reviewed(); const r = record('a', true, pack.map);
  r.mappingEvidence = { namespace: catalog.namespace, id: '43', mappingVersion: mappingPackVersion(pack) };
  const plan = planImport(external([r]), profile(), catalog, pack);
  assert.deepEqual(plan.foundIds, []); assert.equal(plan.counts.unsupported, 1);
  assert.deepEqual(planExport(profile(), plan.attachment, options({ provider: pack.provider, map: pack.map, pack })).envelope.records, []);
  const clean = planImport(external([record('unknown', true, pack.map)]), profile(), catalog, pack).attachment;
  clean.records[0].mapping = { canonicalId: '42', confidence: 'reviewed', mappingVersion: mappingPackVersion(pack) };
  assert.deepEqual(planExport(profile({ 42: false }), clean, options({ provider: pack.provider, map: pack.map, pack })).envelope.records, []);
});

test('false observations stay metadata and export contains only current canonical truths as operations', () => {
  const attachment = planImport(incoming([record('42', false), record('opaque', false)]), profile(), catalog, null).attachment;
  const result = planExport(profile({ 42: true, 43: false }), attachment, options());
  assert.equal(result.envelope.records.find(r => r.id === '42').state, true);
  assert.equal(result.envelope.records.find(r => r.id === 'opaque').state, false);
  assert.equal(result.envelope.records.some(r => r.id === '43' && r.state), false);
});

test('export reports opaque retained numerals without inventing canonical source decisions', () => {
  const pack = reviewed();
  const attachment = planImport(external([record('42', true, pack.map), record('opaque', false, pack.map)]), profile(), catalog, pack).attachment;
  const result = planExport(profile(), attachment, options({ provider: pack.provider, map: pack.map, pack }));
  assert.deepEqual(result.report.decisions, []);
  assert.equal(result.report.counts.unknown, 1); assert.equal(result.report.counts.ignoredNotFound, 1);
  assert.deepEqual(result.envelope.records.map(r => r.id), ['42', 'opaque']);
});

test('export reports an imported mapped marker undo as a canonical exclusion', () => {
  const attachment = planImport(incoming([record('42')]), profile(), catalog, null).attachment;
  const result = planExport(profile({ 42: false }), attachment, options());
  assert.equal(result.report.counts.ignoredNotFound, 1);
  assert.equal(result.report.decisions[0].sourceId, '42');
  assert.equal(result.report.decisions[0].reason, 'canonical-not-found');
});

test('ambiguous floors and unsupported categories retain observations with exactly one import outcome each', () => {
  const pack = reviewed(); pack.pairs = [];
  const anchors = [ { sourceId: 'anchor-a', canonicalId: '90', source: [100, 100], target: [100, 100] }, { sourceId: 'anchor-b', canonicalId: '91', source: [200, 100], target: [200, 100] }, { sourceId: 'anchor-c', canonicalId: '92', source: [100, 200], target: [100, 200] } ];
  const heldOut = [{ sourceId: 'check', canonicalId: '93', source: [200, 200], target: [200, 200] }];
  pack.sourceMarkers.push(...[...anchors, ...heldOut].map(p => ({ id: p.sourceId, x: p.source[0], y: p.source[1], category: 'chest', level: null })), { id: 'temporary', x: 50, y: 50, category: 'daily', level: null });
  pack.spatial = { coefficients: [1, 0, 0, 0, 1, 0], radius: 3, minMargin: 1, maxResidual: 0.01, anchors, heldOut };
  const c = { ...catalog, markers: [...catalog.markers, ...[...anchors, ...heldOut].map(p => ({ id: p.canonicalId, x: p.target[0], y: p.target[1], category: 'chest', level: null }))] };
  const plan = planImport(external([record('a', true, pack.map), record('temporary', true, pack.map)]), profile(), c, pack);
  assert.equal(plan.counts.ambiguous, 1); assert.equal(plan.counts.unsupported, 1);
  assert.deepEqual(plan.foundIds, []); assert.equal(plan.attachment.records.length, 2);
  assert.ok(plan.attachment.records.every(row => row.mapping === null));
});

test('exact namespace export deduplicates identity even when a bundled identity pack is supplied', () => {
  const pack = reviewed(); pack.provider = 'appsample'; pack.map = catalog.namespace;
  pack.sourceMarkers = [{ ...catalog.markers[0] }]; pack.pairs = [{ sourceId: '42', canonicalId: '42' }];
  const result = planExport(profile({ 42: true }), undefined, options({ pack }));
  assert.deepEqual(result.envelope.records.map(r => r.id), ['42']);
});

test('export declares current authority or a single retained catalog, and never guesses between source generations', () => {
  const externalOptions = options({ provider: 'hoyolab', map: 'synthetic:2' });
  const a = external([record('opaque-a', true, externalOptions.map)]);
  const first = planImport(a, profile(), catalog, null).attachment;
  assert.deepEqual(planExport(profile(), first, externalOptions).envelope.catalog, a.catalog);
  const b = external([record('opaque-b', true, externalOptions.map)]); b.catalog = { generation: 'another-source-generation', fingerprint: 'another-fingerprint' };
  const second = planImport(b, profile(), catalog, null).attachment;
  const combined = { version: 1, imports: [], records: [...first.records, ...second.records] };
  const result = planExport(profile({ 42: true }), combined, externalOptions);
  assert.deepEqual(result.envelope.catalog, { generation: 'unverified', fingerprint: 'unverified' });
  assert.deepEqual(result.envelope.records.map(r => r.id), ['opaque-a', 'opaque-b']);
  assert.deepEqual(planExport(profile({ 42: true }), undefined, externalOptions).envelope.catalog, { generation: 'unverified', fingerprint: 'unverified' });
  const pack = reviewed();
  assert.deepEqual(planExport(profile({ 42: true }), undefined, { ...externalOptions, pack }).envelope.catalog, { generation: 'reviewed-mapping', fingerprint: pack.sourceCatalogFingerprint });
  assert.deepEqual(planExport(profile(), undefined, options()).envelope.catalog, { generation: catalog.namespace, fingerprint: catalog.fingerprint });
});
