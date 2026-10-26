'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProgressService } = require('../../src/progress/service');
const { ProgressRepository } = require('../../src/progress/repository');
const { TransferController } = require('../../src/transfer/controller');
const { makeTransfer } = require('./helpers');
const { setFound } = require('../../src/progress/profiles');
const ACTOR = '10000000-0000-4000-8000-000000000001';
const local = { kind: 'local' };
const context = s => ({ sessionGeneration: s.snapshot().sessionGeneration, profileId: s.snapshot().activeProfile.id });
const bytes = (records = ['42', '43']) => Buffer.from(JSON.stringify(makeTransfer({ records: records.map(id => ({ id, map: 'appsample:gim:2', state: true, category: null, level: null, position: null })) })));
async function setup(t, adapter = fs, publicationGate) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-controller-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let sequence = 0; let time = 0;
  const uuid = () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const repository = new ProgressRepository({ root: path.join(dir, 'progress'), fs: adapter, uuid: () => ACTOR });
  const service = new ProgressService({ repository, uuid, publicationGate }); await service.initialize({ userData: dir });
  let catalog = { namespace: 'appsample:gim:2', fingerprint: 'synthetic-catalog', markers: ['42', '43', '99', '100'].map((id, x) => ({ id, x, y: 0, category: 'chest', level: null })) };
  const controller = new TransferController({ progress: service, getCatalog: () => catalog, getMapping: () => null, uuid, now: () => time });
  return { dir, repository, service, controller, ctx: () => context(service), tick: n => { time += n; }, refresh: () => { catalog = { ...catalog, fingerprint: 'changed' }; } };
}
const preview = f => f.controller.previewImport(f.ctx(), { bytes: bytes(), mode: 'merge' });

test('explicit merge adds fresh local truths and preserves destination-only progress/false registers', async t => {
  const f = await setup(t); const ctx = f.ctx();
  await f.service.setFound(ctx, { id: 99, found: true }); await f.service.setFound(ctx, { id: 42, found: false }); await f.service.setFound(ctx, { id: 100, found: false });
  const before = await f.repository.load(local); const p = await preview(f);
  assert.deepEqual(Object.keys(p).sort(), ['id', 'context', 'revision', 'catalogFingerprint', 'digest', 'counts', 'coverage', 'priorDestinations', 'canApply'].sort());
  const result = await f.controller.applyImport(ctx, { previewId: p.id }); assert.equal(result.ok, true);
  assert.deepEqual(result.value.snapshot.activeProfile.foundIds, [42, 43, 99]);
  const after = await f.repository.load(local); const target = after.state.profiles[ctx.profileId];
  assert.equal(target.markers['100'].value, false); assert.equal(target.markers['42'].actor, ACTOR); assert.ok(target.markers['42'].clock > before.clock);
  assert.equal(after.extensions.transfer.profiles[ctx.profileId].imports[0].createdProfile, false);
  const replay = await preview(f); const second = await f.controller.applyImport(ctx, { previewId: replay.id });
  assert.equal(second.ok, true); assert.equal((await f.repository.load(local)).revision, after.revision);
  assert.deepEqual(second.value.receipt, result.value.receipt);
});

test('new preview plans empty destination, activates atomically and repeated new requires createAnother', async t => {
  const f = await setup(t); await f.service.setFound(f.ctx(), { id: 99, found: true });
  const old = f.ctx(); const p = await f.controller.previewImport(old, { bytes: bytes(), mode: 'new', name: 'Imported', region: 'EU' });
  const applied = await f.controller.applyImport(old, { previewId: p.id }); assert.equal(applied.ok, true);
  const id = f.ctx().profileId; assert.notEqual(id, old.profileId); assert.notEqual(f.ctx().sessionGeneration, old.sessionGeneration);
  assert.deepEqual(applied.value.snapshot.activeProfile.foundIds, [42, 43]); assert.equal(applied.value.snapshot.activeProfile.name, 'Imported');
  const again = await f.controller.previewImport(f.ctx(), { bytes: bytes(), mode: 'new' });
  assert.deepEqual(again.priorDestinations, [{ id, name: 'Imported' }]); assert.equal(again.canApply, false);
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: again.id })).error.code, 'duplicate-import');
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: again.id, createAnother: true })).ok, true);
  assert.notEqual(f.ctx().profileId, id);
});

for (const change of ['edit', 'catalog', 'expire', 'replace', 'aba', 'remote']) test(`preview rejects ${change} before backup or writes`, async t => {
  const f = await setup(t); const ctx = f.ctx(); const p = await preview(f);
  if (change === 'edit') await f.service.setFound(ctx, { id: 99, found: true });
  if (change === 'catalog') f.refresh();
  if (change === 'expire') f.tick(15 * 60 * 1000);
  if (change === 'replace') await preview(f);
  if (change === 'aba') {
    await f.service.createProfile({ sessionGeneration: ctx.sessionGeneration, name: 'Other', region: '' });
    await f.service.selectProfile({ sessionGeneration: f.ctx().sessionGeneration, profileId: ctx.profileId });
  }
  if (change === 'remote') await f.repository.transact(local, draft => setFound(draft, { profileId: ctx.profileId, id: 99, found: true }, ACTOR));
  const before = await f.repository.load(local); const archives = await fs.readdir(path.join(f.dir, 'progress/backups'));
  const result = await f.controller.applyImport(change === 'aba' ? ctx : f.ctx(), { previewId: p.id });
  assert.equal(result.ok, false); assert.ok(['stale-preview', 'stale-context'].includes(result.error.code));
  assert.deepEqual(await f.repository.load(local), before); assert.deepEqual(await fs.readdir(path.join(f.dir, 'progress/backups')), archives);
});

test('tokens are one use; invalid input has no token; export uses local metadata and undo suppression', async t => {
  const f = await setup(t);
  await assert.rejects(f.controller.previewImport(f.ctx(), { bytes: Buffer.from('{'), mode: 'new' }), { code: 'invalid-transfer' });
  const p = await preview(f); assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).ok, true);
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).error.code, 'stale-preview');
  await f.service.setFound(f.ctx(), { id: 42, found: false });
  const out = await f.controller.exportProfile(f.ctx(), { provider: 'appsample', map: 'appsample:gim:2' });
  assert.equal(out.envelope.records.some(r => r.id === '42' && r.state), false);
  assert.equal(out.envelope.producer.version, require('../../package.json').version); assert.equal(out.envelope.exportedAt, '1970-01-01T00:00:00.000Z');
});

for (const failure of ['backup', 'before-rename', 'after-rename']) test(`atomic import survives ${failure} and reopen without split attachments`, async t => {
  let armed = false;
  const adapter = { ...fs, rename: async (a, b) => {
    if (armed && ((failure === 'backup' && /local-import-/.test(b)) || (failure === 'before-rename' && b.endsWith('/local/state.json')))) { armed = false; throw Object.assign(Error('synthetic failure'), { code: 'EIO' }); }
    await fs.rename(a, b);
    if (armed && failure === 'after-rename' && b.endsWith('/local/state.json')) { armed = false; throw Object.assign(Error('synthetic uncertainty'), { code: 'EIO' }); }
  } };
  const notifications = []; const gate = { pause: async () => () => {}, notifyCommitted: r => notifications.push(r) };
  const f = await setup(t, adapter, gate); const p = await preview(f); armed = true;
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).ok, false); assert.deepEqual(notifications, []);
  const reopened = new ProgressRepository({ root: path.join(f.dir, 'progress') }); const durable = await reopened.load(local);
  const id = durable.selectedProfileId; const imported = !!durable.state.profiles[id].markers['42']?.value;
  assert.equal(!!durable.extensions?.transfer.profiles[id], imported); assert.equal(imported, failure === 'after-rename');
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).error.code, 'stale-preview');
  const retry = await preview(f); assert.equal((await f.controller.applyImport(f.ctx(), { previewId: retry.id })).ok, true);
});

test('controller preserves parsed duplicate counts before any cloning and false observations never clear', async t => {
  const f = await setup(t); await f.service.setFound(f.ctx(), { id: 100, found: true });
  const raw = JSON.parse(bytes(['42', '42', '100']).toString()); raw.records[2].state = false;
  const p = await f.controller.previewImport(f.ctx(), { bytes: Buffer.from(JSON.stringify(raw)), mode: 'merge' });
  assert.equal(p.counts.duplicates, 1); assert.equal(p.counts.ignoredNotFound, 1);
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).ok, true);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42, 100]);
});

test('forged portable v2 provenance cannot revive a mapped undo on controller export', async t => {
  const f = await setup(t); const ctx = f.ctx(); const p = await preview(f);
  await f.controller.applyImport(ctx, { previewId: p.id });
  const portable = await f.service.exportBackup({ sessionGeneration: ctx.sessionGeneration, profileIds: [ctx.profileId] });
  const backup = JSON.parse(portable.value); const retained = backup.extensions.transfer.profiles['0'].records[0];
  retained.record.id = 'forged-source';
  // Valid shape, claimed canonical authority from an untrusted portable file.
  const imported = await f.service.importBackup({ sessionGeneration: ctx.sessionGeneration, bytes: Buffer.from(JSON.stringify(backup)) });
  assert.equal(imported.ok, true);
  await f.service.setFound(f.ctx(), { id: 42, found: false }); await f.service.setFound(f.ctx(), { id: 43, found: false });
  const out = await f.controller.exportProfile(f.ctx(), { provider: 'appsample', map: 'appsample:gim:2' });
  assert.deepEqual(out.envelope.records, []); assert.ok(out.report.counts.unsupported > 0);
});

test('paused fake publication interlock blocks import until local critical section leaves', async t => {
  let leave; let enteredGate;
  const entered = new Promise(resolve => { leave = resolve; }); const atGate = new Promise(resolve => { enteredGate = resolve; }); const events = [];
  const f = await setup(t, fs, { pause: async () => { events.push('pause'); enteredGate(); await entered; return () => events.push('release'); }, notifyCommitted: r => events.push(`notify:${r}`) });
  const p = await preview(f); const apply = f.controller.applyImport(f.ctx(), { previewId: p.id });
  // Wait for the actual gate boundary without sleeping or pretending a remote request is a lock.
  await atGate;
  assert.deepEqual(events, ['pause']); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []);
  leave(); assert.equal((await apply).ok, true);
  assert.equal(events[1], 'release'); assert.match(events[2], /^notify:/);
});

test('catalog refresh during backup rejects final compatibility guard before primary changes', async t => {
  const f = await setup(t); const p = await preview(f); const before = await f.repository.load(local);
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { await backup(...args); f.refresh(); };
  const result = await f.controller.applyImport(f.ctx(), { previewId: p.id });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'stale-preview');
  assert.deepEqual(await f.repository.load(local), before); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []);
});

test('synthetic reviewed transfer reauthorizes pack after backup and round-trips unknown numeric source IDs', async t => {
  const f = await setup(t); const map = 'synthetic-hoyolab:2';
  let pack = { version: 1, provider: 'hoyolab', map, sourceCatalogFingerprint: 'synthetic-source', canonicalCatalogFingerprint: 'synthetic-catalog', sourceCoordinateSpace: 'synthetic', sourceMarkers: [{ id: 'a', x: 0, y: 0, category: 'chest', level: null }], categoryPairs: [{ source: 'chest', target: 'chest', permanent: true }], levelPairs: [], pairs: [{ sourceId: 'a', canonicalId: '42' }], spatial: null };
  f.controller.getMapping = () => pack;
  const raw = makeTransfer({ provider: 'hoyolab', map, catalog: { generation: 'synthetic', fingerprint: 'synthetic-source' }, records: ['a', '42'].map(id => ({ id, map, category: null, level: null, position: null, state: true })) });
  const options = { bytes: Buffer.from(JSON.stringify(raw)), mode: 'merge' };
  const p = await f.controller.previewImport(f.ctx(), options); const before = await f.repository.load(local);
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { await backup(...args); pack = { ...pack, sourceCoordinateSpace: 'changed-review' }; };
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: p.id })).error.code, 'stale-preview');
  assert.deepEqual(await f.repository.load(local), before);
  f.repository.backup = backup;
  const refreshed = await f.controller.previewImport(f.ctx(), options);
  assert.equal((await f.controller.applyImport(f.ctx(), { previewId: refreshed.id })).ok, true);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  await f.service.setFound(f.ctx(), { id: 42, found: false });
  const out = await f.controller.exportProfile(f.ctx(), { provider: 'hoyolab', map });
  assert.deepEqual(out.envelope.records.map(r => r.id), ['42']);
  assert.ok(out.report.decisions.every(r => r.reason === 'canonical-not-found'));
});

test('new-profile import failure after rename reopens with matching attachment and durable activation', async t => {
  let armed = false;
  const f = await setup(t, { ...fs, rename: async (a, b) => { await fs.rename(a, b); if (armed && b.endsWith('/local/state.json')) { armed = false; throw Object.assign(Error('synthetic uncertainty'), { code: 'EIO' }); } } });
  const old = f.ctx(); const p = await f.controller.previewImport(old, { bytes: bytes(), mode: 'new' }); armed = true;
  const result = await f.controller.applyImport(old, { previewId: p.id }); assert.equal(result.error.code, 'local-durability-uncertain');
  const repository = new ProgressRepository({ root: path.join(f.dir, 'progress') });
  const reopened = new ProgressService({ repository }); const snapshot = await reopened.initialize({ userData: f.dir });
  const durable = await repository.load(local);
  assert.notEqual(snapshot.activeProfile.id, old.profileId); assert.deepEqual(snapshot.activeProfile.foundIds, [42, 43]);
  assert.equal(durable.extensions.transfer.profiles[snapshot.activeProfile.id].imports[0].createdProfile, true);
  assert.notEqual(result.snapshot.sessionGeneration, old.sessionGeneration);
});
