'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerProgressIpc } = require('../../src/progress/ipc');
const { ProgressService } = require('../../src/progress/service');
const { ProgressRepository } = require('../../src/progress/repository');
const { LIMITS } = require('../../src/progress/schema');

function windowStub() {
  const frame = {};
  return { dead: false, isDestroyed() { return this.dead; }, webContents: { dead: false, mainFrame: frame, isDestroyed() { return this.dead; } } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
async function fixture(t, options = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-ipc-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const repository = new ProgressRepository({ root: path.join(userData, 'progress') });
  const service = new ProgressService({ repository });
  await service.initialize({ userData });
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const overlay = windowStub(); const settings = windowStub(); const tracker = windowStub();
  let currentSettings = settings; let opened = 0;
  const dialogs = options.dialogs || { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) };
  const dispose = registerProgressIpc({ ipcMain, service, getOverlayWindow: () => overlay, getSettingsWindow: () => currentSettings, openSettings: () => { opened++; return options.openSettings?.(); }, dialogs, ...(options.withProgressBarrier ? { withProgressBarrier: options.withProgressBarrier } : {}), ...(options.retryLocal ? { retryLocal: options.retryLocal(service, userData) } : {}) });
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const invoke = (channel, payload, sender = settings, extra = {}) => handlers.get(channel)({ ...event(sender), ...extra }, payload);
  const generation = () => ({ sessionGeneration: service.snapshot().sessionGeneration });
  const context = () => ({ ...generation(), profileId: service.snapshot().activeProfile.id });
  const command = (name, payload = generation(), sender = settings, extra = {}) => invoke('profiles:command', { command: name, payload }, sender, extra);
  return { userData, repository, service, handlers, dispose, overlay, settings, tracker, invoke, command, generation, context, get opened() { return opened; }, replaceSettings: win => { currentSettings = win; } };
}
function code(reply, expected) { assert.equal(reply.ok, false); assert.equal(reply.error.code, expected); assert.equal(reply.error.messageKey, `progress.error.${expected}`); }

test('only the expected live top frame may read or mutate progress', async t => {
  const f = await fixture(t); const before = f.service.snapshot();
  for (const extra of [{ senderFrame: {} }, { sender: f.tracker.webContents }, { senderFrame: null }]) {
    code(await f.invoke('progress:set-found', { ...f.context(), id: 42, found: true }, f.overlay, extra), 'unauthorized-sender');
    code(await f.invoke('progress:get', undefined, f.settings, extra), 'unauthorized-sender');
  }
  code(await f.invoke('progress:set-found', { ...f.context(), id: 42, found: true }, f.tracker), 'unauthorized-sender');
  code(await f.command('create', { ...f.generation(), name: 'New', region: '' }, f.overlay), 'unauthorized-sender');
  f.settings.webContents.dead = true;
  code(await f.command('restore-local'), 'unauthorized-sender');
  f.overlay.dead = true;
  code(await f.invoke('progress:get', undefined, f.overlay), 'unauthorized-sender');
  assert.deepEqual(f.service.snapshot(), before);
});

test('validated ordinary channels and settings commands route to durable service state', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.invoke('progress:get', undefined, f.overlay)).value, f.service.snapshot());
  assert.equal((await f.invoke('progress:set-found', { ...f.context(), id: 42, found: true }, f.overlay)).ok, true);
  assert.equal((await f.invoke('progress:set-preferences', { ...f.context(), hideFound: true, enabledTypes: ['o999', 'o5'] }, f.settings)).ok, true);
  assert.equal((await f.command('rename', { ...f.context(), name: ' <旅人> 🐉 ', region: 'EU' })).ok, true);
  const first = f.context().profileId;
  assert.equal((await f.command('create', { ...f.generation(), name: 'Second', region: '' })).ok, true);
  assert.equal((await f.invoke('progress:select-profile', { ...f.generation(), profileId: first }, f.overlay)).ok, true);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  assert.equal(f.service.snapshot().activeProfile.name, '<旅人> 🐉');
  assert.equal((await f.command('select', f.context())).ok, true);
  assert.equal((await f.invoke('profiles:open-settings', undefined, f.overlay)).ok, true);
  assert.equal(f.opened, 1);
});

test('rejects malformed payloads before calling any service command or dialog', async t => {
  const f = await fixture(t);
  let calls = 0;
  for (const method of ['setFound', 'setPreferences', 'selectProfile', 'createProfile', 'renameProfile', 'importBackup', 'exportBackup', 'restoreLocalBackup']) f.service[method] = () => { calls++; throw Error('must not call'); };
  const ctx = f.context(); const gen = f.generation();
  for (const payload of [null, {}, { ...ctx, id: '42', found: true }, { ...ctx, id: NaN, found: true }, { ...ctx, id: 0, found: true }, { ...ctx, id: 42, found: 1 }, { ...ctx, id: 42, found: true, path: '/private' }, { ...ctx, id: 42, found: true, extra: false }, { ...ctx, sessionGeneration: 7, id: 42, found: true }, { ...ctx, profileId: 42, id: 42, found: true }]) code(await f.invoke('progress:set-found', payload), 'invalid-command');
  for (const payload of [{ ...ctx, hideFound: 'true' }, { ...ctx, enabledTypes: ['o0'] }, { ...ctx, enabledTypes: ['o5', 6] }, { ...ctx, enabledTypes: Array(4097).fill('o5') }, { ...ctx, enabledTypes: ['o5'], unknown: true }]) assert.equal((await f.invoke('progress:set-preferences', payload)).ok, false);
  for (const [name, payload] of [['unknown', gen], ['create', { ...gen, name: 'x'.repeat(81), region: '' }], ['create', { ...gen, name: '  ', region: '' }], ['rename', { ...ctx, region: '🐉'.repeat(81) }], ['import-backup', { ...gen, path: '/private' }], ['export-backup', { ...gen, profileIds: [ctx.profileId], filePath: '/private' }], ['export-backup', { ...gen, profileIds: ['invalid'] }], ['export-backup', { ...gen, profileIds: [] }], ['restore-local', { ...gen, mutate: 'arbitrary' }], ['retry-local', { ...gen, userData: '/private' }]]) assert.equal((await f.command(name, payload)).ok, false);
  code(await f.invoke('profiles:command', { command: 'restore-local', payload: gen, extra: true }), 'invalid-command');
  code(await f.invoke('progress:get', { path: '/private' }), 'invalid-command');
  code(await f.invoke('profiles:open-settings', { path: '/private' }), 'invalid-command');
  assert.equal(calls, 0); assert.equal(f.opened, 0);
});

test('canceled main-owned pickers do not change progress or create a backup file', async t => {
  const f = await fixture(t); const before = f.service.snapshot();
  assert.deepEqual(await f.command('import-backup'), { ok: true, value: { canceled: true } });
  assert.deepEqual(await f.command('export-backup', { ...f.generation(), profileIds: [f.context().profileId] }), { ok: true, value: { canceled: true } });
  assert.deepEqual(f.service.snapshot(), before);
});

for (const operation of ['import-backup', 'export-backup']) test(`selection while ${operation} picker is open invalidates continuation`, async t => {
  const picker = deferred(); const entered = deferred();
  const f = await fixture(t, { dialogs: { showOpenDialog: () => { entered.resolve(); return picker.promise; }, showSaveDialog: () => { entered.resolve(); return picker.promise; } } });
  const file = path.join(f.userData, 'picked.json');
  await fs.writeFile(file, 'original bytes');
  const pending = f.command(operation, operation === 'export-backup' ? { ...f.generation(), profileIds: [f.context().profileId] } : f.generation());
  await entered.promise;
  await f.service.selectProfile(f.context()); // Same ID still rotates the activation.
  const before = f.service.snapshot();
  picker.resolve({ canceled: false, filePath: file, filePaths: [file] });
  code(await pending, 'stale-context');
  assert.deepEqual(f.service.snapshot(), before);
  assert.equal(await fs.readFile(file, 'utf8'), 'original bytes');
});

for (const change of ['destroy', 'replace', 'navigate']) test(`${change} of settings window during a picker rejects its continuation`, async t => {
  const picker = deferred(); const entered = deferred();
  const f = await fixture(t, { dialogs: { showOpenDialog: () => { entered.resolve(); return picker.promise; } } });
  const pending = f.command('import-backup'); await entered.promise;
  if (change === 'destroy') f.settings.dead = true;
  if (change === 'replace') f.replaceSettings(windowStub());
  if (change === 'navigate') f.settings.webContents.mainFrame = {};
  picker.resolve({ canceled: false, filePaths: ['/must-not-read'] });
  code(await pending, 'unauthorized-sender');
});

test('backup export uses constant suggested filename, writes only main-chosen path and imports as new profiles', async t => {
  let target; const observed = [];
  const f = await fixture(t, { dialogs: { showSaveDialog: async (win, options) => { observed.push([win, options]); return { canceled: false, filePath: target }; }, showOpenDialog: async (win, options) => { observed.push([win, options]); return { canceled: false, filePaths: [target] }; } } });
  target = path.join(f.userData, 'portable.json');
  await f.service.renameProfile(f.context(), { name: '../../<bad> 🐉' });
  await f.service.setFound(f.context(), { id: 42, found: true });
  assert.equal((await f.command('export-backup', { ...f.generation(), profileIds: [f.context().profileId] })).ok, true);
  const backup = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(observed[0][0], f.settings);
  assert.equal(observed[0][1].defaultPath, 'genshin-map-overlay-backup.json');
  assert.deepEqual(backup.profiles[0].foundIds, [42]);
  assert.equal((await f.command('import-backup')).ok, true);
  assert.equal(f.service.snapshot().profiles.length, 2);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});

test('actual bounded import reads reject oversized files before parsing or calling the service', async t => {
  let target; const f = await fixture(t, { dialogs: { showOpenDialog: async () => ({ canceled: false, filePaths: [target] }) } });
  target = path.join(f.userData, 'oversized.json');
  await fs.writeFile(target, Buffer.alloc(LIMITS.PORTABLE_BODY_BYTES + 1, 120));
  const before = f.service.snapshot(); let imports = 0;
  f.service.importBackup = () => { imports++; throw Error('must not parse'); };
  code(await f.command('import-backup'), 'limit-exceeded');
  assert.equal(imports, 0); assert.deepEqual(f.service.snapshot(), before);
});

test('malformed backup and IO/dialog exceptions return safe results without paths', async t => {
  let target; let throwDialog = false;
  const f = await fixture(t, { dialogs: { showOpenDialog: async () => { if (throwDialog) throw Error('secret /personal/path'); return { canceled: false, filePaths: [target] }; } } });
  target = path.join(f.userData, 'invalid.json'); await fs.writeFile(target, '{broken');
  code(await f.command('import-backup'), 'invalid-backup');
  target = path.join(f.userData, 'missing.json');
  const reply = await f.command('import-backup'); code(reply, 'local-read-failed');
  assert.equal(JSON.stringify(reply).includes(f.userData), false);
  throwDialog = true; code(await f.command('import-backup'), 'local-operation-failed');
});

test('settings-only retry-local validates exact current session before invoking main callback', async t => {
  let retries = 0;
  const f = await fixture(t, { retryLocal: (service, userData) => async () => { retries++; return service.initialize({ userData }); } });
  const old = f.generation();
  code(await f.command('retry-local', old, f.overlay), 'unauthorized-sender');
  code(await f.command('retry-local', { ...old, path: '/private' }), 'invalid-command');
  code(await f.command('retry-local', { sessionGeneration: 'stale' }), 'stale-context');
  code(await f.command('retry-local', old, f.settings, { senderFrame: {} }), 'unauthorized-sender');
  assert.equal(retries, 0);
  assert.equal((await f.command('retry-local', old)).ok, true); assert.equal(retries, 1);
  code(await f.command('retry-local', old), 'stale-context');
  const without = await fixture(t); code(await without.command('retry-local'), 'retry-unavailable');
});

test('disposal removes all handlers and invalidates a picker already in flight', async t => {
  const picker = deferred(); const entered = deferred();
  const f = await fixture(t, { dialogs: { showOpenDialog: () => { entered.resolve(); return picker.promise; } } });
  assert.equal(f.handlers.size, 6);
  const pending = f.command('import-backup'); await entered.promise;
  f.dispose(); f.dispose(); assert.equal(f.handlers.size, 0);
  picker.resolve({ canceled: false, filePaths: ['/must-not-read'] });
  code(await pending, 'unauthorized-sender');
});

test('denied windows and frames never read live service data and receive detached redacted snapshots', async t => {
  const f = await fixture(t);
  const actual = f.service.snapshot(); let reads = 0;
  f.service.snapshot = () => { reads++; return actual; };
  const expected = { sessionGeneration: '', viewVersion: 0, scope: 'local', account: null, profiles: [], activeProfile: null, sync: { phase: 'initializing', code: null, lastSuccessAt: null } };
  for (const [sender, extra] of [[f.tracker, {}], [f.overlay, { senderFrame: {} }], [f.settings, { sender: f.tracker.webContents }]]) {
    const reply = await f.invoke('progress:get', undefined, sender, extra);
    code(reply, 'unauthorized-sender'); assert.deepEqual(reply.snapshot, expected);
    const output = JSON.stringify(reply);
    for (const secret of [actual.sessionGeneration, actual.activeProfile.id, actual.activeProfile.name]) assert.equal(output.includes(secret), false);
    reply.snapshot.profiles.push({ id: 'mutated' });
  }
  assert.equal(reads, 0);
});

test('authorized stale requests include the current authoritative snapshot', async t => {
  const f = await fixture(t); const old = f.generation();
  await f.service.selectProfile(f.context());
  const reply = await f.command('retry-local', old);
  code(reply, 'stale-context'); assert.deepEqual(reply.snapshot, f.service.snapshot());
});

test('empty-only channels reject primitives, arrays and extra IPC arguments', async t => {
  const f = await fixture(t);
  for (const payload of [null, false, 0, '', [], { unknown: true }]) {
    code(await f.invoke('progress:get', payload), 'invalid-command');
    code(await f.invoke('profiles:open-settings', payload), 'invalid-command');
  }
  assert.equal((await f.invoke('progress:get', {})).ok, true);
  assert.equal((await f.invoke('profiles:open-settings', {})).ok, true);
  const handler = f.handlers.get('progress:set-found');
  code(await handler({ sender: f.overlay.webContents, senderFrame: f.overlay.webContents.mainFrame }, { ...f.context(), id: 42, found: true }, 'extra'), 'invalid-command');
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []);
});

test('picker rejection after window destruction remains unauthorized and does not read live state', async t => {
  let reject; const entered = deferred(); const picker = new Promise((resolve, fail) => { reject = fail; });
  const f = await fixture(t, { dialogs: { showOpenDialog: () => { entered.resolve(); return picker; } } });
  const pending = f.command('import-backup'); await entered.promise;
  let reads = 0; const snapshot = f.service.snapshot();
  f.service.snapshot = () => { reads++; return snapshot; };
  f.settings.dead = true; reject(Error('secret /personal/path'));
  code(await pending, 'unauthorized-sender'); assert.equal(reads, 0);
});

function denied(reply) {
  code(reply, 'unauthorized-sender');
  assert.deepEqual(reply.snapshot, { sessionGeneration: '', viewVersion: 0, scope: 'local', account: null, profiles: [], activeProfile: null, sync: { phase: 'initializing', code: null, lastSuccessAt: null } });
}

test('successful delayed settings opener rechecks the captured frame before reading a snapshot', async t => {
  const entered = deferred(); const completion = deferred();
  const f = await fixture(t, { openSettings: () => { entered.resolve(); return completion.promise; } });
  const pending = f.invoke('profiles:open-settings', undefined, f.overlay); await entered.promise;
  const snapshot = f.service.snapshot(); let reads = 0;
  f.service.snapshot = () => { reads++; return snapshot; };
  f.overlay.webContents.mainFrame = {}; completion.resolve();
  denied(await pending); assert.equal(reads, 0);
});

test('successful delayed retry-local after disposal returns only the redacted result', async t => {
  const entered = deferred(); const completion = deferred();
  const f = await fixture(t, { retryLocal: () => () => { entered.resolve(); return completion.promise; } });
  const pending = f.command('retry-local'); await entered.promise;
  const snapshot = f.service.snapshot(); let reads = 0;
  f.service.snapshot = () => { reads++; return snapshot; };
  f.dispose(); completion.resolve(snapshot);
  denied(await pending); assert.equal(reads, 0);
});

for (const outcome of ['success', 'error']) test(`delayed service ${outcome} after owner replacement is guarded while accepted durable work survives`, async t => {
  const f = await fixture(t); const completed = deferred(); const reply = deferred();
  const setFound = f.service.setFound.bind(f.service);
  f.service.setFound = async (...args) => { const result = await setFound(...args); completed.resolve(); await reply.promise; return result; };
  const ctx = f.context();
  if (outcome === 'error') ctx.profileId = '10000000-0000-4000-8000-000000000099';
  const pending = f.invoke('progress:set-found', { ...ctx, id: 42, found: true }); await completed.promise;
  const snapshot = f.service.snapshot(); let reads = 0;
  f.service.snapshot = () => { reads++; return snapshot; };
  f.replaceSettings(windowStub()); reply.resolve();
  denied(await pending); assert.equal(reads, 0);
  const durable = await f.repository.load({ kind: 'local' });
  const marker = durable.state.profiles[durable.selectedProfileId].markers['42'];
  if (outcome === 'success') assert.equal(marker.value, true);
  else assert.equal(marker, undefined);
});

test('completed export write rechecks disposal before reading or returning a live snapshot', async t => {
  let target; const f = await fixture(t, { dialogs: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } });
  target = path.join(f.userData, 'completed-export.json');
  const entered = deferred(); const completion = deferred(); const originalRename = fs.rename;
  fs.rename = async (from, to) => { await originalRename(from, to); if (to === target) { entered.resolve(); await completion.promise; } };
  t.after(() => { fs.rename = originalRename; });
  const pending = f.command('export-backup', { ...f.generation(), profileIds: [f.context().profileId] }); await entered.promise;
  const snapshot = f.service.snapshot(); let reads = 0;
  f.service.snapshot = () => { reads++; return snapshot; };
  f.dispose(); completion.resolve();
  denied(await pending); assert.equal(reads, 0);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).format, 'genshin-map-overlay.backup');
});

for (const change of ['frame', 'owner', 'session']) for (const operation of ['create', 'import-backup', 'export-backup', 'ordinary-select']) test(`${change} change while waiting for ${operation} barrier prevents mutation`, async t => {
  const entered = deferred(); const release = deferred(); let target;
  const f = await fixture(t, { withProgressBarrier: async callback => { entered.resolve(); await release.promise; return callback(); }, dialogs: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [target] }),
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
  } });
  target = path.join(f.userData, 'guarded-file.json');
  const original = JSON.stringify({ format: 'genshin-map-overlay.backup', version: 1, namespace: 'appsample:gim:2', profiles: [{ name: 'Imported', region: '', foundIds: [43], enabledTypes: [], hideFound: false }] });
  await fs.writeFile(target, original);
  const pending = operation === 'ordinary-select'
    ? f.invoke('progress:select-profile', f.context(), f.overlay)
    : f.command(operation, operation === 'create' ? { ...f.generation(), name: 'Must not exist', region: '' }
      : operation === 'export-backup' ? { ...f.generation(), profileIds: [f.context().profileId] } : f.generation());
  await entered.promise;
  const owner = operation === 'ordinary-select' ? f.overlay : f.settings;
  if (change === 'frame') owner.webContents.mainFrame = {};
  if (change === 'owner') {
    if (operation === 'ordinary-select') owner.dead = true;
    else f.replaceSettings(windowStub());
  }
  if (change === 'session') await f.service.selectProfile(f.context());
  const before = await f.repository.load({ kind: 'local' });
  release.resolve(); code(await pending, change === 'session' ? 'stale-context' : 'unauthorized-sender');
  assert.deepEqual(await f.repository.load({ kind: 'local' }), before);
  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('pickers and bounded import validation precede the barrier; canceled and malformed input never freeze clients', async t => {
  let preparations = 0; let target;
  const f = await fixture(t, { withProgressBarrier: async operation => { preparations++; return operation(); }, dialogs: {
    showOpenDialog: async () => { assert.equal(preparations, 0); return target ? { canceled: false, filePaths: [target] } : { canceled: true }; },
    showSaveDialog: async () => { assert.equal(preparations, 0); return { canceled: true }; },
  } });
  assert.equal((await f.command('import-backup')).value.canceled, true);
  assert.equal((await f.command('export-backup', { ...f.generation(), profileIds: [f.context().profileId] })).value.canceled, true);
  target = path.join(f.userData, 'invalid-before-drain.json'); await fs.writeFile(target, '{broken');
  code(await f.command('import-backup'), 'invalid-backup');
  assert.equal(preparations, 0);
});

test('all profile boundary commands use the main barrier while ordinary edits and rename remain writable', async t => {
  let preparations = 0; let target;
  const f = await fixture(t, { withProgressBarrier: async operation => { preparations++; return operation(); },
    retryLocal: service => async () => service.snapshot(), dialogs: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [target] }),
      showSaveDialog: async () => ({ canceled: false, filePath: target }),
    } });
  target = path.join(f.userData, 'boundary.json');
  await f.command('rename', { ...f.context(), name: 'Renamed' });
  await f.invoke('progress:set-found', { ...f.context(), id: 42, found: true });
  await f.invoke('progress:set-preferences', { ...f.context(), hideFound: true });
  assert.equal(preparations, 0);
  await f.command('create', { ...f.generation(), name: 'Other', region: '' }); assert.equal(preparations, 1);
  await f.command('select', f.context()); assert.equal(preparations, 2);
  await f.invoke('progress:select-profile', f.context(), f.overlay); assert.equal(preparations, 3);
  await f.command('export-backup', { ...f.generation(), profileIds: [f.context().profileId] }); assert.equal(preparations, 4);
  await f.command('import-backup'); assert.equal(preparations, 5);
  await f.command('restore-local'); assert.equal(preparations, 6);
  await f.command('retry-local'); assert.equal(preparations, 7);
});

test('native pickers import and export validated attachment backups above 4 MiB', async t => {
  let inputFile; let outputFile; let barrierCalls = 0;
  const f = await fixture(t, { dialogs: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [inputFile] }),
    showSaveDialog: async () => ({ canceled: false, filePath: outputFile }),
  }, withProgressBarrier: operation => { barrierCalls++; return operation(); } });
  inputFile = path.join(f.userData, 'attachment-input.json'); outputFile = path.join(f.userData, 'attachment-output.json');
  const records = Array.from({ length: 22000 }, (_, i) => ({ provider: 'bwiki', map: 'unsupported-realm', catalog: { generation: 'synthetic', fingerprint: 'f'.repeat(64) }, record: { id: String(i), map: 'unsupported-realm', category: null, level: null, state: true, position: null }, mapping: null }));
  const backup = { format: 'genshin-map-overlay.backup', version: 2, namespace: 'appsample:gim:2', profiles: [{ name: 'Synthetic', region: '', foundIds: [42], enabledTypes: [], hideFound: false }], extensions: { transfer: { version: 1, profiles: { '0': { version: 1, records, imports: [] } } } } };
  const input = JSON.stringify(backup); assert.ok(Buffer.byteLength(input) > 4 * 1024 * 1024);
  await fs.writeFile(inputFile, input);
  assert.equal((await f.command('import-backup')).ok, true);
  assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  const id = f.context().profileId;
  assert.equal((await f.command('export-backup', { ...f.generation(), profileIds: [id] })).ok, true);
  const output = await fs.readFile(outputFile); assert.ok(output.length > 4 * 1024 * 1024);
  assert.equal(JSON.parse(output).extensions.transfer.profiles['0'].records.length, 22000);
  assert.equal(barrierCalls, 2);
  const durable = await f.repository.load({ kind: 'local' });
  assert.equal(durable.extensions.transfer.profiles[id].records.length, 22000);
});

test('native import retains the v1 and malformed-v2 byte gates before the barrier', async t => {
  let inputFile; let barrierCalls = 0;
  const f = await fixture(t, { dialogs: { showOpenDialog: async () => ({ canceled: false, filePaths: [inputFile] }) }, withProgressBarrier: operation => { barrierCalls++; return operation(); } });
  inputFile = path.join(f.userData, 'oversized-v1.json');
  const value = { format: 'genshin-map-overlay.backup', version: 1, namespace: 'appsample:gim:2', profiles: [{ name: 'Synthetic', region: '', foundIds: [], enabledTypes: [], hideFound: false }] };
  const body = Buffer.alloc(4 * 1024 * 1024 + 1, 32); Buffer.from(JSON.stringify(value)).copy(body); await fs.writeFile(inputFile, body);
  code(await f.command('import-backup'), 'limit-exceeded');
  value.version = 2; value.extensions = { transfer: { version: 2, profiles: {} } }; await fs.writeFile(inputFile, JSON.stringify(value));
  code(await f.command('import-backup'), 'unsupported-version');
  assert.equal(barrierCalls, 0);
});

test('native read bounds attachment files at 96 MiB before barrier or import', async t => {
  let inputFile; let barriers = 0;
  const f = await fixture(t, { dialogs: { showOpenDialog: async () => ({ canceled: false, filePaths: [inputFile] }) }, withProgressBarrier: operation => { barriers++; return operation(); } });
  inputFile = path.join(f.userData, 'too-large-v2.json'); const handle = await fs.open(inputFile, 'w');
  try { await handle.truncate(96 * 1024 * 1024 + 1); } finally { await handle.close(); }
  code(await f.command('import-backup'), 'limit-exceeded');
  assert.equal(barriers, 0);
});
