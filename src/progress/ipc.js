'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { LIMITS, ProgressError } = require('./schema');
const { readFileBounded, atomicWriteFile } = require('./atomic-file');
const { parseBackup } = require('./backup');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANNELS = ['progress:get', 'progress:set-found', 'progress:set-preferences', 'progress:select-profile', 'profiles:open-settings', 'profiles:command'];
const SAFE_CODES = new Set(['unauthorized-sender', 'invalid-command', 'invalid-backup', 'unsupported-version', 'limit-exceeded', 'stale-context', 'retry-unavailable', 'local-read-failed', 'local-write-failed', 'local-durability-uncertain', 'local-operation-failed']);
const FILTERS = [{ name: 'Genshin Map Overlay backup', extensions: ['json'] }];
function fail(code = 'invalid-command') { throw new ProgressError(code); }
function record(value, required, optional = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if ((!required.includes(key) && !optional.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  if (!required.every(key => Object.hasOwn(value, key))) fail();
}
function empty(value) { if (value !== undefined) record(value, []); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(); }
function generation(value) { if (typeof value !== 'string' || !value.length || value.length > 128) fail(); }
function context(value) { generation(value.sessionGeneration); uuid(value.profileId); return { sessionGeneration: value.sessionGeneration, profileId: value.profileId }; }
function text(value, limit, trim = false) {
  if (typeof value !== 'string') fail();
  const result = trim ? value.trim() : value;
  if (Array.from(result).length > limit) fail('limit-exceeded');
  if (trim && !result.length) fail();
  return result;
}
function array(value, maximum, check) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (value.length > maximum) fail('limit-exceeded');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail();
  const copied = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    check(descriptor.value); copied.push(descriptor.value);
  }
  return copied;
}
function metadata(value) {
  const patch = {};
  if (Object.hasOwn(value, 'name')) patch.name = text(value.name, LIMITS.NAME_CODE_POINTS, true);
  if (Object.hasOwn(value, 'region')) patch.region = text(value.region, LIMITS.REGION_CODE_POINTS);
  return patch;
}
function preferences(value) {
  const patch = {};
  if (Object.hasOwn(value, 'hideFound')) { if (typeof value.hideFound !== 'boolean') fail(); patch.hideFound = value.hideFound; }
  if (Object.hasOwn(value, 'enabledTypes')) patch.enabledTypes = array(value.enabledTypes, LIMITS.ENABLED_TYPES, key => {
    if (typeof key !== 'string' || !/^o[1-9]\d{0,14}$/.test(key) || !Number.isSafeInteger(Number(key.slice(1)))) fail();
  });
  return patch;
}

/**
 * Register the narrow renderer boundary. Ordinary setters take flat Context +
 * patch fields; profiles:command takes exactly {command, payload}, where payload
 * mirrors the corresponding service arguments, excluding bytes/paths/callbacks.
 * get/open-settings accept only undefined or an empty plain record.
 *
 * dialogs is main-owned Electron-compatible {showOpenDialog(window, options),
 * showSaveDialog(window, options)}. Native picker paths never cross back to a
 * renderer. Cancellation returns {ok:true,value:{canceled:true}} without a write
 * or service publication. All successful non-canceled commands return snapshots.
 * retryLocal is a main-only no-argument callback capturing its initialization path.
 * withProgressBarrier is a main-owned callback, never selected by renderer data.
 * It drains accepted overlay intentions before bounded profile/file operations.
 * @param {{ipcMain:object,service:import('./service').ProgressService,getOverlayWindow:()=>object|null,getSettingsWindow:()=>object|null,openSettings:()=>unknown,dialogs:object,retryLocal?:()=>Promise<import('./service').PublicSnapshot>,withProgressBarrier?:(operation:Function)=>Promise<unknown>}} options
 * @returns {()=>void} Idempotent disposal; invalidates pending picker continuations.
 */
function registerProgressIpc({ ipcMain, service, getOverlayWindow, getSettingsWindow, openSettings, dialogs, retryLocal, withProgressBarrier = operation => operation() }) {
  let disposed = false;
  function live(window) { return window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed(); }
  function trusted(event, settingsOnly = false) {
    if (disposed || !event) fail('unauthorized-sender');
    const windows = settingsOnly ? [getSettingsWindow()] : [getOverlayWindow(), getSettingsWindow()];
    const owner = windows.find(window => live(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
    if (!owner) fail('unauthorized-sender');
    return owner;
  }
  function current(sessionGeneration) {
    if (service.snapshot().sessionGeneration !== sessionGeneration) fail('stale-context');
  }
  function replyGate(sender, owner, settingsOnly = false) {
    if (trusted(sender, settingsOnly) !== owner) fail('unauthorized-sender');
  }
  function revalidate(event, owner, sessionGeneration, settingsOnly = true) {
    replyGate(event, owner, settingsOnly);
    current(sessionGeneration);
  }
  function boundary(event, owner, sessionGeneration, operation, settingsOnly = true) {
    return withProgressBarrier(() => {
      revalidate(event, owner, sessionGeneration, settingsOnly);
      return operation();
    });
  }
  function failure(error) {
    const code = error instanceof ProgressError && SAFE_CODES.has(error.code) ? error.code : 'local-operation-failed';
    const snapshot = code === 'unauthorized-sender'
      ? { sessionGeneration: '', viewVersion: 0, scope: 'local', account: null, profiles: [], activeProfile: null, sync: { phase: 'initializing', code: null, lastSuccessAt: null } }
      : service.snapshot();
    return { ok: false, error: { code, messageKey: `progress.error.${code}` }, snapshot };
  }
  const success = value => ({ ok: true, value });
  async function picker(event, owner, command, data) {
    const sessionGeneration = data.sessionGeneration;
    current(sessionGeneration);
    if (command === 'import-backup') {
      const selected = await dialogs.showOpenDialog(owner, { properties: ['openFile'], filters: FILTERS.map(filter => ({ ...filter, extensions: [...filter.extensions] })) });
      revalidate(event, owner, sessionGeneration);
      if (selected.canceled) return success({ canceled: true });
      if (!Array.isArray(selected.filePaths) || selected.filePaths.length !== 1 || typeof selected.filePaths[0] !== 'string' || !path.isAbsolute(selected.filePaths[0])) fail();
      let bytes;
      try { bytes = await readFileBounded(selected.filePaths[0], LIMITS.PORTABLE_ATTACHMENT_BYTES, fs); }
      catch (error) { if (error instanceof ProgressError && error.code === 'limit-exceeded') throw error; fail('local-read-failed'); }
      revalidate(event, owner, sessionGeneration);
      parseBackup(bytes); // Validate the bounded file before freezing renderer edits.
      return boundary(event, owner, sessionGeneration, () => service.importBackup({ sessionGeneration, bytes }));
    }
    const selected = await dialogs.showSaveDialog(owner, { defaultPath: 'genshin-map-overlay-backup.json', filters: FILTERS.map(filter => ({ ...filter, extensions: [...filter.extensions] })) });
    revalidate(event, owner, sessionGeneration);
    if (selected.canceled) return success({ canceled: true });
    if (typeof selected.filePath !== 'string' || !path.isAbsolute(selected.filePath)) fail();
    return boundary(event, owner, sessionGeneration, async () => {
      const exported = await service.exportBackup({ sessionGeneration, profileIds: data.profileIds });
      if (!exported.ok) return exported;
      revalidate(event, owner, sessionGeneration);
      const bytes = Buffer.from(exported.value, 'utf8');
      const backup = parseBackup(bytes);
      const maxBytes = backup.version === 2 ? LIMITS.PORTABLE_ATTACHMENT_BYTES : LIMITS.PORTABLE_BODY_BYTES;
      await atomicWriteFile(selected.filePath, bytes, { maxBytes });
      replyGate(event, owner, true);
      return success(service.snapshot());
    });
  }
  async function profileCommand(event, owner, request) {
    record(request, ['command', 'payload']);
    const { command, payload } = request;
    switch (command) {
      case 'create': {
        record(payload, ['sessionGeneration', 'name', 'region']); generation(payload.sessionGeneration);
        const patch = metadata(payload); current(payload.sessionGeneration);
        return boundary(event, owner, payload.sessionGeneration, () => service.createProfile({ sessionGeneration: payload.sessionGeneration, ...patch }));
      }
      case 'rename': {
        record(payload, ['sessionGeneration', 'profileId'], ['name', 'region']);
        const ctx = context(payload); const patch = metadata(payload); current(ctx.sessionGeneration);
        return service.renameProfile(ctx, patch);
      }
      case 'select': {
        record(payload, ['sessionGeneration', 'profileId']); const ctx = context(payload); current(ctx.sessionGeneration);
        return boundary(event, owner, ctx.sessionGeneration, () => service.selectProfile(ctx));
      }
      case 'import-backup': case 'restore-local': case 'retry-local': {
        record(payload, ['sessionGeneration']); generation(payload.sessionGeneration); current(payload.sessionGeneration);
        const data = { sessionGeneration: payload.sessionGeneration };
        if (command === 'restore-local') return boundary(event, owner, data.sessionGeneration, () => service.restoreLocalBackup(data));
        if (command === 'retry-local') {
          if (typeof retryLocal !== 'function') fail('retry-unavailable');
          return boundary(event, owner, data.sessionGeneration, async () => success(await retryLocal()));
        }
        return picker(event, owner, command, data);
      }
      case 'export-backup': {
        record(payload, ['sessionGeneration', 'profileIds']); generation(payload.sessionGeneration);
        const profileIds = array(payload.profileIds, LIMITS.PROFILES, uuid);
        if (!profileIds.length || new Set(profileIds).size !== profileIds.length) fail();
        current(payload.sessionGeneration);
        const available = new Set(service.snapshot().profiles.map(profile => profile.id));
        if (profileIds.some(id => !available.has(id))) fail();
        return picker(event, owner, command, { sessionGeneration: payload.sessionGeneration, profileIds });
      }
      default: fail();
    }
  }
  async function dispatch(channel, sender, owner, payload) {
    switch (channel) {
      case 'progress:get': empty(payload); return success(service.snapshot());
      case 'profiles:open-settings':
        empty(payload); await openSettings();
        replyGate(sender, owner);
        return success(service.snapshot());
      case 'progress:set-found': {
        record(payload, ['sessionGeneration', 'profileId', 'id', 'found']); const ctx = context(payload);
        if (!Number.isSafeInteger(payload.id) || payload.id <= 0 || typeof payload.found !== 'boolean') fail();
        current(ctx.sessionGeneration);
        return service.setFound(ctx, { id: payload.id, found: payload.found });
      }
      case 'progress:set-preferences': {
        record(payload, ['sessionGeneration', 'profileId'], ['enabledTypes', 'hideFound']); const ctx = context(payload); const patch = preferences(payload);
        current(ctx.sessionGeneration); return service.setPreferences(ctx, patch);
      }
      case 'progress:select-profile': {
        record(payload, ['sessionGeneration', 'profileId']); const ctx = context(payload); current(ctx.sessionGeneration);
        return boundary(sender, owner, ctx.sessionGeneration, () => service.selectProfile(ctx), false);
      }
      case 'profiles:command': return profileCommand(sender, owner, payload);
    }
  }
  for (const channel of CHANNELS) ipcMain.handle(channel, async (event, payload, ...extra) => {
    let sender; let owner;
    const settingsOnly = channel === 'profiles:command';
    try {
      // Keep the initiating identities through every asynchronous completion,
      // including exception handling; later event changes cannot authorize it.
      sender = event && { sender: event.sender, senderFrame: event.senderFrame };
      owner = trusted(sender, settingsOnly);
      if (extra.length) fail();
      const result = await dispatch(channel, sender, owner, payload);
      // Accepted durable work may finish after disposal/navigation. Gate its
      // Result without requiring the old session after intentional activation.
      replyGate(sender, owner, settingsOnly);
      return result;
    } catch (error) {
      try { replyGate(sender, owner, settingsOnly); }
      catch (denied) { return failure(denied); }
      return failure(error);
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerProgressIpc };
