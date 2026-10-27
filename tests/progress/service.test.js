'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProgressService } = require('../../src/progress/service');
const { ProgressRepository } = require('../../src/progress/repository');
const { setFound } = require('../../src/progress/profiles');
const { ACTOR_A } = require('./helpers');
const local = { kind: 'local' };
const context = service => ({ sessionGeneration: service.snapshot().sessionGeneration, profileId: service.snapshot().activeProfile.id });
const generation = service => ({ sessionGeneration: service.snapshot().sessionGeneration });
async function setup(t, { adapter = fs, onSnapshot, publicationGate } = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-service-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const root = path.join(userData, 'progress');
  const repository = new ProgressRepository({ root, uuid: () => ACTOR_A, fs: adapter });
  let sequence = 0;
  const service = new ProgressService({ repository, uuid: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, onSnapshot, publicationGate });
  return { userData, root, repository, service };
}
async function ready(t, options) { const f = await setup(t, options); await f.service.initialize({ userData: f.userData }); return f; }
function defer() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('initialization migrates before publishing detached safe snapshots', async t => {
  const seen = []; const f = await setup(t, { onSnapshot: s => seen.push(s) });
  await fs.writeFile(path.join(f.userData, 'found.json'), '{"ids":[42,900000001]}');
  const snapshot = await f.service.initialize({ userData: f.userData });
  assert.deepEqual(snapshot.activeProfile.foundIds, [42, 900000001]);
  assert.equal(snapshot.activeProfile.name, 'Local progress');
  assert.equal(snapshot.scope, 'local'); assert.equal(snapshot.account, null); assert.equal(snapshot.sync.phase, 'local');
  const output = JSON.stringify(snapshot);
  for (const secret of ['actor', 'clock', 'revision', f.userData, ACTOR_A]) assert.equal(output.includes(secret), false);
  assert.equal(seen.length, 1);
  snapshot.activeProfile.foundIds.push(99); seen[0].activeProfile.name = 'mutated';
  assert.equal(f.service.snapshot().activeProfile.name, 'Local progress');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42, 900000001]);
});

test('durable desired-value setters preserve no-op revision and explicit absent false', async t => {
  const f = await ready(t); const ctx = context(f.service);
  assert.equal((await f.service.setFound(ctx, { id: 42, found: true })).ok, true);
  const afterFirst = await f.repository.load(local);
  assert.equal((await f.service.setFound(ctx, { id: 42, found: true })).ok, true);
  const afterRepeated = await f.repository.load(local);
  assert.equal(afterRepeated.revision, afterFirst.revision); assert.equal(afterRepeated.clock, afterFirst.clock);
  await f.service.setFound(ctx, { id: 42, found: false });
  await f.service.setFound(ctx, { id: 43, found: false });
  assert.equal((await f.repository.load(local)).state.profiles[ctx.profileId].markers['42'].value, false);
  assert.equal((await f.repository.load(local)).state.profiles[ctx.profileId].markers['43'].value, false);
  await f.service.setPreferences(ctx, { enabledTypes: ['o900000001', 'o5'], hideFound: true });
  await f.service.renameProfile(ctx, { name: ' <旅人> ', region: 'EU' });
  assert.equal(f.service.snapshot().activeProfile.name, '<旅人>');
  assert.deepEqual(f.service.snapshot().activeProfile.enabledTypes, ['o5', 'o900000001']);
});

test('returning to the same profile invalidates old context and selection rotates even on no-op', async t => {
  const f = await ready(t); const oldA = context(f.service);
  const created = await f.service.createProfile({ ...generation(f.service), name: 'B', region: '' });
  assert.equal(created.ok, true); const b = context(f.service);
  assert.notEqual(b.profileId, oldA.profileId);
  await f.service.selectProfile({ ...b, profileId: oldA.profileId });
  assert.equal((await f.service.setFound(oldA, { id: 42, found: true })).error.code, 'stale-context');
  const current = context(f.service); const before = await f.repository.load(local);
  await f.service.selectProfile(current);
  assert.notEqual(f.service.snapshot().sessionGeneration, current.sessionGeneration);
  assert.equal((await f.repository.load(local)).revision, before.revision);
  assert.equal((await f.service.setFound(current, { id: 42, found: true })).error.code, 'stale-context');
});

test('queued selection invalidates a mutation before repository callback', async t => {
  const f = await ready(t); const a = context(f.service);
  await f.service.createProfile({ ...generation(f.service), name: 'B', region: '' });
  const b = context(f.service);
  const selection = f.service.selectProfile({ ...b, profileId: a.profileId });
  const edit = f.service.setFound(b, { id: 42, found: true });
  assert.equal((await selection).ok, true);
  assert.equal((await edit).error.code, 'stale-context');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []);
});

test('snapshot is emitted only after repository durability and notification exceptions cannot undo success', async t => {
  const entered = defer(); const release = defer(); let armed = false; let emitted = 0;
  const adapter = { ...fs, rename: async (source, target) => {
    if (armed && target.endsWith('/local/state.json')) { entered.resolve(); await release.promise; }
    return fs.rename(source, target);
  } };
  const f = await ready(t, { adapter, onSnapshot: () => { emitted++; if (armed) throw Error('listener failed'); } });
  armed = true; const editing = f.service.setFound(context(f.service), { id: 42, found: true });
  await entered.promise;
  assert.equal(emitted, 1); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []);
  release.resolve(); const result = await editing;
  assert.equal(result.ok, true); assert.deepEqual(result.value.activeProfile.foundIds, [42]);
  assert.deepEqual((await f.repository.load(local)).state.profiles[result.value.activeProfile.id].markers['42'].value, true);
});

test('transient write failure returns current durable snapshot and later edits work', async t => {
  let fail = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    if (fail && target.endsWith('/local/state.json')) { fail = false; throw Object.assign(Error('private /secret'), { code: 'EIO' }); }
    return fs.rename(source, target);
  } } });
  const ctx = context(f.service);
  await f.service.setFound(ctx, { id: 42, found: true }); fail = true;
  const failed = await f.service.setFound(ctx, { id: 43, found: true });
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'local-write-failed');
  assert.deepEqual(failed.snapshot.activeProfile.foundIds, [42]);
  assert.equal(failed.snapshot.sync.phase, 'local');
  assert.equal(JSON.stringify(failed).includes('/secret'), false);
  assert.equal((await f.service.setFound(ctx, { id: 44, found: true })).ok, true);
});

test('persistent post-rename uncertainty is read-only and initialization retries actual new state', async t => {
  let armed = false; let renamed = false;
  const f = await ready(t, { adapter: { ...fs,
    rename: async (source, target) => { await fs.rename(source, target); if (armed && target.endsWith('/local/state.json')) renamed = true; },
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (armed && renamed && file.endsWith('/local')) return new Proxy(handle, { get(target, key) { if (key === 'sync') return async () => { throw Object.assign(Error('uncertain'), { code: 'EIO' }); }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
      return handle;
    },
  } });
  const ctx = context(f.service); armed = true;
  const failed = await f.service.setFound(ctx, { id: 42, found: true });
  assert.equal(failed.error.code, 'local-durability-uncertain'); assert.equal(failed.snapshot.sync.phase, 'recovery');
  assert.equal(failed.snapshot.sync.code, 'local-durability-uncertain');
  assert.equal((await f.service.setFound(ctx, { id: 43, found: true })).ok, false);
  const still = await f.service.initialize({ userData: f.userData }); assert.equal(still.sync.phase, 'recovery');
  armed = false;
  const retried = await f.service.initialize({ userData: f.userData });
  assert.equal(retried.sync.phase, 'local'); assert.deepEqual(retried.activeProfile.foundIds, [42]);
});

test('import archives before mutation, keeps existing false registers and creates fresh identities', async t => {
  const f = await ready(t); const ctx = context(f.service);
  await f.service.setFound(ctx, { id: 42, found: true });
  const exported = await f.service.exportBackup({ ...generation(f.service), profileIds: [ctx.profileId] });
  await f.service.setFound(ctx, { id: 42, found: false });
  const result = await f.service.importBackup({ ...generation(f.service), bytes: Buffer.from(exported.value) });
  assert.equal(result.ok, true); assert.equal(result.value.profiles.length, 2);
  const envelope = await f.repository.load(local);
  assert.equal(envelope.state.profiles[ctx.profileId].markers['42'].value, false);
  const imported = Object.keys(envelope.state.profiles).find(id => id !== ctx.profileId);
  assert.equal(envelope.state.profiles[imported].markers['42'].actor, ACTOR_A);
  assert.ok((await fs.readdir(path.join(f.root, 'backups'))).some(name => name.startsWith('local-import-')));
});

test('backup failure leaves staged import invisible and primary/last-good/revision unchanged', async t => {
  let fail = false; const seen = []; const notifications = [];
  const f = await ready(t, { onSnapshot: snapshot => seen.push(snapshot), publicationGate: { pause: async () => () => {}, notifyCommitted: revision => notifications.push(revision) }, adapter: { ...fs, rename: async (source, target) => {
    if (fail && /local-import-/.test(target)) throw Object.assign(Error('backup failed'), { code: 'EIO' });
    return fs.rename(source, target);
  } } });
  const before = await f.repository.load(local);
  const backup = await f.service.exportBackup({ ...generation(f.service), profileIds: [context(f.service).profileId] });
  const primary = await fs.readFile(path.join(f.root, 'local/state.json'), 'utf8');
  const lastGood = await fs.readFile(path.join(f.root, 'local/state.last-good.json'), 'utf8');
  const snapshot = f.service.snapshot(); seen.length = 0;
  fail = true;
  assert.equal((await f.service.importBackup({ ...generation(f.service), bytes: Buffer.from(backup.value) })).error.code, 'local-backup-failed');
  let preparations = 0;
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'restore' }, (draft, actor) => { preparations++; setFound(draft, { profileId: context(f.service).profileId, id: 42, found: true }, actor); }), { code: 'local-backup-failed' });
  assert.equal(preparations, 1); assert.deepEqual(await f.repository.load(local), before);
  assert.equal(await fs.readFile(path.join(f.root, 'local/state.json'), 'utf8'), primary);
  assert.equal(await fs.readFile(path.join(f.root, 'local/state.last-good.json'), 'utf8'), lastGood);
  assert.ok(seen.every(value => JSON.stringify(value.activeProfile) === JSON.stringify(snapshot.activeProfile)));
  assert.deepEqual(notifications, []);
});

test('internal transaction checks revision, commits bulk once and rejects async callbacks', async t => {
  const f = await ready(t); const ctx = context(f.service); const before = await f.repository.load(local);
  let called = false;
  await assert.rejects(f.service.runProfileTransaction(ctx, { expectedRevision: before.revision - 1, reason: 'edit' }, () => { called = true; }), { code: 'revision-conflict' });
  assert.equal(called, false);
  const after = await f.service.runProfileTransaction(ctx, { expectedRevision: before.revision, reason: 'edit' }, (draft, actor) => {
    for (let id = 1; id <= 500; id++) setFound(draft, { profileId: ctx.profileId, id, found: true }, actor);
  });
  assert.equal(after.revision, before.revision + 1); assert.equal(f.service.snapshot().activeProfile.foundIds.length, 500);
  await assert.rejects(f.service.runProfileTransaction(ctx, { reason: 'edit' }, async () => {}), { code: 'invalid-mutation' });
  assert.equal((await f.repository.load(local)).revision, after.revision);
});

test('malformed portable input and stale session leave disk and archives unchanged', async t => {
  const f = await ready(t); const before = await f.repository.load(local); const archives = await fs.readdir(path.join(f.root, 'backups'));
  assert.equal((await f.service.importBackup({ ...generation(f.service), bytes: Buffer.from('{') })).error.code, 'invalid-backup');
  assert.equal((await f.service.exportBackup({ sessionGeneration: 'old', profileIds: [] })).error.code, 'stale-context');
  assert.deepEqual(await f.repository.load(local), before); assert.deepEqual(await fs.readdir(path.join(f.root, 'backups')), archives);
});

test('corrupt local primary requires explicit validated restore', async t => {
  const f = await ready(t); const ctx = context(f.service);
  await f.service.setFound(ctx, { id: 42, found: true });
  await f.service.setFound(ctx, { id: 43, found: true });
  await fs.writeFile(path.join(f.root, 'local/state.json'), '{broken');
  await f.service.initialize({ userData: f.userData });
  assert.equal(f.service.snapshot().sync.phase, 'recovery');
  assert.equal((await f.service.setFound(context(f.service), { id: 9, found: true })).ok, false);
  const restored = await f.service.restoreLocalBackup(generation(f.service));
  assert.equal(restored.ok, true); assert.equal(restored.value.sync.phase, 'local');
  assert.deepEqual(restored.value.activeProfile.foundIds, [42]);
  assert.notEqual(restored.value.sessionGeneration, ctx.sessionGeneration);
});

test('restoring an initial migrationIncomplete last-good reruns migration into usable profile', async t => {
  const f = await ready(t);
  // First migration leaves the empty initial envelope as last-good.
  await fs.writeFile(path.join(f.root, 'local/state.json'), '{broken');
  await f.service.initialize({ userData: f.userData });
  const result = await f.service.restoreLocalBackup(generation(f.service));
  assert.equal(result.ok, true); assert.equal(result.value.activeProfile.name, 'Local progress');
  assert.equal(result.value.sync.phase, 'local'); assert.equal((await f.repository.load(local)).migrationComplete, true);
});

test('shutdown drains queued writes and failure does not poison draining', async t => {
  const f = await ready(t); const ctx = context(f.service);
  const editing = f.service.setFound(ctx, { id: 42, found: true });
  const closing = f.service.shutdown();
  assert.equal((await editing).ok, true); await closing;
  assert.equal((await f.repository.load(local)).state.profiles[ctx.profileId].markers['42'].value, true);
  assert.equal((await f.service.setFound(ctx, { id: 43, found: true })).error.code, 'service-closed');
});

test('shutdown drains a failed write followed by a later queued desired value', async t => {
  let armed = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    if (armed && target.endsWith('/local/state.json')) { armed = false; throw Object.assign(Error('fail once'), { code: 'EIO' }); }
    return fs.rename(source, target);
  } } });
  const ctx = context(f.service); armed = true;
  const first = f.service.setFound(ctx, { id: 42, found: true });
  const second = f.service.setFound(ctx, { id: 42, found: false });
  const closing = f.service.shutdown();
  assert.equal((await first).error.code, 'local-write-failed'); assert.equal((await second).ok, true);
  await closing;
  assert.equal((await f.repository.load(local)).state.profiles[ctx.profileId].markers['42'].value, false);
});

test('shutdown retries persistent directory uncertainty and adopts actual new durable state', async t => {
  let armed = false; let renamed = false;
  const f = await ready(t, { adapter: { ...fs,
    rename: async (source, target) => { await fs.rename(source, target); if (armed && target.endsWith('/local/state.json')) renamed = true; },
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (armed && renamed && file.endsWith('/local')) return new Proxy(handle, { get(target, key) { if (key === 'sync') return async () => { throw Object.assign(Error('uncertain'), { code: 'EIO' }); }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
      return handle;
    },
  } });
  armed = true;
  assert.equal((await f.service.setFound(context(f.service), { id: 42, found: true })).error.code, 'local-durability-uncertain');
  armed = false; await f.service.shutdown();
  assert.equal(f.service.snapshot().sync.phase, 'local');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});

test('initial malformed legacy data stays read-only and does not publish an empty usable profile', async t => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.userData, 'settings.json'), '{broken');
  const snapshot = await f.service.initialize({ userData: f.userData });
  assert.equal(snapshot.sync.phase, 'recovery'); assert.equal(snapshot.activeProfile, null);
  assert.equal((await f.service.createProfile({ ...generation(f.service), name: 'Unsafe', region: '' })).ok, false);
  assert.equal((await f.repository.load(local)).migrationComplete, false);
});

test('shutdown can be retried after persistent durability uncertainty clears', async t => {
  let armed = false; let renamed = false;
  const f = await ready(t, { adapter: { ...fs,
    rename: async (source, target) => { await fs.rename(source, target); if (armed && target.endsWith('/local/state.json')) renamed = true; },
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (armed && renamed && file.endsWith('/local')) return new Proxy(handle, { get(target, key) { if (key === 'sync') return async () => { throw Object.assign(Error('uncertain'), { code: 'EIO' }); }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
      return handle;
    },
  } });
  armed = true;
  await f.service.setFound(context(f.service), { id: 42, found: true });
  await assert.rejects(f.service.shutdown(), { code: 'local-durability-uncertain' });
  assert.equal(f.service.snapshot().sync.phase, 'recovery');
  armed = false;
  await f.service.shutdown();
  assert.equal(f.service.snapshot().sync.phase, 'local');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});

test('transient failure after actual rename reconciles to new state rather than older memory', async t => {
  let armed = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    await fs.rename(source, target);
    if (armed && target.endsWith('/local/state.json')) { armed = false; throw Object.assign(Error('interrupted after rename'), { code: 'EIO' }); }
  } } });
  armed = true;
  const result = await f.service.setFound(context(f.service), { id: 42, found: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'local-durability-uncertain');
  assert.equal(result.snapshot.sync.phase, 'local');
  assert.deepEqual(result.snapshot.activeProfile.foundIds, [42]);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});

test('queued initialization cannot switch the migration source directory', async t => {
  const f = await setup(t);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-other-source-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(f.userData, 'found.json'), '{"ids":[42]}');
  await fs.writeFile(path.join(other, 'found.json'), '{"ids":[99]}');
  const first = f.service.initialize({ userData: f.userData });
  const second = f.service.initialize({ userData: other });
  await first;
  assert.equal((await second).sync.code, 'invalid-command');
  await fs.writeFile(path.join(f.root, 'local/state.json'), '{broken');
  const restored = await f.service.restoreLocalBackup(generation(f.service));
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value.activeProfile.foundIds, [42]);
});

test('startup reconciliation captures writer identity after one-shot init failure', async t => {
  const f = await ready(t);
  let failOnce = true;
  const reopened = new ProgressRepository({ root: f.root, fs: { ...fs, mkdir: async (...args) => {
    if (failOnce) { failOnce = false; throw Object.assign(Error('one-shot startup failure'), { code: 'EIO' }); }
    return fs.mkdir(...args);
  } } });
  const service = new ProgressService({ repository: reopened });
  const snapshot = await service.initialize({ userData: f.userData });
  assert.equal(snapshot.sync.phase, 'local');
  const result = await service.setFound(context(service), { id: 42, found: true });
  assert.equal(result.ok, true);
  const durable = await reopened.load(local);
  assert.equal(durable.state.profiles[result.value.activeProfile.id].markers['42'].actor, ACTOR_A);
});

test('restore interrupted after actual rename rotates session and rejects queued old-context edit', async t => {
  let armed = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    await fs.rename(source, target);
    if (armed && target.endsWith('/local/state.json')) {
      armed = false;
      throw Object.assign(Error('restore interrupted after rename'), { code: 'EIO' });
    }
  } } });
  const old = context(f.service);
  await f.service.setFound(old, { id: 42, found: true });
  await f.service.setFound(old, { id: 43, found: true });
  armed = true;
  const restoring = f.service.restoreLocalBackup(generation(f.service));
  const editing = f.service.setFound(old, { id: 43, found: true });
  const restored = await restoring;
  assert.equal(restored.ok, false);
  assert.equal(restored.error.code, 'local-durability-uncertain');
  assert.equal(restored.snapshot.sync.phase, 'local');
  assert.deepEqual(restored.snapshot.activeProfile.foundIds, [42]);
  assert.notEqual(restored.snapshot.sessionGeneration, old.sessionGeneration);
  assert.equal((await editing).error.code, 'stale-context');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  const durable = await f.repository.load(local);
  assert.equal(durable.state.profiles[old.profileId].markers['43'], undefined);
});

test('restore activation survives persistent uncertainty until later durable reconciliation', async t => {
  let armed = false; let restoredRename = false;
  const f = await ready(t, { adapter: { ...fs,
    rename: async (source, target) => { await fs.rename(source, target); if (armed && target.endsWith('/local/state.json')) restoredRename = true; },
    open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (armed && restoredRename && file.endsWith('/local')) return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => { throw Object.assign(Error('persistent restore uncertainty'), { code: 'EIO' }); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      return handle;
    },
  } });
  const old = context(f.service);
  await f.service.setFound(old, { id: 42, found: true });
  await f.service.setFound(old, { id: 43, found: true });
  armed = true;
  const restoring = f.service.restoreLocalBackup(generation(f.service));
  const queuedEdit = f.service.setFound(old, { id: 43, found: true });
  const unresolved = await restoring;
  assert.equal(unresolved.error.code, 'local-durability-uncertain');
  assert.equal(unresolved.snapshot.sync.phase, 'recovery');
  assert.equal((await queuedEdit).error.code, 'local-durability-uncertain');
  armed = false;
  // This rejected request may reconcile durability, but cannot execute its edit.
  const retry = await f.service.setFound(old, { id: 43, found: true });
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'local-durability-uncertain');
  assert.equal(retry.snapshot.sync.phase, 'local');
  assert.deepEqual(retry.snapshot.activeProfile.foundIds, [42]);
  assert.notEqual(retry.snapshot.sessionGeneration, old.sessionGeneration);
  assert.equal((await f.service.setFound(old, { id: 43, found: true })).error.code, 'stale-context');
  const durable = await f.repository.load(local);
  assert.equal(durable.state.profiles[old.profileId].markers['43'], undefined);
});

function localTransfer() {
  return { version: 1, records: [{ provider: 'bwiki', map: 'unsupported-realm', catalog: { generation: 'synthetic', fingerprint: 'opaque' }, record: { id: 'unknown-id', map: 'unsupported-realm', category: null, level: null, state: true, position: null }, mapping: null }], imports: [] };
}

test('service persists, exports, remaps, archives and restores canonical state with local provenance', async t => {
  const f = await ready(t); const ctx = context(f.service); const a = localTransfer();
  await f.service.runProfileTransaction(ctx, { reason: 'import' }, (draft, actor) => {
    setFound(draft, { profileId: ctx.profileId, id: 42, found: true }, actor);
    draft.extensions = { transfer: { version: 1, profiles: { [ctx.profileId]: a } } };
  });
  const saved = await f.repository.load(local);
  assert.equal(saved.state.profiles[ctx.profileId].markers['42'].value, true);
  assert.deepEqual(saved.extensions.transfer.profiles[ctx.profileId], a);
  const exported = await f.service.exportBackup({ ...generation(f.service), profileIds: [ctx.profileId] });
  assert.equal(exported.ok, true); assert.equal(JSON.parse(exported.value).version, 2);
  const imported = await f.service.importBackup({ ...generation(f.service), bytes: Buffer.from(exported.value) });
  assert.equal(imported.ok, true); const importedId = context(f.service).profileId;
  assert.notEqual(importedId, ctx.profileId);
  const after = await f.repository.load(local);
  assert.deepEqual(after.extensions.transfer.profiles[importedId], a);
  const archives = await fs.readdir(path.join(f.root, 'backups'));
  const importArchives = await Promise.all(archives.filter(name => name.startsWith('local-import-')).map(name => fs.readFile(path.join(f.root, 'backups', name), 'utf8')));
  assert.ok(importArchives.some(body => JSON.parse(body).extensions?.transfer.profiles[ctx.profileId]?.records[0].record.id === 'unknown-id'));
  await fs.writeFile(path.join(f.root, 'local/state.json'), '{broken');
  await f.service.initialize({ userData: f.userData });
  assert.equal((await f.service.restoreLocalBackup(generation(f.service))).ok, true);
  const restored = await f.repository.load(local);
  assert.deepEqual(restored.extensions, saved.extensions);
  assert.deepEqual(restored.state, saved.state);
  assert.equal(JSON.stringify(f.service.snapshot()).includes('extensions'), false);
});

test('unknown stored transfer versions require recovery without dropping or rewriting original bytes', async t => {
  const f = await ready(t); const file = path.join(f.root, 'local/state.json');
  const value = await f.repository.load(local); value.extensions = { transfer: { version: 2, profiles: {} } };
  const original = JSON.stringify(value); await fs.writeFile(file, original);
  const snapshot = await f.service.initialize({ userData: f.userData });
  assert.equal(snapshot.sync.phase, 'recovery'); assert.equal(snapshot.sync.code, 'unsupported-version');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('directory-sync uncertainty reconciles canonical state and attachment as the same new file', async t => {
  let armed = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    await fs.rename(source, target);
    if (armed && target.endsWith('/local/state.json')) { armed = false; throw Object.assign(Error('interrupted after rename'), { code: 'EIO' }); }
  } } });
  const ctx = context(f.service); armed = true;
  await assert.rejects(f.service.runProfileTransaction(ctx, { reason: 'edit' }, (draft, actor) => {
    setFound(draft, { profileId: ctx.profileId, id: 42, found: true }, actor);
    draft.extensions = { transfer: { version: 1, profiles: { [ctx.profileId]: localTransfer() } } };
  }), { code: 'local-durability-uncertain' });
  const durable = await f.repository.load(local);
  assert.equal(durable.state.profiles[ctx.profileId].markers['42'].value, true);
  assert.equal(durable.extensions.transfer.profiles[ctx.profileId].records[0].record.id, 'unknown-id');
  assert.equal(f.service.envelope.extensions.transfer.profiles[ctx.profileId].records[0].record.id, 'unknown-id');
});

test('local filesystem reads accept 128 MiB and reject one over without rewriting data', async t => {
  const f = await ready(t); const file = path.join(f.root, 'local/state.json'); const value = await f.repository.load(local);
  const limit = 128 * 1024 * 1024; const body = Buffer.alloc(limit, 32); Buffer.from(JSON.stringify(value)).copy(body);
  await fs.writeFile(file, body);
  assert.deepEqual((await f.repository.load(local)).state, value.state);
  await fs.appendFile(file, ' ');
  await assert.rejects(f.repository.load(local), { code: 'local-recovery-required' });
  assert.equal((await fs.stat(file)).size, limit + 1);
});

test('invalid local attachment edits fail before publication and preserve canonical state', async t => {
  const f = await ready(t); const ctx = context(f.service); const before = await f.repository.load(local); const viewVersion = f.service.snapshot().viewVersion;
  await assert.rejects(f.service.runProfileTransaction(ctx, { reason: 'edit' }, (draft, actor) => {
    setFound(draft, { profileId: ctx.profileId, id: 42, found: true }, actor);
    const a = localTransfer(); a.records[0].record.state = 1;
    draft.extensions = { transfer: { version: 1, profiles: { [ctx.profileId]: a } } };
  }), { code: 'invalid-envelope' });
  assert.deepEqual(await f.repository.load(local), before);
  assert.equal(f.service.snapshot().viewVersion, viewVersion);
});


test('main-only transfer read is detached, queued, validated and obeys context/recovery/closing', async t => {
  const f = await ready(t); const ctx = context(f.service);
  const editing = f.service.setFound(ctx, { id: 42, found: true });
  const reading = f.service.readTransferState(ctx); await editing; const read = await reading;
  assert.equal(read.envelope.state.profiles[ctx.profileId].markers['42'].value, true);
  assert.deepEqual(read.profile, read.envelope.state.profiles[ctx.profileId]); read.profile.markers['42'].value = false;
  assert.equal((await f.service.readTransferState(ctx)).profile.markers['42'].value, true);
  await assert.rejects(f.service.readTransferState({ ...ctx, sessionGeneration: 'old' }), { code: 'stale-context' });
  await fs.writeFile(path.join(f.root, 'local/state.json'), '{broken'); await f.service.initialize({ userData: f.userData });
  await assert.rejects(f.service.readTransferState(context(f.service)), { code: 'local-recovery-required' });
  await f.service.shutdown(); await assert.rejects(f.service.readTransferState(context(f.service)), { code: 'service-closed' });
});

test('publication gate surrounds backup/persistence/snapshot and only notifies canonical commits after release', async t => {
  const events = [];
  const f = await ready(t, { onSnapshot: () => events.push('snapshot'), publicationGate: { pause: async () => { events.push('pause'); return () => events.push('release'); }, notifyCommitted: () => events.push('notify') } });
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { events.push('backup'); return backup(...args); };
  const transact = f.repository.transact.bind(f.repository); f.repository.transact = async (...args) => { const after = await transact(...args); events.push('persist'); return after; };
  events.length = 0;
  await f.service.runProfileTransaction(context(f.service), { reason: 'import' }, (draft, actor) => setFound(draft, { profileId: context(f.service).profileId, id: 42, found: true }, actor));
  assert.deepEqual(events, ['pause', 'backup', 'persist', 'snapshot', 'release', 'notify']);
  events.length = 0;
  await f.service.runProfileTransaction(context(f.service), { reason: 'import' }, draft => { draft.extensions = { transfer: { version: 1, profiles: {} } }; });
  assert.equal(events.includes('notify'), false);
});

test('invalid import drafts fail aggregate validation before backup is written', async t => {
  const f = await ready(t); const before = await f.repository.load(local); const archives = await fs.readdir(path.join(f.root, 'backups'));
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'import' }, draft => { draft.extensions = { transfer: { version: 1, profiles: { forged: {} } } }; }), { code: 'invalid-envelope' });
  assert.deepEqual(await fs.readdir(path.join(f.root, 'backups')), archives); assert.deepEqual(await f.repository.load(local), before);
});

test('restore holds publication gate through durable restore and activation snapshot', async t => {
  const events = [];
  const f = await ready(t, { onSnapshot: () => events.push('snapshot'), publicationGate: { pause: async () => { events.push('pause'); return () => events.push('release'); }, notifyCommitted: () => events.push('notify') } });
  await f.service.setFound(context(f.service), { id: 42, found: true }); await f.service.setFound(context(f.service), { id: 43, found: true });
  const restore = f.repository.restoreLastGood.bind(f.repository); f.repository.restoreLastGood = async (...args) => { const after = await restore(...args); events.push('restore'); return after; };
  events.length = 0;
  assert.equal((await f.service.restoreLocalBackup(generation(f.service))).ok, true);
  assert.deepEqual(events, ['pause', 'restore', 'snapshot', 'release', 'notify']);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});


test('final main-only guard runs after backup, once, and prevents staged installation', async t => {
  const f = await ready(t); const before = await f.repository.load(local); let prepared = 0; let guarded = 0; let backedUp = false;
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { await backup(...args); backedUp = true; };
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'import' }, (draft, actor) => {
    prepared++; setFound(draft, { profileId: context(f.service).profileId, id: 42, found: true }, actor);
  }, () => { guarded++; assert.equal(backedUp, true); throw new (require('../../src/progress/schema').ProgressError)('stale-preview'); }), { code: 'stale-preview' });
  assert.equal(prepared, 1); assert.equal(guarded, 1); assert.deepEqual(await f.repository.load(local), before);
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'import' }, () => {}, async () => {}), { code: 'invalid-mutation' });
  assert.deepEqual(await f.repository.load(local), before);
});

test('staged transactions preserve deliberate removal of optional local attachments', async t => {
  const f = await ready(t); const ctx = context(f.service);
  await f.service.runProfileTransaction(ctx, { reason: 'import' }, draft => { draft.extensions = { transfer: { version: 1, profiles: { [ctx.profileId]: localTransfer() } } }; });
  const before = await f.repository.load(local);
  const after = await f.service.runProfileTransaction(ctx, { reason: 'import' }, draft => { delete draft.extensions; });
  assert.equal(Object.hasOwn(after, 'extensions'), false); assert.equal(after.revision, before.revision + 1);
});

test('final guard rejects a base revision changed during backup before staged installation', async t => {
  const f = await ready(t); const ctx = context(f.service); const before = await f.repository.load(local); let guards = 0;
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => {
    await backup(...args); await f.repository.transact(local, draft => setFound(draft, { profileId: ctx.profileId, id: 99, found: true }, ACTOR_A));
  };
  await assert.rejects(f.service.runProfileTransaction(ctx, { reason: 'import', expectedRevision: before.revision }, (draft, actor) => setFound(draft, { profileId: ctx.profileId, id: 42, found: true }, actor), () => { guards++; }), { code: 'revision-conflict' });
  const durable = await f.repository.load(local);
  assert.equal(guards, 0); assert.equal(durable.state.profiles[ctx.profileId].markers['42'], undefined);
  assert.equal(durable.state.profiles[ctx.profileId].markers['99'].value, true);
});

test('raw final guard exceptions are sanitized without leaking private text or changing disk', async t => {
  const f = await ready(t); const before = await f.repository.load(local);
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'import' }, () => {}, () => { throw Error('synthetic-private-error-text'); }), error => error.code === 'local-operation-failed' && error.message === 'local-operation-failed');
  assert.deepEqual(await f.repository.load(local), before);
});
