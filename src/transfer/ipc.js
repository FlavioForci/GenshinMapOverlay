'use strict';
const path = require('node:path');
const { ProgressError } = require('../progress/schema');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const { readFileBounded, atomicWriteFile } = require('../progress/atomic-file');
const { parseTransfer, serializeTransfer, TRANSFER_LIMITS, TransferValidationError } = require('./envelope');
const { listProviders, getProvider } = require('./registry');
const CHANNELS = ['providers', 'previewImport', 'applyImport', 'exportProfile', 'saveScript', 'saveReport'].map(name => 'transfer:' + name);
const CODES = new Set(['invalid-command', 'unauthorized-sender', 'stale-context', 'stale-preview', 'provider-mismatch', 'unknown-provider', 'invalid-transfer', 'transfer-too-large', 'limit-exceeded', 'duplicate-import', 'catalog-unavailable', 'service-closed', 'not-initialized', 'local-operation-failed', 'local-recovery-required', 'local-read-failed', 'local-write-failed', 'local-backup-failed', 'local-durability-uncertain', 'invalid-envelope', 'invalid-state', 'invalid-profile', 'clock-exhausted', 'revision-exhausted', 'unsupported-version']);
const fail = (code = 'invalid-command') => { throw new ProgressError(code); };
function record(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail();
  }
  if (!required.every(key => Object.hasOwn(value, key))) fail();
}
function context(value) {
  record(value, ['sessionGeneration', 'profileId']);
  if (typeof value.sessionGeneration !== 'string' || value.sessionGeneration.length < 1 || value.sessionGeneration.length > 128 || typeof value.profileId !== 'string' || !UUID.test(value.profileId)) fail();
  return { sessionGeneration: value.sessionGeneration, profileId: value.profileId };
}
function token(value) { if (typeof value !== 'string' || !value.length || value.length > 128) fail(); return value; }
function name(value) { if (typeof value !== 'string' || value.length > 160 || !value.trim() || Array.from(value.trim()).length > 80) fail(); return value.trim(); }
const FILTERS = [{ name: 'JSON', extensions: ['json'] }];
const ok = value => ({ ok: true, value });
/** @template T
 * @typedef {import('../progress/service').Result<T> & {validation?:{invalidCount:number,issues:Array<{recordIndex:number|null,code:string}>}}} TransferResult
 */
/** Main-owned native routing. No renderer-supplied paths, scripts, packs, callbacks or bytes.
 * withProgressBarrier MUST be main's overlay-only intention barrier, outside ProgressService.
 */
function registerTransferIpc({ ipcMain, controller, getSettingsWindow, dialogs, getScript, withProgressBarrier = operation => operation() }) {
  let disposed = false; let ownership = null; let generation = 0;
  const subscriptions = new Map();
  function live(owner) { return owner && !owner.isDestroyed() && owner.webContents && !owner.webContents.isDestroyed(); }
  function trusted(event, owner = getSettingsWindow()) {
    if (disposed || !live(owner) || owner !== getSettingsWindow() || event?.sender !== owner.webContents || event?.senderFrame !== owner.webContents.mainFrame) fail('unauthorized-sender');
    return owner;
  }
  function current(ctx) {
    const snapshot = controller.progress.snapshot();
    if (snapshot.sessionGeneration !== ctx.sessionGeneration || snapshot.activeProfile?.id !== ctx.profileId) fail('stale-context');
  }
  function revoke() { generation++; ownership = null; controller.invalidatePreview(); }
  function observe(owner) {
    if (subscriptions.has(owner)) return;
    const invalidate = () => { if (ownership?.owner === owner) revoke(); };
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame !== false) invalidate(); };
    const closed = () => { invalidate(); subscriptions.get(owner)?.(); subscriptions.delete(owner); };
    const pairs = [[owner, 'closed', closed], [owner.webContents, 'destroyed', invalidate], [owner.webContents, 'render-process-gone', invalidate], [owner.webContents, 'did-start-navigation', navigation]];
    for (const [target, event, listener] of pairs) target.on(event, listener);
    subscriptions.set(owner, () => { for (const [target, event, listener] of pairs) target.removeListener(event, listener); });
  }
  function gate(event, owner, ctx) { trusted(event, owner); if (ctx) current(ctx); }
  function boundary(event, owner, ctx, fn) { return withProgressBarrier(() => { gate(event, owner, ctx); return fn(); }); }
  function owned(event, owner, id) {
    if (!ownership || ownership.owner !== owner || ownership.frame !== event.senderFrame || ownership.id !== id) fail('stale-preview');
    return ownership;
  }
  function failure(error) {
    const code = CODES.has(error?.code) ? error.code : 'local-operation-failed';
    const result = { ok: false, error: { code, messageKey: 'transfer.error.' + code } };
    if (error instanceof TransferValidationError) result.validation = { invalidCount: Math.min(TRANSFER_LIMITS.RECORDS, Math.max(1, error.invalidCount)), issues: error.issues.slice(0, 100).map(issue => ({ recordIndex: Number.isSafeInteger(issue.recordIndex) && issue.recordIndex >= 0 && issue.recordIndex < TRANSFER_LIMITS.RECORDS ? issue.recordIndex : null, code: ['invalid-record', 'invalid-transfer', 'transfer-too-large'].includes(issue.code) ? issue.code : 'invalid-transfer' })) };
    return result;
  }
  async function chooseSave(event, owner, ctx, defaultPath, filters = FILTERS) {
    const selected = await dialogs.showSaveDialog(owner, { defaultPath, filters }); gate(event, owner, ctx);
    if (selected.canceled) return null;
    if (typeof selected.filePath !== 'string' || !path.isAbsolute(selected.filePath) || selected.filePath.includes('\0')) fail();
    return selected.filePath;
  }
  async function write(file, bytes, maximum = TRANSFER_LIMITS.BYTES) { await atomicWriteFile(file, bytes, { maxBytes: maximum }); }
  async function dispatch(channel, event, owner, args) {
    switch (channel) {
      case 'transfer:providers': if (args.length) fail(); return listProviders();
      case 'transfer:previewImport': {
        // Trusted new attempts, including cancellation and malformed options, revoke older tokens.
        revoke(); observe(owner);
        if (args.length !== 2) fail(); const ctx = context(args[0]); const options = args[1];
        record(options, ['provider', 'mode'], ['name', 'region']); getProvider(options.provider);
        if (!['new', 'merge'].includes(options.mode)) fail();
        if (Object.hasOwn(options, 'name')) name(options.name);
        if (Object.hasOwn(options, 'region') && (typeof options.region !== 'string' || options.region.length > 160 || Array.from(options.region).length > 80)) fail();
        current(ctx); const ticket = generation;
        ownership = { owner, frame: event.senderFrame, ctx, id: null };
        const check = () => { gate(event, owner, ctx); if (ticket !== generation) fail('stale-preview'); };
        const selected = await dialogs.showOpenDialog(owner, { properties: ['openFile'], filters: FILTERS }); check();
        if (selected.canceled) { revoke(); return ok(null); }
        if (!Array.isArray(selected.filePaths) || selected.filePaths.length !== 1 || typeof selected.filePaths[0] !== 'string' || !path.isAbsolute(selected.filePaths[0]) || selected.filePaths[0].includes('\0')) fail();
        let bytes;
        try { bytes = await readFileBounded(selected.filePaths[0], TRANSFER_LIMITS.BYTES); } catch (error) { if (error.code === 'limit-exceeded') throw new TransferValidationError('transfer-too-large', 1, [{ recordIndex: null, code: 'transfer-too-large' }]); fail('local-read-failed'); }
        check(); const envelope = parseTransfer(bytes);
        if (envelope.provider !== options.provider) fail('provider-mismatch');
        const value = await boundary(event, owner, ctx, async () => { check(); const { provider, ...local } = options; return controller.previewImport(ctx, { ...local, bytes }); });
        check(); ownership = { owner, frame: event.senderFrame, ctx, id: value.id }; return ok(value);
      }
      case 'transfer:applyImport': {
        if (args.length !== 2) fail(); const ctx = context(args[0]); record(args[1], ['previewId'], ['createAnother']); token(args[1].previewId);
        if (Object.hasOwn(args[1], 'createAnother') && typeof args[1].createAnother !== 'boolean') fail();
        const captured = owned(event, owner, args[1].previewId); current(ctx);
        if (ctx.sessionGeneration !== captured.ctx.sessionGeneration || ctx.profileId !== captured.ctx.profileId) fail('stale-context');
        const result = await boundary(event, owner, ctx, () => { owned(event, owner, args[1].previewId); return controller.applyImport(ctx, args[1]); });
        if (ownership === captured && (result.ok || result.error?.code !== 'duplicate-import')) ownership = null;
        return result.ok ? result : { ...result, error: failure(result.error).error };
      }
      case 'transfer:exportProfile': {
        if (args.length !== 2) fail(); const ctx = context(args[0]); const options = args[1]; record(options, ['provider', 'map']); const provider = getProvider(options.provider);
        if (!provider.variants.some(variant => variant.map === options.map)) fail(); current(ctx);
        const file = await chooseSave(event, owner, ctx, options.provider + '-progress.json'); if (!file) return ok(null);
        return boundary(event, owner, ctx, async () => { const exported = await controller.exportProfile(ctx, options); gate(event, owner, ctx); await write(file, Buffer.from(serializeTransfer(exported.envelope))); gate(event, owner, ctx); return ok(exported.report); });
      }
      case 'transfer:saveScript': {
        if (args.length !== 2) fail(); const [provider, direction] = args; getProvider(provider); if (!['export', 'import'].includes(direction)) fail();
        const file = await chooseSave(event, owner, null, provider + '-' + direction + '.js', [{ name: 'JavaScript', extensions: ['js'] }]); if (!file) return ok(null);
        const bytes = await getScript(provider, direction); trusted(event, owner);
        if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) fail('limit-exceeded');
        await write(file, bytes, 2 * 1024 * 1024); return ok(null);
      }
      case 'transfer:saveReport': {
        if (args.length !== 1) fail(); const id = token(args[0]); const captured = owned(event, owner, id); current(captured.ctx);
        const file = await chooseSave(event, owner, captured.ctx, 'transfer-report.json'); if (!file) return ok(null);
        return boundary(event, owner, captured.ctx, async () => { owned(event, owner, id); const report = await controller.readImportReport(captured.ctx, id); gate(event, owner, captured.ctx); await write(file, Buffer.from(JSON.stringify(report, null, 2))); gate(event, owner, captured.ctx); return ok(null); });
      }
    }
  }
  for (const channel of CHANNELS) ipcMain.handle(channel, async (event, ...args) => {
    const captured = event && { sender: event.sender, senderFrame: event.senderFrame }; let owner;
    try {
      owner = trusted(captured);
      const result = await dispatch(channel, captured, owner, args);
      trusted(captured, owner); return result;
    } catch (error) {
      try { trusted(captured, owner); } catch (denied) { return failure(denied); }
      return failure(error);
    }
  });
  return () => { if (disposed) return; disposed = true; revoke(); for (const clean of subscriptions.values()) clean(); subscriptions.clear(); for (const channel of CHANNELS) ipcMain.removeHandler(channel); };
}
module.exports = { registerTransferIpc };
