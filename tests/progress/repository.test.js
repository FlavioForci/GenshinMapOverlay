'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProgressRepository } = require('../../src/progress/repository');
const { atomicWriteFile, syncDirectory } = require('../../src/progress/atomic-file');
const { LIMITS } = require('../../src/progress/schema');
const { foundIds } = require('../../src/progress/merge');
const { ACTOR_A, PROFILE_A, makeState } = require('./helpers');

const scope = { kind: 'local' };
async function fixture(t, injectedFs = fs, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmo-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = new ProgressRepository({ root, fs: injectedFs, uuid: () => ACTOR_A, ...options });
  await repo.init();
  return { root, repo, stateFile: path.join(root, 'local/state.json'), lastGood: path.join(root, 'local/state.last-good.json') };
}
async function seed(repo) {
  return repo.transact(scope, draft => {
    draft.state = makeState();
    draft.clock = 1;
    draft.selectedProfileId = PROFILE_A;
    draft.migrationComplete = true;
  });
}
function mark(id) {
  return draft => {
    draft.clock += 1;
    draft.state.profiles[PROFILE_A].markers[id] = { value: true, clock: draft.clock, actor: ACTOR_A };
  };
}
function reopen(root) { return new ProgressRepository({ root }); }
function ioError(code = 'EIO') { return Object.assign(new Error('injected private disk error'), { code }); }

// Delegate every real filesystem operation, interrupting only the selected boundary.
function failures(point, { persistent = false, code = 'EIO' } = {}) {
  let armed = false;
  function hit(candidate) {
    if (!armed || candidate !== point) return;
    if (!persistent) armed = false;
    throw ioError(code);
  }
  const wrapped = Object.create(fs);
  wrapped.rename = async (source, destination) => {
    if (destination.endsWith('/local/state.json')) hit('before-final-rename');
    await fs.rename(source, destination);
    if (destination.endsWith('/local/state.last-good.json')) hit('after-backup-replace');
    if (destination.endsWith('/local/state.json')) hit('after-final-rename');
  };
  wrapped.unlink = async file => {
    if (file.includes('/backups/') && file.endsWith('.json')) hit('prune');
    return fs.unlink(file);
  };
  wrapped.open = async (file, ...args) => {
    if (String(file).includes('/backups/')) hit('backup-open');
    const handle = await fs.open(file, ...args);
    const isPrimaryTemp = path.basename(String(file)).startsWith('.state.json.') && String(file).endsWith('.tmp');
    const isLocalDirectory = path.basename(String(file)) === 'local';
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') return async (...values) => {
        await target.writeFile(...values);
        if (isPrimaryTemp) hit('after-temp-write');
      };
      if (key === 'sync') return async () => {
        if (isLocalDirectory) hit('directory-sync');
        await target.sync();
        if (isPrimaryTemp) hit('after-temp-sync');
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return { fs: wrapped, arm: () => { armed = true; }, disarm: () => { armed = false; } };
}

test('installation identity and empty local state survive restart', async t => {
  const { root, repo, stateFile } = await fixture(t);
  assert.deepEqual(await repo.init(), { writerId: ACTOR_A, activeScope: scope });
  const envelope = await repo.load(scope);
  assert.equal(envelope.revision, 0);
  assert.equal(envelope.migrationComplete, false);
  assert.deepEqual(envelope.state.profiles, {});
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), envelope);
  assert.deepEqual(await reopen(root).init(), { writerId: ACTOR_A, activeScope: scope });
  assert.deepEqual(await reopen(root).load(scope), envelope);
});

test('queued independent edits survive restart and flush drains them', async t => {
  const { root, repo } = await fixture(t);
  await seed(repo);
  const first = repo.transact(scope, mark(42));
  const second = repo.transact(scope, mark(43));
  const loaded = repo.load(scope);
  await repo.flush();
  await Promise.all([first, second]);
  const after = await loaded;
  assert.equal(after.revision, 3);
  assert.equal(after.dirtyRevision, 3);
  assert.deepEqual(foundIds(after.state.profiles[PROFILE_A]), [42, 43]);
  assert.deepEqual(await reopen(root).load(scope), after);
});

test('no-op transactions and detached snapshots cannot change persisted revisions', async t => {
  const { repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  const original = await fs.readFile(stateFile);
  const snapshot = await repo.load(scope);
  snapshot.state.profiles[PROFILE_A].name.value = 'Uncommitted';
  assert.deepEqual(await repo.transact(scope, () => {}), before);
  assert.deepEqual(await fs.readFile(stateFile), original);
  assert.deepEqual(await repo.load(scope), before);
});

test('selection-only edits advance revision without dirtying canonical progress', async t => {
  const { repo } = await fixture(t);
  await seed(repo);
  const result = await repo.transact(scope, draft => { draft.selectedProfileId = null; });
  assert.equal(result.revision, 2);
  assert.equal(result.dirtyRevision, 1);
});

for (const point of ['after-temp-write', 'after-temp-sync', 'after-backup-replace', 'before-final-rename']) {
  test(`${point} preserves the committed save and subsequent queue operations`, async t => {
    const failure = failures(point);
    const { root, repo, stateFile } = await fixture(t, failure.fs);
    const before = await seed(repo);
    const original = await fs.readFile(stateFile);
    failure.arm();
    await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-write-failed' });
    assert.deepEqual(await fs.readFile(stateFile), original);
    assert.deepEqual(await repo.load(scope), before);
    assert.deepEqual(await reopen(root).load(scope), before);
    await repo.transact(scope, mark(43));
    assert.deepEqual(foundIds((await repo.load(scope)).state.profiles[PROFILE_A]), [43]);
    await repo.flush();
  });
}

test('interruption after final rename exposes complete new state with an uncertain-durability error', async t => {
  const failure = failures('after-final-rename');
  const { root, repo } = await fixture(t, failure.fs);
  await seed(repo);
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-durability-uncertain' });
  const disk = await reopen(root).load(scope);
  assert.deepEqual(foundIds(disk.state.profiles[PROFILE_A]), [42]);
  assert.deepEqual(await repo.load(scope), disk);
});

test('directory sync failure never reports the older save as durably authoritative', async t => {
  const failure = failures('directory-sync', { persistent: true });
  const { root, repo } = await fixture(t, failure.fs);
  await seed(repo);
  // Fail only the primary directory sync, after the backup has already been replaced.
  // The first directory sync belongs to last-good; allow that one through.
  let count = 0;
  const originalOpen = failure.fs.open;
  failure.fs.open = async (file, ...args) => {
    if (String(file).endsWith('/local') && ++count === 1) return fs.open(file, ...args);
    return originalOpen(file, ...args);
  };
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-durability-uncertain' });
  await assert.rejects(repo.load(scope), { code: 'local-durability-uncertain' });
  assert.deepEqual(foundIds((await reopen(root).load(scope)).state.profiles[PROFILE_A]), [42]);
  failure.disarm();
  assert.deepEqual(foundIds((await repo.load(scope)).state.profiles[PROFILE_A]), [42]);
});

test('narrow unsupported directory-sync codes permit a completed atomic write', async t => {
  const failure = failures('directory-sync', { persistent: true, code: 'ENOTSUP' });
  const { repo } = await fixture(t, failure.fs);
  await seed(repo);
  failure.arm();
  await repo.transact(scope, mark(42));
  assert.deepEqual(foundIds((await repo.load(scope)).state.profiles[PROFILE_A]), [42]);
});

test('invalid drafts fail validation before any primary or last-good replacement', async t => {
  const { repo, stateFile, lastGood } = await fixture(t);
  await seed(repo);
  const original = await fs.readFile(stateFile);
  const backup = await fs.readFile(lastGood);
  await assert.rejects(repo.transact(scope, draft => { draft.sync = { secret: true }; }), { code: 'invalid-envelope' });
  await assert.rejects(repo.transact(scope, draft => { draft.state.profiles[PROFILE_A].name.value = ''; }), { code: 'invalid-state' });
  assert.deepEqual(await fs.readFile(stateFile), original);
  assert.deepEqual(await fs.readFile(lastGood), backup);
});

test('revision exhaustion leaves the committed state intact and no-op is still allowed', async t => {
  const { repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  before.revision = Number.MAX_SAFE_INTEGER;
  before.dirtyRevision = Number.MAX_SAFE_INTEGER;
  await fs.writeFile(stateFile, JSON.stringify(before));
  assert.deepEqual(await repo.transact(scope, () => {}), before);
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'revision-exhausted' });
  assert.deepEqual(await repo.load(scope), before);
});

test('corruption requires explicit recovery and preserves original bytes', async t => {
  const { root, repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  await repo.transact(scope, mark(42));
  const corruptOriginal = Buffer.from('{private corrupt \u0000 bytes');
  await fs.writeFile(stateFile, corruptOriginal);
  await assert.rejects(repo.load(scope), { code: 'local-recovery-required' });
  await assert.rejects(repo.transact(scope, mark(43)), { code: 'local-recovery-required' });
  assert.deepEqual(await fs.readFile(stateFile), corruptOriginal);
  const recovered = await repo.restoreLastGood(scope);
  assert.deepEqual(recovered, before);
  assert.deepEqual(await reopen(root).load(scope), before);
  const preserved = await Promise.all((await fs.readdir(path.join(root, 'backups'))).map(name => fs.readFile(path.join(root, 'backups', name))));
  assert.ok(preserved.some(bytes => bytes.equals(corruptOriginal)));
});

test('missing primary with a last-good file requires explicit recovery', async t => {
  const { repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  await repo.transact(scope, mark(42));
  await fs.unlink(stateFile);
  await assert.rejects(repo.load(scope), { code: 'local-recovery-required' });
  assert.deepEqual(await repo.restoreLastGood(scope), before);
});

test('newer envelopes and oversized primary bytes remain untouched', async t => {
  const { repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  const newer = Buffer.from(JSON.stringify({ ...before, version: 2 }));
  await fs.writeFile(stateFile, newer);
  await assert.rejects(repo.load(scope), { code: 'unsupported-version' });
  assert.deepEqual(await fs.readFile(stateFile), newer);
  const oversized = Buffer.alloc(LIMITS.LOCAL_ENVELOPE_BYTES + 1, 32);
  await fs.writeFile(stateFile, oversized);
  await assert.rejects(repo.load(scope), { code: 'local-recovery-required' });
  assert.deepEqual(await fs.readFile(stateFile), oversized);
});

for (const identity of ['{broken', JSON.stringify({ version: 1, writerId: '../bad', activeScope: scope }), JSON.stringify({ version: 1, writerId: ACTOR_A, activeScope: scope, unexpected: true })]) {
  test(`malformed installation identity is not overwritten (${identity.slice(0, 18)})`, async t => {
    const { root } = await fixture(t);
    const file = path.join(root, 'installation.json');
    await fs.writeFile(file, identity);
    await assert.rejects(reopen(root).init(), { code: 'local-recovery-required' });
    assert.equal(await fs.readFile(file, 'utf8'), identity);
  });
}

test('account path traversal is rejected and valid account scopes remain unsupported', async t => {
  const { repo } = await fixture(t);
  for (const accountKey of ['../escape', 'A'.repeat(64), 'a'.repeat(63), '/tmp/state', '__proto__']) {
    await assert.rejects(repo.load({ kind: 'account', accountKey }), { code: 'invalid-scope' });
  }
  await assert.rejects(repo.load({ kind: 'account', accountKey: 'a'.repeat(64) }), { code: 'unsupported-scope' });
  await assert.rejects(repo.load({ kind: 'local', accountKey: 'a'.repeat(64) }), { code: 'invalid-scope' });
});

test('backups contain validated envelopes, remain bounded, and preserve latest snapshot', async t => {
  const { root, repo } = await fixture(t);
  await seed(repo);
  for (let id = 1; id <= 12; id++) {
    await repo.backup(scope, id % 2 ? 'migration' : 'import');
    await repo.transact(scope, mark(id));
  }
  const names = await fs.readdir(path.join(root, 'backups'));
  assert.equal(names.length, 10);
  const snapshots = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(root, 'backups', name), 'utf8'))));
  assert.ok(snapshots.some(value => value.revision === 12));
  assert.ok(snapshots.every(value => value.version === 1 && value.revision >= 3));
  await assert.rejects(repo.backup(scope, '../escape'), { code: 'invalid-backup-reason' });
});

test('backup failure leaves current state intact', async t => {
  const failure = failures('backup-open');
  const { repo } = await fixture(t, failure.fs);
  const before = await seed(repo);
  failure.arm();
  await assert.rejects(repo.backup(scope, 'import'), { code: 'local-backup-failed' });
  assert.deepEqual(await repo.load(scope), before);
});

test('pruning failure is reported without removing the just-written backup', async t => {
  const failure = failures('prune');
  const { root, repo } = await fixture(t, failure.fs);
  await seed(repo);
  for (let i = 0; i < 10; i++) await repo.backup(scope, 'import');
  await repo.transact(scope, mark(42));
  failure.arm();
  await assert.rejects(repo.backup(scope, 'import'), { code: 'local-backup-failed' });
  const snapshots = await Promise.all((await fs.readdir(path.join(root, 'backups'))).map(async name => JSON.parse(await fs.readFile(path.join(root, 'backups', name), 'utf8'))));
  assert.ok(snapshots.some(value => value.revision === 2));
  assert.deepEqual(foundIds((await repo.load(scope)).state.profiles[PROFILE_A]), [42]);
});

test('failed recovery preserves corrupt primary and validated last-good bytes', async t => {
  const failure = failures('before-final-rename');
  const { root, repo, stateFile, lastGood } = await fixture(t, failure.fs);
  await seed(repo);
  await repo.transact(scope, mark(42));
  const good = await fs.readFile(lastGood);
  const corrupt = Buffer.from('corrupt original');
  await fs.writeFile(stateFile, corrupt);
  failure.arm();
  await assert.rejects(repo.restoreLastGood(scope), { code: 'local-write-failed' });
  assert.deepEqual(await fs.readFile(stateFile), corrupt);
  assert.deepEqual(await fs.readFile(lastGood), good);
  const copies = await Promise.all((await fs.readdir(path.join(root, 'backups'))).map(name => fs.readFile(path.join(root, 'backups', name))));
  assert.ok(copies.some(bytes => bytes.equals(corrupt)));
});

test('recovery never replaces primary when preservation fails or last-good is corrupt', async t => {
  const failure = failures('backup-open');
  const { repo, stateFile, lastGood } = await fixture(t, failure.fs);
  await seed(repo);
  const corrupt = Buffer.from('bad primary');
  await fs.writeFile(stateFile, corrupt);
  const backup = await fs.readFile(lastGood);
  failure.arm();
  await assert.rejects(repo.restoreLastGood(scope), { code: 'local-backup-failed' });
  assert.deepEqual(await fs.readFile(stateFile), corrupt);
  assert.deepEqual(await fs.readFile(lastGood), backup);
  await fs.writeFile(lastGood, 'bad last-good');
  await assert.rejects(repo.restoreLastGood(scope), { code: 'local-recovery-required' });
  assert.deepEqual(await fs.readFile(stateFile), corrupt);
});

test('atomic size rejection and backup failure preserve an existing destination', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmo-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'save.json');
  await fs.writeFile(file, 'old');
  await assert.rejects(atomicWriteFile(file, Buffer.from('too long'), { maxBytes: 3 }), { code: 'limit-exceeded' });
  await assert.rejects(atomicWriteFile(file, Buffer.from('new'), { maxBytes: 3, backupFile: path.join(root, 'missing/backup.json') }), { code: 'local-write-failed' });
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(root), ['save.json']);
});

test('missing preservation directory cannot be mistaken for a missing corrupt original', async t => {
  const { root, repo, stateFile, lastGood } = await fixture(t);
  await seed(repo);
  const corrupt = Buffer.from('original must survive missing backup directory');
  const good = await fs.readFile(lastGood);
  await fs.writeFile(stateFile, corrupt);
  await fs.rmdir(path.join(root, 'backups'));
  await assert.rejects(repo.restoreLastGood(scope), { code: 'local-backup-failed' });
  assert.deepEqual(await fs.readFile(stateFile), corrupt);
  assert.deepEqual(await fs.readFile(lastGood), good);
});

test('persistent uncertain durability blocks writes and flush until directory sync succeeds', async t => {
  const failure = failures('directory-sync', { persistent: true });
  const { repo } = await fixture(t, failure.fs);
  await seed(repo);
  let directories = 0;
  const originalOpen = failure.fs.open;
  failure.fs.open = async (file, ...args) => {
    if (String(file).endsWith('/local') && ++directories === 1) return fs.open(file, ...args);
    return originalOpen(file, ...args);
  };
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-durability-uncertain' });
  let mutated = false;
  await assert.rejects(repo.transact(scope, () => { mutated = true; }), { code: 'local-durability-uncertain' });
  assert.equal(mutated, false);
  await assert.rejects(repo.flush(), { code: 'local-durability-uncertain' });
  failure.disarm();
  await repo.flush();
  assert.deepEqual(foundIds((await repo.load(scope)).state.profiles[PROFILE_A]), [42]);
});

test('ENOSPC during temporary write never damages existing primary or last-good', async t => {
  const failure = failures('after-temp-write', { code: 'ENOSPC' });
  const { repo, stateFile, lastGood } = await fixture(t, failure.fs);
  const before = await seed(repo);
  const primary = await fs.readFile(stateFile);
  const backup = await fs.readFile(lastGood);
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-write-failed' });
  assert.deepEqual(await fs.readFile(stateFile), primary);
  assert.deepEqual(await fs.readFile(lastGood), backup);
  assert.deepEqual(await repo.load(scope), before);
});

test('oversized proposed envelope is rejected before replacing any committed file', async t => {
  const { repo, stateFile, lastGood } = await fixture(t);
  const before = await seed(repo);
  const primary = await fs.readFile(stateFile);
  const backup = await fs.readFile(lastGood);
  await assert.rejects(repo.transact(scope, draft => {
    const records = Array.from({ length: 120000 }, (_, i) => ({ provider: 'bwiki', map: 'other', catalog: { generation: 'old', fingerprint: 'opaque' }, record: { id: String(i), map: 'other', category: '🐉'.repeat(128), level: '🐉'.repeat(128), state: true, position: null }, mapping: null }));
    draft.extensions = { transfer: { version: 1, profiles: { [PROFILE_A]: { version: 1, records, imports: [] } } } };
  }), { code: 'limit-exceeded' });
  assert.deepEqual(await fs.readFile(stateFile), primary);
  assert.deepEqual(await fs.readFile(lastGood), backup);
  assert.deepEqual(await repo.load(scope), before);
});

test('malformed dirty revision cannot be normalized into a valid canonical write', async t => {
  const { repo, stateFile } = await fixture(t);
  const before = await seed(repo);
  const bytes = await fs.readFile(stateFile);
  await assert.rejects(repo.transact(scope, draft => {
    mark(42)(draft);
    draft.dirtyRevision = -1;
  }), { code: 'invalid-envelope' });
  assert.deepEqual(await fs.readFile(stateFile), bytes);
  assert.deepEqual(await repo.load(scope), before);
});

test('missing primary and last-good beside recovery archives cannot silently create empty progress', async t => {
  const { repo, stateFile, lastGood } = await fixture(t);
  await seed(repo);
  await repo.backup(scope, 'import');
  await fs.unlink(stateFile);
  await fs.unlink(lastGood);
  await assert.rejects(repo.load(scope), { code: 'local-recovery-required' });
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' });
});

for (const platform of ['darwin', 'linux']) {
  for (const code of ['EIO', 'EACCES', 'EPERM']) {
    test(`${platform} directory-sync ${code} is never classified as unsupported`, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmo-directory-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const wrapped = Object.create(fs);
      wrapped.open = async (...args) => {
        if (code !== 'EIO') throw ioError(code);
        const handle = await fs.open(...args);
        return new Proxy(handle, { get(target, key) {
          if (key === 'sync') return async () => { throw ioError(code); };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      await assert.rejects(syncDirectory(root, wrapped, platform), { code });
    });
  }
}

test('Windows repository skips unsupported directory syncing while committing complete files', async t => {
  const wrapped = Object.create(fs);
  wrapped.open = async (file, ...args) => {
    const stat = await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && stat.isDirectory()) throw ioError('EPERM');
    return fs.open(file, ...args);
  };
  const { root, repo } = await fixture(t, wrapped, { platform: 'win32' });
  await seed(repo);
  await repo.transact(scope, mark(42));
  await repo.backup(scope, 'import');
  await repo.flush();
  assert.deepEqual(foundIds((await reopen(root).load(scope)).state.profiles[PROFILE_A]), [42]);
});

test('Windows still propagates file-data sync failure and preserves the committed file', async t => {
  const failure = failures('after-temp-sync');
  const { repo, stateFile } = await fixture(t, failure.fs, { platform: 'win32' });
  const before = await seed(repo);
  const bytes = await fs.readFile(stateFile);
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-write-failed' });
  assert.deepEqual(await fs.readFile(stateFile), bytes);
  assert.deepEqual(await repo.load(scope), before);
});

test('recovery pruning failure preserves both primary and last-good before replacement', async t => {
  const failure = failures('prune');
  const { root, repo, stateFile, lastGood } = await fixture(t, failure.fs);
  await seed(repo);
  await repo.transact(scope, mark(42));
  for (let i = 0; i < 10; i++) await repo.backup(scope, 'import');
  const corrupt = Buffer.from('corrupt primary retained when recovery pruning fails');
  const good = await fs.readFile(lastGood);
  await fs.writeFile(stateFile, corrupt);
  failure.arm();
  await assert.rejects(repo.restoreLastGood(scope), { code: 'local-backup-failed' });
  assert.deepEqual(await fs.readFile(stateFile), corrupt);
  assert.deepEqual(await fs.readFile(lastGood), good);
  const originals = await Promise.all((await fs.readdir(path.join(root, 'backups')))
    .map(name => fs.readFile(path.join(root, 'backups', name))));
  assert.ok(originals.some(bytes => bytes.equals(corrupt)));
});

test('reopened repository retries local-directory durability before reads, mutations and flush', async t => {
  const failure = failures('directory-sync', { persistent: true });
  const { root, repo } = await fixture(t, failure.fs);
  await seed(repo);
  let attempts = 0;
  const originalOpen = failure.fs.open;
  failure.fs.open = async (file, ...args) => {
    if (String(file).endsWith('/local') && ++attempts === 1) return fs.open(file, ...args);
    return originalOpen(file, ...args);
  };
  failure.arm();
  await assert.rejects(repo.transact(scope, mark(42)), { code: 'local-durability-uncertain' });
  const reopened = new ProgressRepository({ root, fs: failure.fs });
  await assert.rejects(reopened.load(scope), { code: 'local-durability-uncertain' });
  let mutated = false;
  await assert.rejects(reopened.transact(scope, () => { mutated = true; }), { code: 'local-durability-uncertain' });
  assert.equal(mutated, false);
  await assert.rejects(reopened.flush(), { code: 'local-durability-uncertain' });
  failure.disarm();
  await reopened.flush();
  assert.deepEqual(foundIds((await reopened.load(scope)).state.profiles[PROFILE_A]), [42]);
});
