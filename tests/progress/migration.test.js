'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { ProgressRepository } = require('../../src/progress/repository');
const { foundIds } = require('../../src/progress/merge');
const { ACTOR_A, PROFILE_A } = require('./helpers');
const { migrateLegacy } = require('../../src/progress/migration');

// Only Electron's app path is replaced; every config and migration IO uses real temp files.
function configFor(userData) {
  const filename = require.resolve('../../src/config');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = name => name === 'electron' ? { app: { getPath: () => userData } } : require(name);
  loaded._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
async function setup(t, options = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-migration-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const root = path.join(userData, 'progress');
  const repository = new ProgressRepository({ root, uuid: () => ACTOR_A, ...options });
  return { userData, root, repository, legacyFile: path.join(userData, 'found.json'), settingsFile: path.join(userData, 'settings.json') };
}
const local = { kind: 'local' };
const selected = envelope => envelope.state.profiles[envelope.selectedProfileId];
const migrate = fixture => migrateLegacy({ ...fixture, uuid: () => PROFILE_A });
async function writeLegacy(fixture, found = '{"ids":[42,42,43]}', settings = '{"enabledTypes":["o6","o5"],"hideFound":true}') {
  await fs.writeFile(fixture.legacyFile, found);
  await fs.writeFile(fixture.settingsFile, settings);
}
async function archives(root) {
  return (await fs.readdir(path.join(root, 'backups'))).filter(name => /^local-migration-/.test(name));
}

test('migration preserves progress preferences and original bytes', async t => {
  const f = await setup(t);
  const original = Buffer.from(' {"ids":[42,42,43]}\r\n');
  const settings = Buffer.from('{"enabledTypes":["o6","o5"],"hideFound":true,"oldToken":"private"}\n');
  await writeLegacy(f, original, settings);
  const after = await migrate(f);
  const profile = selected(after);
  assert.equal(profile.name.value, 'Local progress');
  assert.equal(profile.region.value, '');
  assert.deepEqual(foundIds(profile), [42, 43]);
  assert.deepEqual(profile.enabledTypes.value, ['o5', 'o6']);
  assert.equal(profile.hideFound.value, true);
  assert.equal(profile.name.actor, ACTOR_A);
  assert.equal(after.migrationComplete, true);
  assert.equal(after.revision, 1);
  assert.equal(after.dirtyRevision, 1);
  assert.equal(after.clock, 1);
  assert.deepEqual(await fs.readFile(f.legacyFile), original);
  assert.deepEqual(await fs.readFile(f.settingsFile), settings);
  const names = await archives(f.root);
  assert.equal(names.length, 1);
  const archive = JSON.parse(await fs.readFile(path.join(f.root, 'backups', names[0]), 'utf8'));
  assert.equal(archive.format, 'genshin-map-overlay.legacy-backup');
  assert.deepEqual(Buffer.from(archive.found, 'base64'), original);
  assert.deepEqual(Buffer.from(archive.settings, 'base64'), settings);
});

test('restart cannot duplicate the migrated profile or import later legacy edits', async t => {
  const f = await setup(t);
  await writeLegacy(f);
  const once = await migrate(f);
  await writeLegacy(f, '{"ids":[99]}', 'broken settings');
  const reopened = new ProgressRepository({ root: f.root });
  const twice = await migrateLegacy({ repository: reopened, userData: f.userData, uuid: () => { throw Error('must not create'); }, readFile: async () => { throw Error('must not reread'); } });
  assert.equal(Object.keys(twice.state.profiles).length, 1);
  assert.deepEqual(twice, once);
});

for (const [label, found, settings] of [
  ['missing files', null, null], ['empty progress array and settings object', '{"ids":[]}', '{}'],
]) test(`migration creates defaults for ${label}`, async t => {
  const f = await setup(t);
  if (found !== null) await writeLegacy(f, found, settings);
  const profile = selected(await migrate(f));
  assert.deepEqual(foundIds(profile), []);
  assert.deepEqual(profile.enabledTypes.value, ['o141', 'o194', 'o403', 'o5', 'o508', 'o6', 'o626', 'o694', 'o833']);
  assert.equal(profile.hideFound.value, false);
  assert.equal(profile.region.value, '');
});

for (const ids of ['["42"]', '[0]', '[-1]', '[1.5]', '[9007199254740992]', '[null]', '[true]', '{}']) {
  test(`migration rejects invalid legacy IDs ${ids} without modifying source`, async t => {
    const f = await setup(t);
    const bytes = Buffer.from(`{"ids":${ids}}`);
    await writeLegacy(f, bytes);
    await assert.rejects(migrate(f), { code: 'local-recovery-required' });
    assert.deepEqual(await fs.readFile(f.legacyFile), bytes);
    assert.equal((await f.repository.load(local)).migrationComplete, false);
  });
}
for (const [label, found, settings] of [
  ['empty found file', '', '{}'], ['empty settings file', '{"ids":[]}', ''],
  ['corrupt found', '{', '{}'], ['missing ids', '{}', '{}'],
  ['null found', 'null', '{}'], ['array settings', '{"ids":[]}', '[]'],
  ['null settings', '{"ids":[]}', 'null'], ['corrupt settings', '{"ids":[]}', '{broken'],
  ['nonarray enabledTypes', '{"ids":[]}', '{"enabledTypes":null}'],
  ['invalid type key', '{"ids":[]}', '{"enabledTypes":["o0"]}'],
  ['wrong hideFound type', '{"ids":[]}', '{"hideFound":0}'],
]) test(`migration enters recovery for ${label}`, async t => {
  const f = await setup(t);
  await writeLegacy(f, found, settings);
  await assert.rejects(migrate(f), { code: 'local-recovery-required' });
  assert.equal(await fs.readFile(f.legacyFile, 'utf8'), found);
  assert.equal(await fs.readFile(f.settingsFile, 'utf8'), settings);
  assert.equal((await f.repository.load(local)).migrationComplete, false);
});

test('legacy duplicate enabled types become a sorted set and explicit empty preferences survive', async t => {
  const f = await setup(t);
  await writeLegacy(f, '{"ids":[]}', '{"enabledTypes":["o6","o5","o6"],"hideFound":false}');
  assert.deepEqual(selected(await migrate(f)).enabledTypes.value, ['o5', 'o6']);
  const other = await setup(t);
  await writeLegacy(other, '{"ids":[]}', '{"enabledTypes":[],"hideFound":false}');
  assert.deepEqual(selected(await migrate(other)).enabledTypes.value, []);
});

for (const name of ['found.json', 'settings.json']) test(`only ENOENT is absence: ${name} permission failure enters recovery`, async t => {
  const f = await setup(t);
  await writeLegacy(f);
  await assert.rejects(migrateLegacy({ ...f, readFile: async file => {
    if (path.basename(file) === name) throw Object.assign(Error('private path'), { code: 'EACCES' });
    return fs.readFile(file);
  } }), error => error.code === 'local-recovery-required' && error.message === 'local-recovery-required');
  assert.equal((await f.repository.load(local)).migrationComplete, false);
});

test('concurrent migration calls commit one profile and one archive', async t => {
  const f = await setup(t);
  await writeLegacy(f);
  const [a, b] = await Promise.all([migrate(f), migrate(f)]);
  assert.deepEqual(a, b);
  assert.equal(Object.keys(b.state.profiles).length, 1);
  assert.equal((await archives(f.root)).length, 1);
});

for (const afterRename of [false, true]) test(`interruption ${afterRename ? 'after' : 'before'} durable flag replacement recovers exactly once`, async t => {
  let armed = false;
  const adapter = { ...fs, rename: async (source, target) => {
    if (armed && target.endsWith('/local/state.json')) {
      armed = false;
      if (afterRename) await fs.rename(source, target);
      throw Object.assign(Error('injected interruption'), { code: 'EIO' });
    }
    return fs.rename(source, target);
  } };
  const f = await setup(t, { fs: adapter });
  await writeLegacy(f);
  await f.repository.load(local);
  armed = true;
  await assert.rejects(migrate(f), { code: afterRename ? 'local-durability-uncertain' : 'local-write-failed' });
  const reopened = new ProgressRepository({ root: f.root });
  const onDisk = await reopened.load(local);
  assert.equal(onDisk.migrationComplete, afterRename);
  assert.equal(Object.keys(onDisk.state.profiles).length, afterRename ? 1 : 0);
  const after = await migrateLegacy({ repository: reopened, userData: f.userData, uuid: () => PROFILE_A });
  assert.equal(Object.keys(after.state.profiles).length, 1);
  assert.deepEqual(foundIds(selected(after)), [42, 43]);
  assert.equal(after.migrationComplete, true);
  assert.equal(after.revision, 1);
});

test('raw recovery backup failure prevents migration commit and preserves source bytes', async t => {
  const f = await setup(t, { fs: { ...fs, rename: async (source, target) => {
    if (/local-migration-/.test(target)) throw Object.assign(Error('backup failed'), { code: 'EIO' });
    return fs.rename(source, target);
  } } });
  await writeLegacy(f);
  await assert.rejects(migrate(f), { code: 'local-backup-failed' });
  assert.equal((await f.repository.load(local)).migrationComplete, false);
  assert.equal(await fs.readFile(f.legacyFile, 'utf8'), '{"ids":[42,42,43]}');
});

test('config preservation returns defaults and leaves corrupt settings byte-identical', async t => {
  const f = await setup(t);
  const original = Buffer.from('{broken\r\n\xff', 'latin1');
  await fs.writeFile(f.settingsFile, original);
  const config = configFor(f.userData);
  const cfg = config.load({ preserveMalformed: true });
  assert.equal(cfg.hideFound, false);
  assert.equal(cfg.active, true);
  assert.deepEqual(await fs.readFile(f.settingsFile), original);
  assert.deepEqual([...config.DEFAULT_PROFILE_PREFERENCES.enabledTypes].sort(), [...cfg.enabledTypes].sort());
  await assert.rejects(migrate(f), { code: 'local-recovery-required' });
  assert.deepEqual(await fs.readFile(f.settingsFile), original);
});

test('config preservation avoids writes for unreadable settings and normal load keeps existing fallback', async t => {
  const f = await setup(t);
  await fs.mkdir(f.settingsFile);
  const config = configFor(f.userData);
  assert.equal(config.load({ preserveMalformed: true }).hideFound, false);
  assert.equal((await fs.stat(f.settingsFile)).isDirectory(), true);
  await fs.rmdir(f.settingsFile);
  assert.equal(config.load().hideFound, false);
  assert.equal(await fs.readFile(f.settingsFile, 'utf8'), '{}');
});


test('repository preserves a bounded raw archive through its public queued API', async t => {
  const f = await setup(t);
  const found = Buffer.from('source bytes');
  const settings = Buffer.from('raw settings');
  const saving = f.repository.preserveLegacyBackup({ found, settings });
  found.fill(0);
  settings.fill(0);
  await saving;
  const names = await archives(f.root);
  const archive = JSON.parse(await fs.readFile(path.join(f.root, 'backups', names[0]), 'utf8'));
  assert.deepEqual(archive, {
    format: 'genshin-map-overlay.legacy-backup', version: 1,
    found: Buffer.from('source bytes').toString('base64'), settings: Buffer.from('raw settings').toString('base64'),
  });
  await assert.rejects(f.repository.preserveLegacyBackup({ found: 'not bytes', settings: null }), { code: 'invalid-legacy-backup' });
  await assert.rejects(f.repository.preserveLegacyBackup({ found: Buffer.alloc(4 * 1024 * 1024 + 1), settings: null }), { code: 'limit-exceeded' });
  assert.equal((await archives(f.root)).length, 1);
});

for (const name of ['found.json', 'settings.json']) test(`oversized ${name} enters recovery before parsing`, async t => {
  const f = await setup(t);
  await writeLegacy(f);
  const json = name === 'found.json' ? '{"ids":[]}' : '{}';
  await fs.writeFile(path.join(f.userData, name), json.padEnd(4 * 1024 * 1024 + 1, ' '));
  await assert.rejects(migrate(f), { code: 'local-recovery-required' });
  assert.equal((await fs.stat(path.join(f.userData, name))).size, 4 * 1024 * 1024 + 1);
  assert.equal((await f.repository.load(local)).migrationComplete, false);
  assert.equal((await archives(f.root)).length, 0);
});

test('raw legacy archives share the ten-backup retention bound', async t => {
  const f = await setup(t);
  for (let i = 0; i < 11; i++) await f.repository.preserveLegacyBackup({ found: Buffer.from(String(i)), settings: null });
  const names = await archives(f.root);
  assert.equal(names.length, 10);
  const backups = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(f.root, 'backups', name), 'utf8'))));
  assert.equal(backups.some(item => item.found === Buffer.from('10').toString('base64')), true);
});

test('raw backup pruning failure leaves migration incomplete and original files untouched', async t => {
  let failPrune = false;
  const f = await setup(t, { fs: { ...fs, unlink: async file => {
    if (failPrune && /local-migration-.*\.json$/.test(file)) throw Object.assign(Error('cannot prune'), { code: 'EACCES' });
    return fs.unlink(file);
  } } });
  await f.repository.load(local);
  for (let i = 0; i < 10; i++) await f.repository.preserveLegacyBackup({ found: Buffer.from(String(i)), settings: null });
  await writeLegacy(f);
  failPrune = true;
  await assert.rejects(migrate(f), { code: 'local-backup-failed' });
  assert.equal((await f.repository.load(local)).migrationComplete, false);
  assert.equal(await fs.readFile(f.legacyFile, 'utf8'), '{"ids":[42,42,43]}');
  assert.equal((await archives(f.root)).length, 11);
});
