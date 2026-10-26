'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ProgressService } = require('../../src/progress/service');
const { ProgressRepository } = require('../../src/progress/repository');
const { createClientProgressBarrier } = require('../../src/progress/client-barrier');
const { makeTransfer } = require('./helpers');
const ctx = service => ({ sessionGeneration: service.snapshot().sessionGeneration, profileId: service.snapshot().activeProfile.id });
function windowOwner() {
  const owner = new EventEmitter(); owner.destroyed = false; owner.isDestroyed = () => owner.destroyed;
  const wc = owner.webContents = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => owner.destroyed;
  owner.close = () => { owner.destroyed = true; owner.emit('closed'); wc.emit('destroyed'); };
  return owner;
}
async function setup(t, barrier) {
  // Missing module is the initial RED: every test subsequently runs real runtime/controller/service/atomic files.
  const { createTransferRuntime } = require('../../src/transfer/runtime');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-ipc-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let sequence = 0;
  const repository = new ProgressRepository({ root: path.join(dir, 'progress'), uuid: () => '10000000-0000-4000-8000-000000000001' });
  const service = new ProgressService({ repository, uuid: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` }); await service.initialize({ userData: dir });
  let owner = windowOwner(); const handlers = new Map(); let opens = 0; let saves = 0;
  const file = path.join(dir, 'source.json'), output = path.join(dir, 'output.json');
  const envelope = makeTransfer({ records: [{ id: '42', map: 'appsample:gim:2', state: true, category: null, level: null, position: null }] });
  await fs.writeFile(file, JSON.stringify(envelope));
  let open = async () => ({ canceled: false, filePaths: [file] }); let save = async () => ({ canceled: false, filePath: output });
  let catalog = { namespace: 'appsample:gim:2', fingerprint: 'synthetic', markers: [{ id: '42', category: 'chest', level: null, x: 0, y: 0 }] };
  const runtime = createTransferRuntime({ progress: service, getCatalog: () => catalog, getSettingsWindow: () => owner, ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: c => handlers.delete(c) }, dialogs: { showOpenDialog: (...a) => { opens++; return open(...a); }, showSaveDialog: (...a) => { saves++; return save(...a); } }, withProgressBarrier: barrier || (fn => fn()) });
  t.after(runtime.dispose);
  const f = { service, repository, dir, file, output, envelope, runtime, handlers, ctx: () => ctx(service), event: () => ({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }), call: (name, ...args) => handlers.get('transfer:' + name)(f.event(), ...args), setOpen: fn => { open = fn; }, setSave: fn => { save = fn; }, owner: () => owner, reopen: () => { owner.close(); owner = windowOwner(); }, opens: () => opens, saves: () => saves, refresh: () => { catalog = { ...catalog, fingerprint: 'changed' }; runtime.controller.invalidatePreview(); } };
  return f;
}
const preview = (f, options = {}) => f.call('previewImport', f.ctx(), { provider: 'appsample', mode: 'new', ...options });
test('only captured settings top frame may operate files; denied requests cannot invalidate a valid token', async t => {
  const f = await setup(t); const p = await preview(f); assert.equal(p.ok, true);
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: f.owner().webContents, senderFrame: {} }]) {
    const r = await f.handlers.get('transfer:previewImport')(event, f.ctx(), { provider: 'appsample', mode: 'new' }); assert.equal(r.error.code, 'unauthorized-sender');
  }
  assert.equal(f.opens(), 1); assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).ok, true);
});
test('strict arguments reject renderer paths, extra keys, unknown providers/maps/directions before dialogs', async t => {
  const f = await setup(t);
  for (const options of [{ provider: 'appsample', mode: 'new', path: f.file }, { provider: '../appsample', mode: 'new' }, { provider: 'appsample', mode: 'overwrite' }]) assert.equal((await f.call('previewImport', f.ctx(), options)).ok, false);
  assert.equal((await f.call('previewImport', { ...f.ctx(), path: f.file }, { provider: 'appsample', mode: 'new' })).ok, false);
  assert.equal((await f.call('saveScript', 'appsample', '../../export')).ok, false);
  assert.equal((await f.call('saveScript', 'unknown', 'export')).ok, false);
  assert.equal((await f.call('exportProfile', f.ctx(), { provider: 'appsample', map: '../../file' })).ok, false);
  assert.equal((await f.call('providers', {})).ok, false); assert.equal(f.opens(), 0); assert.equal(f.saves(), 0);
});
test('invalid file projects only safe validation counts and has no usable apply token', async t => {
  const f = await setup(t); const p = await preview(f);
  await fs.writeFile(f.file, JSON.stringify({ ...f.envelope, records: [{ secret: '<token>' }, { id: 7 }] }));
  const r = await preview(f); assert.equal(r.ok, false); assert.equal(r.validation.invalidCount, 2); assert.deepEqual(r.validation.issues.map(i => i.code), ['invalid-record', 'invalid-record']); assert.doesNotMatch(JSON.stringify(r), /<token>|source.json/);
  assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).error.code, 'stale-preview');
});
test('selected-provider mismatch and canceled native preview invalidate old tokens without profile mutation', async t => {
  const f = await setup(t); const before = f.service.snapshot(); const p = await preview(f);
  const mismatch = await preview(f, { provider: 'hoyolab' }); assert.equal(mismatch.error.code, 'provider-mismatch');
  assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).error.code, 'stale-preview');
  const next = await preview(f); f.setOpen(async () => ({ canceled: true })); assert.deepEqual(await preview(f), { ok: true, value: null });
  assert.equal((await f.call('applyImport', f.ctx(), { previewId: next.value.id })).error.code, 'stale-preview'); assert.deepEqual(f.service.snapshot(), before);
});
test('profile changes during pickers and after overlay drain cannot redirect a preview or export', async t => {
  let drain = async () => {}; const f = await setup(t, async fn => { await drain(); return fn(); });
  f.setOpen(async () => { await f.service.createProfile({ sessionGeneration: f.ctx().sessionGeneration, name: 'Other', region: '' }); return { canceled: false, filePaths: [f.file] }; });
  assert.equal((await preview(f)).error.code, 'stale-context');
  f.setOpen(async () => ({ canceled: false, filePaths: [f.file] }));
  drain = async () => { await f.service.createProfile({ sessionGeneration: f.ctx().sessionGeneration, name: 'After drain', region: '' }); };
  assert.equal((await preview(f)).error.code, 'stale-context');
  assert.equal((await f.call('exportProfile', f.ctx(), { provider: 'appsample', map: 'appsample:gim:2' })).error.code, 'stale-context');
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});
test('window destruction/reopen and frame replacement cannot redirect pending files or an old token', async t => {
  const f = await setup(t); const p = await preview(f); f.reopen(); assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).error.code, 'stale-preview');
  f.setOpen(async () => { f.reopen(); return { canceled: false, filePaths: [f.file] }; });
  assert.equal((await preview(f)).error.code, 'unauthorized-sender');
  f.setOpen(async () => { f.owner().webContents.mainFrame = {}; return { canceled: false, filePaths: [f.file] }; });
  assert.equal((await preview(f)).error.code, 'unauthorized-sender');
});
test('queued renderer undo drains before apply and stales the old preview; picker itself stays unfrozen', async t => {
  const { createProgressView } = require('../../src/overlay/progress-view');
  let f; let view; let drains = 0; let drainId;
  const barrier = createClientProgressBarrier({ overlayDrain: {
    async prepare() { drainId = 'drain-' + (++drains); if (view && !await view.prepareQuit(drainId)) throw new Error('drain failed'); },
    resume() { view?.resumeAfterQuit(drainId); }, dispose() {},
  }, quitDrain: { async prepare() {}, resume() {}, dispose() {} } }); t.after(barrier.dispose);
  f = await setup(t, fn => barrier.run(fn));
  let release; const blocked = new Promise(resolve => { release = resolve; }); let first = true;
  view = createProgressView({ sendSetFound: async payload => {
    if (first) { first = false; await blocked; }
    const { sessionGeneration, profileId, id, found } = payload;
    return f.service.setFound({ sessionGeneration, profileId }, { id, found });
  } });
  f.service.onSnapshot = value => view.applySnapshot(value); view.applySnapshot(f.service.snapshot());
  f.setOpen(async () => { assert.equal(barrier.active(), false); return { canceled: false, filePaths: [f.file] }; });
  const p = await preview(f, { mode: 'merge' });
  const marking = view.setFound(42, true); const undoing = view.setFound(42, false);
  assert.deepEqual(view.current().foundIds, []);
  const applying = f.call('applyImport', f.ctx(), { previewId: p.value.id });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(barrier.active(), true);
  release(); assert.equal((await applying).error.code, 'stale-preview'); await Promise.all([marking, undoing]);
  assert.equal(drains, 2); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, []); assert.deepEqual(view.current().foundIds, []);
});
test('main-only report lookup is token/context/revision/catalog checked and detached; forged IDs never save', async t => {
  const f = await setup(t); const p = await preview(f);
  const report = await f.runtime.controller.readImportReport(f.ctx(), p.value.id); assert.equal(report.decisions[0].reason, 'namespace-and-current-id'); report.decisions[0].reason = 'changed';
  assert.equal((await f.runtime.controller.readImportReport(f.ctx(), p.value.id)).decisions[0].reason, 'namespace-and-current-id');
  assert.equal((await f.call('saveReport', 'forged')).error.code, 'stale-preview'); assert.equal(f.saves(), 0);
  assert.equal((await f.call('saveReport', p.value.id)).ok, true); assert.equal(JSON.parse(await fs.readFile(f.output)).format, 'genshin-map-overlay.transfer-report');
  await f.service.setFound(f.ctx(), { id: 42, found: false }); await assert.rejects(f.runtime.controller.readImportReport(f.ctx(), p.value.id), { code: 'stale-preview' });
  const p2 = await preview(f); f.refresh(); await assert.rejects(f.runtime.controller.readImportReport(f.ctx(), p2.value.id), { code: 'stale-preview' });
});
test('local normalized planned-provider imports and exports work; site scripts stay failclosed', async t => {
  const f = await setup(t); const providers = await f.call('providers'); assert.equal(providers.length, 5); assert.ok(providers.every(p => p.status !== 'supported'));
  const p = await preview(f); const applied = await f.call('applyImport', f.ctx(), { previewId: p.value.id }); assert.equal(applied.ok, true); assert.deepEqual(applied.value.snapshot.activeProfile.foundIds, [42]);
  const r = await f.call('exportProfile', f.ctx(), { provider: 'appsample', map: 'appsample:gim:2' }); assert.equal(r.ok, true); assert.equal(r.value.counts.matched, 1); const out = JSON.parse(await fs.readFile(f.output)); assert.equal(out.records[0].id, '42');
  assert.equal((await f.call('saveScript', 'appsample', 'export')).ok, true); const script = await fs.readFile(f.output, 'utf8'); assert.match(script, /first-party-progress-interface-unavailable/);
  f.runtime.dispose(); assert.equal(f.handlers.size, 0);
});
test('expired report/apply tokens, sparse oversized input and bounded invalid issues fail without mutating profiles', async t => {
  const f = await setup(t); const p = await preview(f); const before = f.service.snapshot();
  f.runtime.controller.now = () => Date.now() + 16 * 60 * 1000;
  await assert.rejects(f.runtime.controller.readImportReport(f.ctx(), p.value.id), { code: 'stale-preview' });
  assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).error.code, 'stale-preview');
  const large = await fs.open(f.file, 'r+'); await large.truncate(64 * 1024 * 1024 + 1); await large.close();
  const oversized = await preview(f); assert.equal(oversized.error.code, 'transfer-too-large'); assert.deepEqual(oversized.validation, { invalidCount: 1, issues: [{ recordIndex: null, code: 'transfer-too-large' }] });
  await fs.writeFile(f.file, JSON.stringify({ ...f.envelope, records: Array.from({ length: 150 }, () => ({ private: 'secret-marker-label' })) }));
  const invalid = await preview(f); assert.equal(invalid.validation.invalidCount, 150); assert.equal(invalid.validation.issues.length, 100); assert.doesNotMatch(JSON.stringify(invalid), /secret-marker-label/);
  assert.deepEqual(f.service.snapshot(), before);
});
test('native errors and invalid native paths do not leak paths or arbitrary error text', async t => {
  const f = await setup(t);
  f.setOpen(async () => { throw new Error('/private/secret-source-token'); });
  assert.deepEqual(await preview(f), { ok: false, error: { code: 'local-operation-failed', messageKey: 'transfer.error.local-operation-failed' } });
  f.setOpen(async () => ({ canceled: false, filePaths: ['relative-file.json'] })); assert.equal((await preview(f)).error.code, 'invalid-command');
  f.setSave(async () => ({ canceled: false, filePath: 'relative-script.js' })); assert.equal((await f.call('saveScript', 'appsample', 'export')).error.code, 'invalid-command');
  let getterCalls = 0; const options = { provider: 'appsample', mode: 'new' }; Object.defineProperty(options, 'name', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  assert.equal((await f.call('previewImport', f.ctx(), options)).error.code, 'invalid-command'); assert.equal(getterCalls, 0);
});
test('owner destruction during import backup prevents committing canonical state or attachment', async t => {
  const f = await setup(t); const p = await preview(f); const before = await f.repository.load({ kind: 'local' });
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { await backup(...args); f.reopen(); };
  const reply = await f.call('applyImport', f.ctx(), { previewId: p.value.id }); assert.equal(reply.error.code, 'unauthorized-sender');
  assert.deepEqual(await f.repository.load({ kind: 'local' }), before);
  assert.equal((await f.call('applyImport', f.ctx(), { previewId: p.value.id })).error.code, 'stale-preview');
});
test('settings HTML/DOM, sandbox preload, actual IPC/service and native files complete repeated new imports and export', async t => {
  const { mountSettings } = require('../../src/settings/settings'); const I18n = require('../../src/shared/i18n');
  const { makeSettingsDocument } = require('./settings-harness'); const { registerProgressIpc } = require('../../src/progress/ipc');
  const Module = require('node:module'); const fsSync = require('node:fs');
  let freezes = 0; const f = await setup(t, async fn => { freezes++; return fn(); });
  const disposeProgress = registerProgressIpc({ ipcMain: { handle: (c, fn) => f.handlers.set(c, fn), removeHandler: c => f.handlers.delete(c) }, service: f.service, getSettingsWindow: f.owner, getOverlayWindow: () => null, dialogs: {}, openSettings() {} }); t.after(disposeProgress);
  const renderer = new EventEmitter(); renderer.invoke = (channel, ...args) => f.handlers.get(channel)(f.event(), ...args); renderer.send = () => {};
  const exposed = {}; const filename = require.resolve('../../src/settings/preload'); const preload = new Module(filename, module);
  preload.require = id => { assert.equal(id, 'electron'); return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } } }; };
  preload._compile(fsSync.readFileSync(filename, 'utf8'), filename);
  const document = makeSettingsDocument(); const $ = id => document.getElementById(id);
  const mounted = mountSettings({ document, api: exposed.profileApi, transferApi: exposed.transferApi, I18n }); t.after(mounted.dispose);
  f.service.onSnapshot = value => renderer.emit('progress:snapshot', {}, value);
  await mounted.ready; assert.deepEqual(Object.keys(exposed).sort(), ['profileApi', 'transferApi']);
  assert.deepEqual(Object.keys(exposed.transferApi).sort(), ['applyImport', 'exportProfile', 'previewImport', 'providers', 'saveReport', 'saveScript']);
  renderer.emit('profiles:language', {}, 'de'); $('transfer-name').value = '<synthetic name>';
  await $('transfer-preview').click(); assert.equal($('transfer-mode').value, 'new'); assert.equal($('transfer-apply').disabled, false);
  // The active profile is still empty: its export differs from the one-marker import.
  await $('transfer-export').click(); assert.deepEqual(JSON.parse(await fs.readFile(f.output)).records, []);
  assert.ok($('transfer-counts').textContent.includes(I18n.t('de', 'transfer.count.matched') + ': 0'));
  assert.equal($('transfer-apply').disabled, true); await $('transfer-apply').click(); assert.equal(f.service.snapshot().profiles.length, 1);
  await $('transfer-preview').click(); assert.equal($('transfer-apply').disabled, false);
  await $('transfer-apply').click(); assert.equal(f.service.snapshot().profiles.length, 2); assert.equal($('active-profile').textContent, '<synthetic name>'); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  await $('transfer-preview').click(); assert.equal($('transfer-apply').disabled, true); assert.equal($('transfer-another').hidden, false);
  await $('transfer-another').click(); assert.equal(f.service.snapshot().profiles.length, 3); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
  await $('transfer-export').click(); assert.equal(JSON.parse(await fs.readFile(f.output)).records[0].id, '42'); assert.equal(freezes, 7);
  renderer.emit('profiles:language', {}, 'en'); assert.equal(document.documentElement.lang, 'en'); assert.match($('transfer-counts').textContent, /Matched/);
});
test('disposing transfer routing releases every owner lifecycle listener', async t => {
  const f = await setup(t); await preview(f); assert.ok(f.owner().listenerCount('closed') > 0); f.runtime.dispose();
  assert.equal(f.owner().listenerCount('closed'), 0); assert.equal(f.owner().webContents.listenerCount('destroyed'), 0); assert.equal(f.owner().webContents.listenerCount('did-start-navigation'), 0);
});
test('accepted settings Apply and main quit serialize without preparing the initiator inside its own transfer barrier', async t => {
  const { mountSettings } = require('../../src/settings/settings'); const I18n = require('../../src/shared/i18n'); const { makeSettingsDocument } = require('./settings-harness');
  let mounted; let settingsPreparing = false; let overlays = 0;
  const barrier = createClientProgressBarrier({ overlayDrain: { async prepare() { overlays++; }, resume() {}, dispose() {} }, quitDrain: { async prepare() { settingsPreparing = true; if (!await mounted.prepareQuit('QUIT')) throw new Error('settings-drain-failed'); }, resume() { mounted.resumeAfterQuit('QUIT'); }, dispose() {} } }); t.after(barrier.dispose);
  const f = await setup(t, fn => barrier.run(fn)); let subscriber;
  const api = { getState: async () => ({ ok: true, value: f.service.snapshot() }), onSnapshot: fn => { subscriber = fn; return () => {}; }, onLanguage: () => () => {}, command: async () => ({ ok: false }) };
  const transferApi = Object.fromEntries(['providers', 'previewImport', 'applyImport', 'exportProfile', 'saveScript', 'saveReport'].map(name => [name, (...args) => f.call(name, ...args)]));
  const document = makeSettingsDocument(); mounted = mountSettings({ document, api, transferApi, I18n }); t.after(mounted.dispose); f.service.onSnapshot = value => subscriber(value); await mounted.ready;
  await document.getElementById('transfer-preview').click();
  let release; const hold = new Promise(resolve => { release = resolve; }); let entered; const backingUp = new Promise(resolve => { entered = resolve; });
  const backup = f.repository.backup.bind(f.repository); f.repository.backup = async (...args) => { await backup(...args); entered(); await hold; };
  const applying = document.getElementById('transfer-apply').click(); await backingUp;
  const quitting = barrier.shutdown(() => f.service.shutdown());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settingsPreparing, false); assert.equal(document.getElementById('transfer-export').disabled, true);
  release(); await applying; await quitting; assert.equal(settingsPreparing, true); assert.equal(overlays, 2); assert.deepEqual(f.service.snapshot().activeProfile.foundIds, [42]);
});
