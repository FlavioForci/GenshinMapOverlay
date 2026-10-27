'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMappingResolver } = require('../../src/transfer/bundled-mappings');
const { matchRecords } = require('../../src/transfer/mapping');
const { buildSourceTransfer } = require('../../src/transfer/browser/source');
const { serializeTransfer } = require('../../src/transfer/envelope');
const { ProgressRepository } = require('../../src/progress/repository');
const { ProgressService } = require('../../src/progress/service');
const { TransferController } = require('../../src/transfer/controller');

for (const provider of ['hoyolab', 'kongying', 'bwiki']) test(`${provider} bundled source pairs import, persist, retain unknowns and merge idempotently`, async t => {
  const pack = require('../../src/transfer/providers/' + provider + '/mapping.json');
  const targets = require('../../src/transfer/providers/' + provider + '/mapping-targets.json');
  assert.ok(pack.pairs.length > 100);
  let catalog = { namespace: 'appsample:gim:2', fingerprint: pack.canonicalCatalogFingerprint, markers: targets };
  const getMapping = createMappingResolver(() => catalog);
  const source = pack.sourceMarkers.slice(0, 3).map(row => ({ id: row.id, map: pack.map, category: row.category, level: row.level,
    state: true, position: { x: row.x, y: row.y, space: row.space || pack.sourceCoordinateSpace } }));
  const file = await buildSourceTransfer({ provider, map: pack.map, generation: 'synthetic-save-with-real-reviewed-rows', catalog: source,
    foundIds: [...source.map(row => row.id), 'unknown-source-id'] });
  assert.equal(matchRecords(file.envelope, catalog, getMapping(provider, pack.map)).filter(row => row.status === 'matched').length, 3);
  assert.equal(getMapping('mapgenie', 'mapgenie:43:121'), null); assert.equal(getMapping(provider, 'other-map'), null);
  const { planExport } = require('../../src/transfer/planner');
  const canonicalId = pack.pairs.find(row => row.sourceId === source[0].id).canonicalId;
  const converted = planExport({ markers: { [canonicalId]: { value: true } } }, undefined, { provider, map: pack.map, catalog, pack: getMapping(provider, pack.map), metadata: { producer: { name: 'test', version: '1' }, adapterVersion: '0.1.0', exportedAt: new Date().toISOString() } });
  assert.equal(converted.envelope.records.length, 1);
  assert.equal(converted.envelope.records[0].position.space, source[0].position.space);
  assert.equal(matchRecords(converted.envelope, catalog, getMapping(provider, pack.map))[0].canonicalId, canonicalId);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'source-pair-import-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const root = path.join(userData, 'progress'), repository = new ProgressRepository({ root });
  const service = new ProgressService({ repository }); await service.initialize({ userData });
  const controller = new TransferController({ progress: service, getCatalog: () => catalog, getMapping });
  const context = () => ({ sessionGeneration: service.snapshot().sessionGeneration, profileId: service.snapshot().activeProfile.id });
  const bytes = Buffer.from(serializeTransfer(file.envelope));
  const preview = await controller.previewImport(context(), { bytes, mode: 'new' });
  assert.equal(preview.counts.matched, 3); assert.equal(preview.counts.unknown, 1);
  assert.deepEqual(service.snapshot().activeProfile.foundIds, []);
  assert.equal((await controller.applyImport(context(), { previewId: preview.id })).ok, true);
  const expected = pack.pairs.filter(row => source.some(s => s.id === row.sourceId)).map(row => Number(row.canonicalId)).sort((a, b) => a - b);
  assert.deepEqual(service.snapshot().activeProfile.foundIds, expected);
  const before = await repository.load({ kind: 'local' });
  const attachment = before.extensions.transfer.profiles[service.snapshot().activeProfile.id];
  assert.ok(attachment.records.some(row => row.record.id === 'unknown-source-id' && row.mapping === null));
  const again = await controller.previewImport(context(), { bytes, mode: 'merge' });
  assert.equal((await controller.applyImport(context(), { previewId: again.id })).ok, true);
  assert.equal((await repository.load({ kind: 'local' })).revision, before.revision);
  const reopened = new ProgressService({ repository: new ProgressRepository({ root }) }); await reopened.initialize({ userData });
  assert.deepEqual(reopened.snapshot().activeProfile.foundIds, expected);
  // A catalog update keeps unchanged targets usable, while a moved reviewed
  // target loses authority. The runtime cache must follow the new fingerprint.
  const movedId = pack.pairs.find(row => row.sourceId === source[0].id).canonicalId;
  const markers = targets.map(row => row.id === movedId ? { ...row, x: row.x + 1 } : row);
  catalog = { ...catalog, markers, fingerprint: createHash('sha256').update(JSON.stringify(markers)).digest('hex') };
  const changed = matchRecords(file.envelope, catalog, getMapping(provider, pack.map));
  assert.notEqual(changed.find(row => row.sourceId === source[0].id).status, 'matched');
  assert.equal(changed.filter(row => row.status === 'matched').length, 2);
});
