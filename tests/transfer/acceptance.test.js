'use strict';
// Generic offline acceptance only. The two normalized synthetic fixtures below
// are NOT raw provider saves, production normalizers, or the five live pairs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProgressRepository } = require('../../src/progress/repository');
const { ProgressService } = require('../../src/progress/service');
const { validateState, validateEnvelope } = require('../../src/progress/schema');
const { TransferController } = require('../../src/transfer/controller');
const { parseTransfer, serializeTransfer } = require('../../src/transfer/envelope');
const { mappingPackVersion } = require('../../src/transfer/mapping');
const { createBrowserTransfer } = require('../../src/transfer/browser/runtime');
const { makeBrowserHarness } = require('./helpers');
const ACTOR = '10000000-0000-4000-8000-000000000001';
const LOCAL = { kind: 'local' };
const ctx = service => ({ sessionGeneration: service.snapshot().sessionGeneration, profileId: service.snapshot().activeProfile.id });

async function localFixture(t, { adapter = fs, publicationGate } = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-acceptance-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const legacy = Buffer.from(' {"ids":[44]}\n');
  await fs.writeFile(path.join(userData, 'found.json'), legacy);
  await fs.writeFile(path.join(userData, 'settings.json'), '{"enabledTypes":["o5"],"hideFound":true}');
  let sequence = 0;
  const uuid = () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const repository = new ProgressRepository({ root: path.join(userData, 'progress'), fs: adapter, uuid: () => ACTOR });
  const service = new ProgressService({ repository, uuid, publicationGate }); await service.initialize({ userData });
  assert.equal(service.snapshot().sync.phase, 'local', JSON.stringify(service.snapshot().sync));
  const catalog = { namespace: 'appsample:gim:2', fingerprint: 'b'.repeat(64), markers: ['42', '43', '44'].map((id, i) => ({ id, x: i, y: 0, category: 'synthetic-chest', level: null })) };
  let mapping = null;
  const controller = new TransferController({ progress: service, getCatalog: () => catalog, getMapping: () => mapping, uuid, now: () => 0 });
  return { userData, legacy, repository, service, controller, catalog, setMapping: pack => { mapping = pack; }, ctx: () => ctx(service) };
}
function syntheticPack(catalog, source) {
  return { version: 1, provider: source.provider, map: source.map, sourceCatalogFingerprint: source.catalog.fingerprint,
    canonicalCatalogFingerprint: catalog.fingerprint, sourceCoordinateSpace: 'synthetic-pixels',
    sourceMarkers: catalog.markers.map(row => ({ ...row })), categoryPairs: [{ source: 'synthetic-chest', target: 'synthetic-chest', permanent: true }],
    levelPairs: [], pairs: ['42', '43', '44'].map(id => ({ sourceId: id, canonicalId: id })), spatial: null };
}
async function sourceFile(provider) {
  const site = makeBrowserHarness({ provider, foundIds: ['42', '43'] });
  const runner = createBrowserTransfer(site); await runner.exportProgress(); await runner.dispose();
  const source = parseTransfer(site.downloads[0].bytes);
  source.records.forEach(record => { record.category = 'synthetic-chest'; });
  source.records.push({ id: 'unknown-retained', map: source.map, category: null, level: null, state: true, position: null });
  return { source, bytes: Buffer.from(serializeTransfer(source)) };
}
async function importFile(f, bytes, mode = 'merge') {
  const preview = await f.controller.previewImport(f.ctx(), { bytes, mode });
  const result = await f.controller.applyImport(f.ctx(), { previewId: preview.id });
  assert.equal(result.ok, true, JSON.stringify(result.error)); return { preview, result };
}

for (const provider of ['appsample', 'mapgenie']) test(`synthetic ${provider} envelope: migration → import → undo → export → portable restore → runner → reimport`, async t => {
  const f = await localFixture(t); const { source, bytes } = await sourceFile(provider);
  const pack = provider === 'appsample' ? null : syntheticPack(f.catalog, source); f.setMapping(pack);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [44]);
  assert.deepEqual(f.service.snapshot().activeProfile.enabledTypes, ['o5']);
  assert.equal(f.service.snapshot().activeProfile.hideFound, true);
  assert.deepEqual(await fs.readFile(path.join(f.userData, 'found.json')), f.legacy);
  const beforePreview = await f.repository.load(LOCAL); const first = await importFile(f, bytes);
  assert.equal(first.preview.counts.matched, 2); assert.equal(first.preview.counts.unknown, 1);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42, 43, 44]);
  const imported = await f.repository.load(LOCAL); const profileId = f.ctx().profileId;
  assert.ok(imported.state.profiles[profileId].markers['42'].clock > beforePreview.clock);
  const attachment = imported.extensions.transfer.profiles[profileId];
  assert.equal(attachment.records.find(row => row.record.id === '42').mapping.mappingVersion, pack ? mappingPackVersion(pack) : 'identity:appsample:gim:2');
  assert.equal(attachment.records.find(row => row.record.id === 'unknown-retained').mapping, null);
  await importFile(f, bytes); assert.equal((await f.repository.load(LOCAL)).revision, imported.revision);
  assert.equal((await f.service.setFound(f.ctx(), { id: 42, found: false })).ok, true);
  const exported = await f.controller.exportProfile(f.ctx(), { provider, map: source.map });
  assert.deepEqual(exported.envelope.records.map(row => row.id), ['43', '44', 'unknown-retained']);
  assert.equal(exported.report.counts.ignoredNotFound, 1);
  const backup = await f.service.exportBackup({ sessionGeneration: f.ctx().sessionGeneration, profileIds: [profileId] }); assert.equal(backup.ok, true);
  assert.equal(JSON.parse(backup.value).version, 2);
  const restored = await f.service.importBackup({ sessionGeneration: f.ctx().sessionGeneration, bytes: Buffer.from(backup.value) }); assert.equal(restored.ok, true);
  assert.notEqual(f.ctx().profileId, profileId);
  const durable = await f.repository.load(LOCAL);
  assert.deepEqual(durable.extensions.transfer.profiles[f.ctx().profileId], attachment);
  const reexported = await f.controller.exportProfile(f.ctx(), { provider, map: source.map });
  assert.deepEqual(reexported.envelope, exported.envelope);
  // This is the existing canonical schema boundary. No Drive codec exists yet.
  const canonicalState = validateState(durable.state); assert.equal(Object.hasOwn(canonicalState, 'extensions'), false);
  assert.throws(() => validateEnvelope(durable, { kind: 'account', accountKey: 'a'.repeat(64) }), { code: 'unsupported-scope' });

  const destination = makeBrowserHarness({ provider, foundIds: ['44'], failures: { '43': ['uncertain'] } });
  // A fixture-local catalog matching this normalized export, never a provider normalizer.
  destination.adapter.capability.variants[0].catalogFingerprint = reexported.envelope.catalog.fingerprint;
  destination.context.catalogFingerprint = reexported.envelope.catalog.fingerprint;
  const runner = createBrowserTransfer(destination);
  const browserPreview = await runner.preview(serializeTransfer(reexported.envelope)); assert.equal(browserPreview.counts.add, 1);
  await assert.rejects(runner.apply(), { code: 'backup-acknowledgement-required' }); assert.deepEqual(destination.writes, []);
  assert.deepEqual(parseTransfer(destination.downloads[0].bytes).records.map(row => row.id), ['44']);
  runner.acknowledgeBackup(); const receipt = await runner.apply();
  assert.equal(receipt.status, 'complete'); assert.deepEqual(receipt.confirmed, ['43']); assert.deepEqual(receipt.unchanged, ['44']);
  assert.deepEqual(receipt.skipped, [{ id: 'unknown-retained', reason: 'outside-catalog' }]); assert.deepEqual(destination.writes, ['43']);
  await runner.dispose();
  const repeated = createBrowserTransfer(destination); await repeated.preview(serializeTransfer(reexported.envelope)); repeated.acknowledgeBackup();
  const replay = await repeated.apply(); assert.deepEqual(replay.confirmed, []); assert.deepEqual(replay.unchanged, ['43', '44']); assert.deepEqual(destination.writes, ['43']);
  // Export through the actual runner after replacement, rather than trusting receipt IDs.
  await repeated.exportProgress(); const fresh = parseTransfer(destination.downloads.at(-1).bytes);
  assert.deepEqual(fresh.records.map(row => row.id), ['43', '44']);
  await importFile(f, Buffer.from(serializeTransfer(fresh)), 'new');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [43, 44]);
  const reopened = new ProgressRepository({ root: path.join(f.userData, 'progress') });
  assert.deepEqual(await reopened.load(LOCAL), await f.repository.load(LOCAL)); await repeated.dispose();
});

for (const stage of ['backup', 'final-rename']) test(`full import pipeline keeps canonical state and retained records together on ${stage} failure`, async t => {
  let armed = false;
  const adapter = { ...fs, rename: async (from, to) => {
    if (armed && ((stage === 'backup' && /local-import-/.test(to)) || (stage === 'final-rename' && to.endsWith('/local/state.json')))) {
      armed = false; throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    }
    return fs.rename(from, to);
  } };
  const f = await localFixture(t, { adapter }); const { bytes } = await sourceFile('appsample');
  const before = await f.repository.load(LOCAL); const preview = await f.controller.previewImport(f.ctx(), { bytes, mode: 'merge' }); armed = true;
  const result = await f.controller.applyImport(f.ctx(), { previewId: preview.id }); assert.equal(result.ok, false);
  const reopened = new ProgressRepository({ root: path.join(f.userData, 'progress') }); assert.deepEqual(await reopened.load(LOCAL), before);
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: preview.id })).error.code, 'stale-preview');
  await importFile(f, bytes); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42, 43, 44]);
  assert.equal((await reopened.load(LOCAL)).extensions.transfer.profiles[f.ctx().profileId].records.length, 3);
});

test('fake publication interlock observes one durable canonical+attachment import before notification, including portable restore', async t => {
  let release; let enter; const paused = new Promise(resolve => { enter = resolve; }); const wait = new Promise(resolve => { release = resolve; }); const events = [];
  let f;
  const gate = { pause: async () => { events.push('pause'); enter(); await wait; return () => events.push('release'); },
    notifyCommitted: revision => { events.push('notify'); assert.equal(f.service.snapshot().activeProfile.foundIds.includes(42), true); events.push(revision); } };
  f = await localFixture(t, { publicationGate: gate }); const { bytes } = await sourceFile('appsample');
  const preview = await f.controller.previewImport(f.ctx(), { bytes, mode: 'merge' });
  const pending = f.controller.applyImport(f.ctx(), { previewId: preview.id }); await paused;
  assert.deepEqual(events, ['pause']); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [44]);
  assert.equal((await f.repository.load(LOCAL)).extensions, undefined);
  release(); assert.equal((await pending).ok, true); const saved = await f.repository.load(LOCAL);
  assert.deepEqual(events, ['pause', 'release', 'notify', saved.revision]);
  assert.equal(saved.extensions.transfer.profiles[f.ctx().profileId].records.length, 3);
  const backup = await f.service.exportBackup({ sessionGeneration: f.ctx().sessionGeneration, profileIds: [f.ctx().profileId] });
  events.length = 0;
  assert.equal((await f.service.importBackup({ sessionGeneration: f.ctx().sessionGeneration, bytes: Buffer.from(backup.value) })).ok, true);
  const restored = await f.repository.load(LOCAL); assert.deepEqual(events, ['pause', 'release', 'notify', restored.revision]);
  assert.equal(restored.extensions.transfer.profiles[f.ctx().profileId].records.length, 3);
});
