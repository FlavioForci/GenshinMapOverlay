'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createProgressRuntime } = require('../../src/progress/runtime');
const { ProgressRepository } = require('../../src/progress/repository');
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-runtime-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function configFor(userData) {
  const filename = require.resolve('../../src/config'); const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths;
  loaded.require = name => name === 'electron' ? { app: { getPath: () => userData } } : require(name);
  loaded._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}

test('preserving config read precedes repository/migration, initial snapshot and caller window initialization', async t => {
  const userData = await directory(t); const steps = []; const settings = configFor(userData);
  await fs.writeFile(path.join(userData, 'settings.json'), '{"enabledTypes":["o999"],"hideFound":true}');
  await fs.writeFile(path.join(userData, 'found.json'), '{"ids":[42]}');
  const runtime = await createProgressRuntime({ app: { getPath: name => { assert.equal(name, 'userData'); return userData; } }, log: () => {}, loadConfig: options => { assert.deepEqual(options, { preserveMalformed: true }); steps.push('config'); return settings.load(options); }, createRepository: options => { assert.deepEqual(options, { root: path.join(userData, 'progress') }); steps.push('repository'); return new ProgressRepository(options); }, onSnapshot: snapshot => { assert.deepEqual(snapshot.activeProfile.foundIds, [42]); steps.push('snapshot'); } });
  steps.push('window');
  assert.deepEqual(steps, ['config', 'repository', 'snapshot', 'window']);
  assert.deepEqual(runtime.service.snapshot().activeProfile.enabledTypes, ['o999']);
  await runtime.shutdown();
});

test('runtime preserves malformed config bytes, returns recovery and retries captured userData non-destructively', async t => {
  const userData = await directory(t); const settings = configFor(userData); const original = Buffer.from('{broken settings');
  await fs.writeFile(path.join(userData, 'settings.json'), original);
  let ownedPath = userData;
  const runtime = await createProgressRuntime({ app: { getPath: () => ownedPath }, loadConfig: options => settings.load(options), log: () => {}, onSnapshot: () => {} });
  assert.equal(runtime.service.snapshot().sync.phase, 'recovery');
  assert.deepEqual(await fs.readFile(path.join(userData, 'settings.json')), original);
  await fs.writeFile(path.join(userData, 'settings.json'), '{}');
  ownedPath = path.join(userData, 'wrong-new-userData');
  const retried = await runtime.retryLocal();
  assert.equal(retried.sync.phase, 'local');
  assert.equal(retried.profiles.length, 1);
  await runtime.service.setFound({ sessionGeneration: retried.sessionGeneration, profileId: retried.activeProfile.id }, { id: 55, found: true });
  const again = await runtime.retryLocal();
  assert.deepEqual(again.activeProfile.foundIds, [55]);
  assert.equal(again.profiles.length, 1);
  await assert.rejects(fs.stat(ownedPath), { code: 'ENOENT' });
  await runtime.shutdown();
});

test('shutdown drains accepted work, remains idempotent and closes service mutation entry points', async t => {
  const userData = await directory(t);
  const runtime = await createProgressRuntime({ app: { getPath: () => userData }, loadConfig: () => ({}), log: () => {}, onSnapshot: () => {} });
  const initial = runtime.service.snapshot(); const context = { sessionGeneration: initial.sessionGeneration, profileId: initial.activeProfile.id };
  const edit = runtime.service.setFound(context, { id: 99, found: true });
  await Promise.all([runtime.shutdown(), runtime.shutdown(), edit]);
  const repository = new ProgressRepository({ root: path.join(userData, 'progress') });
  assert.equal((await repository.load({ kind: 'local' })).state.profiles[context.profileId].markers['99'].value, true);
  assert.equal((await runtime.service.setFound(context, { id: 100, found: true })).error.code, 'service-closed');
});

test('requiring runtime and initializing with injected config does not load Electron', async t => {
  const userData = await directory(t);
  assert.equal(Object.keys(require.cache).some(file => file.endsWith('/node_modules/electron/index.js')), false);
  const runtime = await createProgressRuntime({ app: { getPath: () => userData }, loadConfig: () => ({}), onSnapshot: () => {}, log: () => {} });
  assert.equal(Object.keys(require.cache).some(file => file.endsWith('/node_modules/electron/index.js')), false);
  await runtime.shutdown();
});
