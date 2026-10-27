'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ProgressService } = require('../../src/progress/service');
const { ProgressRepository } = require('../../src/progress/repository');
const { createProgressView } = require('../../src/overlay/progress-view');
const { createRendererQuitDrain } = require('../../src/progress/app-lifecycle');
const { registerProgressIpc } = require('../../src/progress/ipc');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'client-barrier-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const entered = deferred(); const release = deferred(); let hold = false; let view;
  const repository = new ProgressRepository({ root: path.join(userData, 'progress'), fs: { ...fs, rename: async (from, to) => {
    if (hold && to.endsWith('/local/state.json')) { hold = false; entered.resolve(); await release.promise; }
    return fs.rename(from, to);
  } } });
  const service = new ProgressService({ repository, onSnapshot: value => view?.applySnapshot(value) });
  await service.initialize({ userData });
  const profileA = service.snapshot().activeProfile.id;
  const second = await service.createProfile({ sessionGeneration: service.snapshot().sessionGeneration, name: 'B', region: '' });
  const profileB = second.value.activeProfile.id;
  await service.selectProfile({ sessionGeneration: service.snapshot().sessionGeneration, profileId: profileA });
  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = name => handlers.delete(name);
  const messages = []; const control = { failPrepare: false, pendingSettings: Promise.resolve(true) };
  function client(name) {
    const contents = new EventEmitter(); contents.mainFrame = {}; contents.isDestroyed = () => false;
    contents.getURL = () => `file:///${name}.html`; contents.isLoadingMainFrame = () => false;
    const window = new EventEmitter(); window.isDestroyed = () => false; window.webContents = contents;
    contents.send = (channel, payload) => {
      messages.push([name, channel, payload.requestId]);
      if (name === 'overlay') {
        if (channel === 'progress:prepare-quit') void view.prepareQuit(payload.requestId).then(ok => ipcMain.emit('progress:quit-ready', { sender: contents, senderFrame: contents.mainFrame }, { requestId: payload.requestId, ok: ok && !control.failPrepare }));
        if (channel === 'progress:resume-after-quit') view.resumeAfterQuit(payload.requestId);
      } else if (channel === 'progress:prepare-quit') {
        void control.pendingSettings.then(ok => ipcMain.emit('progress:quit-ready', { sender: contents, senderFrame: contents.mainFrame }, { requestId: payload.requestId, ok }));
      }
    };
    return { window, url: contents.getURL() };
  }
  const overlay = client('overlay'); const settings = client('settings');
  const overlayDrain = createRendererQuitDrain({ ipcMain, getClients: () => [overlay] });
  const quitDrain = createRendererQuitDrain({ ipcMain, getClients: () => [overlay, settings] });
  // Main supplies this callback; the renderer only sends its narrow payload.
  const { createClientProgressBarrier } = require('../../src/progress/client-barrier');
  const barrier = createClientProgressBarrier({ overlayDrain, quitDrain });
  const withProgressBarrier = operation => barrier.run(operation);
  const file = path.join(userData, 'export.json');
  const dispose = registerProgressIpc({ ipcMain, service, getOverlayWindow: () => overlay.window, getSettingsWindow: () => settings.window,
    openSettings() {}, dialogs: { showSaveDialog: async () => ({ canceled: false, filePath: file }) }, withProgressBarrier });
  t.after(() => { dispose(); barrier.dispose(); });
  const invoke = (channel, payload, owner = settings) => handlers.get(channel)({ sender: owner.window.webContents, senderFrame: owner.window.webContents.mainFrame }, payload);
  const generation = () => ({ sessionGeneration: service.snapshot().sessionGeneration });
  const command = (command, payload) => invoke('profiles:command', { command, payload });
  const errors = [];
  view = createProgressView({ sendSetFound: payload => invoke('progress:set-found', payload, overlay), onError: error => errors.push(error) });
  view.applySnapshot(service.snapshot());
  async function pendingUndo() {
    hold = true;
    const mark = view.setFound(42, true); await entered.promise;
    const undo = view.setFound(42, false);
    assert.deepEqual(view.current().foundIds, []);
    return { mark, undo };
  }
  return { service, repository, view, profileA, profileB, release, pendingUndo, command, invoke, generation, file, overlay, settings, messages, overlayDrain, quitDrain, barrier, control, errors };
}

test('profile switch drains an accepted renderer undo before A to B to A activation', async t => {
  const f = await fixture(t); const { mark, undo } = await f.pendingUndo();
  const switched = f.command('select', { ...f.generation(), profileId: f.profileB });
  await turn(); f.release.resolve();
  assert.equal((await switched).ok, true); await Promise.all([mark, undo]);
  assert.equal((await f.command('select', { ...f.generation(), profileId: f.profileA })).ok, true);
  const durable = await f.repository.load({ kind: 'local' });
  assert.equal(durable.state.profiles[f.profileA].markers['42'].value, false);
  assert.deepEqual(f.view.current().foundIds, []);
  assert.deepEqual(f.errors, []);
});

test('export waits for the accepted renderer undo and excludes marker 42', async t => {
  const f = await fixture(t); const { mark, undo } = await f.pendingUndo();
  const exported = f.command('export-backup', { ...f.generation(), profileIds: [f.profileA] });
  await turn(); f.release.resolve();
  assert.equal((await exported).ok, true); await Promise.all([mark, undo]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).profiles[0].foundIds, []);
});

for (const operation of ['select', 'export-backup']) test(`failed overlay preparation prevents ${operation} mutation, resumes edits and permits retry`, async t => {
  const f = await fixture(t); f.control.failPrepare = true;
  const before = await f.repository.load({ kind: 'local' });
  const payload = () => operation === 'select' ? { ...f.generation(), profileId: f.profileB } : { ...f.generation(), profileIds: [f.profileA] };
  const result = await f.command(operation, payload());
  assert.equal(result.ok, false); assert.equal(result.error.code, 'local-operation-failed');
  assert.deepEqual(await f.repository.load({ kind: 'local' }), before);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  assert.equal(f.barrier.active(), false);
  await f.view.setFound(43, true); assert.deepEqual(f.view.current().foundIds, [43]);
  f.control.failPrepare = false;
  assert.equal((await f.command(operation, payload())).ok, true);
});

test('accepted profile run finishes before all-client quit without waiting on its own settings command', { timeout: 3000 }, async t => {
  const f = await fixture(t); const { mark, undo } = await f.pendingUndo();
  const switched = f.command('select', { ...f.generation(), profileId: f.profileB });
  f.control.pendingSettings = switched.then(result => result.ok);
  const order = []; const accepted = f.barrier.run(() => { order.push('accepted'); });
  const quit = f.barrier.shutdown(async () => { order.push('shutdown'); await f.service.shutdown(); });
  assert.equal(f.barrier.active(), true);
  assert.equal(f.barrier.shutdown(() => assert.fail('duplicate shutdown')), quit);
  const rejected = await f.command('create', { ...f.generation(), name: 'Late', region: '' });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'local-operation-failed');
  await turn(); assert.equal(f.messages.some(([name]) => name === 'settings'), false);
  f.release.resolve(); assert.equal((await switched).ok, true);
  await Promise.all([mark, undo, accepted, quit]);
  assert.deepEqual(order, ['accepted', 'shutdown']);
  const durable = await f.repository.load({ kind: 'local' });
  assert.equal(durable.state.profiles[f.profileA].markers['42'].value, false);
  assert.equal(Object.keys(durable.state.profiles).length, 2);
  const overlayMessages = f.messages.filter(([name]) => name === 'overlay');
  assert.deepEqual(overlayMessages.map(([, channel]) => channel), ['progress:prepare-quit', 'progress:resume-after-quit', 'progress:prepare-quit', 'progress:resume-after-quit', 'progress:prepare-quit']);
  assert.equal(new Set(overlayMessages.filter(([, channel]) => channel === 'progress:prepare-quit').map(([, , id]) => id)).size, 3);
  await assert.rejects(f.barrier.run(() => assert.fail('closed callback')));
});

for (const failure of ['prepare', 'operation']) test(`failed quit ${failure} resumes clients and reopens boundary acceptance for retry`, async t => {
  const f = await fixture(t); f.control.failPrepare = failure === 'prepare';
  let shutdowns = 0;
  await assert.rejects(f.barrier.shutdown(() => { shutdowns++; throw Error('disk'); }));
  assert.equal(shutdowns, failure === 'prepare' ? 0 : 1);
  assert.equal(f.barrier.active(), false);
  assert.equal(f.messages.filter(([, channel]) => channel === 'progress:resume-after-quit').length, 2);
  await f.view.setFound(43, true); assert.deepEqual(f.view.current().foundIds, [43]);
  f.control.failPrepare = false;
  assert.equal((await f.command('select', { ...f.generation(), profileId: f.profileB })).ok, true);
  await f.barrier.shutdown(() => f.service.shutdown());
  await assert.rejects(f.barrier.run(() => assert.fail('closed callback')));
});

test('failed trusted operation resumes overlay and disposal rejects later submissions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.barrier.run(() => { throw Error('operation'); }), /operation/);
  assert.equal(f.barrier.active(), false);
  await f.view.setFound(43, true); assert.deepEqual(f.view.current().foundIds, [43]);
  f.barrier.dispose(); f.barrier.dispose();
  await assert.rejects(f.barrier.run(() => assert.fail('disposed callback')));
  await assert.rejects(f.barrier.shutdown(() => assert.fail('disposed shutdown')));
});
