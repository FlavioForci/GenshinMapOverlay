'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogReport } = require('../../tools/transfer/catalog-report');
const { parseTransfer, serializeTransfer } = require('../../src/transfer/envelope');
const make = (id, category = '5') => ({ id, map: 'hoyolab:ys_obc:2', category, level: null, state: true, position: { x: Number(id), y: 3, space: 'hoyolab:x_pos-y_pos' } });

test('source envelope preserves explicit found IDs, retains known-map unknowns, and hashes catalog metadata consistently', async () => {
  const { buildSourceTransfer } = require('../../src/transfer/browser/source');
  const catalog = [make('42'), make('43')];
  const result = await buildSourceTransfer({ provider: 'hoyolab', map: 'hoyolab:ys_obc:2', generation: 'test-generation', catalog, foundIds: ['43', '43', '99'] });
  const file = parseTransfer(serializeTransfer(result.envelope));
  assert.deepEqual(file.records.map(r => [r.id, r.category, r.state]), [['43', '5', true], ['99', null, true]]);
  assert.equal(file.records[1].position, null); assert.equal(file.coverage.complete, false);
  assert.deepEqual(result.summary, { found: 2, unknown: 1 });
  assert.equal(file.catalog.fingerprint, catalogReport({ provider: 'hoyolab', map: file.map, catalog, progress: [] }).catalogFingerprint);
  const reversed = await buildSourceTransfer({ provider: 'hoyolab', map: file.map, generation: 'test-generation', catalog: catalog.toReversed(), foundIds: ['99', '43'] });
  assert.equal(reversed.envelope.catalog.fingerprint, file.catalog.fingerprint);
  assert.deepEqual(reversed.envelope.records, file.records);
});

test('source envelope rejects conflicting catalogs, invalid IDs and mixed maps instead of exporting partial data', async () => {
  const { buildSourceTransfer } = require('../../src/transfer/browser/source');
  const input = { provider: 'hoyolab', map: 'hoyolab:ys_obc:2', generation: 'test', catalog: [make('42')], foundIds: ['42'] };
  for (const patch of [{ catalog: [make('42'), make('42', '6')] }, { foundIds: [null] }, { catalog: [{ ...make('42'), map: 'other-map' }] }]) {
    await assert.rejects(buildSourceTransfer({ ...input, ...patch }));
  }
});

test('source preserves all found records when category coverage exceeds metadata capacity', async () => {
  const { buildSourceTransfer } = require('../../src/transfer/browser/source');
  const catalog = Array.from({ length: 4100 }, (_, i) => make(String(i + 1), String(i + 1)));
  const result = await buildSourceTransfer({ provider: 'hoyolab', map: 'hoyolab:ys_obc:2', generation: 'test', catalog, foundIds: catalog.map(row => row.id) });
  assert.equal(result.envelope.records.length, 4100); assert.deepEqual(result.envelope.coverage.categories, []); assert.equal(result.envelope.coverage.complete, false);
  const { planImport, planExport } = require('../../src/transfer/planner');
  const canonical = { namespace: 'appsample:gim:2', fingerprint: 'current', markers: [] };
  const imported = planImport(result.envelope, { markers: {} }, canonical, null);
  const output = planExport({ markers: {} }, imported.attachment, { provider: result.envelope.provider, map: result.envelope.map, catalog: canonical, pack: null,
    metadata: { producer: result.envelope.producer, adapterVersion: result.envelope.adapterVersion, exportedAt: result.envelope.exportedAt } });
  assert.equal(output.envelope.records.length, 4100); assert.deepEqual(output.envelope.coverage.categories, []);
});
