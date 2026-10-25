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
async function setup(t, { adapter = fs, onSnapshot } = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-service-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const root = path.join(userData, 'progress');
  const repository = new ProgressRepository({ root, uuid: () => ACTOR_A, fs: adapter });
  let sequence = 0;
  const service = new ProgressService({ repository, uuid: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, onSnapshot });
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

test('backup failure wholly prevents import and extension callback execution', async t => {
  let fail = false;
  const f = await ready(t, { adapter: { ...fs, rename: async (source, target) => {
    if (fail && /local-import-/.test(target)) throw Object.assign(Error('backup failed'), { code: 'EIO' });
    return fs.rename(source, target);
  } } });
  const before = await f.repository.load(local);
  const backup = await f.service.exportBackup({ ...generation(f.service), profileIds: [context(f.service).profileId] });
  fail = true;
  assert.equal((await f.service.importBackup({ ...generation(f.service), bytes: Buffer.from(backup.value) })).error.code, 'local-backup-failed');
  let called = false;
  await assert.rejects(f.service.runProfileTransaction(context(f.service), { reason: 'restore' }, () => { called = true; }), { code: 'local-backup-failed' });
  assert.equal(called, false); assert.deepEqual(await f.repository.load(local), before);
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
