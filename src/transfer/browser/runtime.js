'use strict';
const { parseTransfer, validateTransfer, serializeTransfer, digestTransfer, TRANSFER_LIMITS } = require('../envelope');
const { validateCapability } = require('../capabilities');

/** Browser adapters must expose variantId and independently verify that variant's observed
 * generation/browser/tier on detect. contextFingerprint binds observable account/save and
 * generation continuity; inability to observe continuity must set identityKnown:false.
 * read() must observe verified persistence, never merely the site's in-memory optimistic store.
 * Catalog fingerprints must use the actual accepted envelope projection, not a similar native hash.
 */
/** @typedef {{provider:import('../capabilities').ProviderId,map:string,catalogFingerprint:string,contextFingerprint:string,accountLabel:string|null,saveLabel:string|null,identityKnown:boolean}} BrowserContext */
/** @typedef {{foundIds:string[],fingerprint:string,catalogIds:string[]}} BrowserState */
/** @typedef {{context:BrowserContext,stateFingerprint:string,counts:{add:number,unchanged:number,skipped:number},eligibleIds:string[],coverage:import('../envelope').TransferEnvelope['coverage']}} BrowserPreview */
/** @typedef {{completed:number,total:number,id:string|null}} BrowserProgress */
/** @typedef {{format:'genshin-map-overlay.receipt',version:1,provider:import('../capabilities').ProviderId,map:string,contextFingerprint:string,adapterVersion:string,transferDigest:string,status:'complete'|'partial'|'canceled',confirmed:string[],unchanged:string[],skipped:Array<{id:string,reason:string}>,failed:Array<{id:string,code:string}>,uncertain:string[]}} BrowserReceipt */
/** @typedef {{capability:import('../capabilities').ProviderCapability,variantId:string,detect:()=>Promise<BrowserContext>,read:(context:BrowserContext)=>Promise<BrowserState>,exportProgress:(context:BrowserContext)=>Promise<import('../envelope').TransferEnvelope>,setFound:(context:BrowserContext,id:string,signal:AbortSignal)=>Promise<{status:'persisted'|'uncertain'|'failed',code:string,retryAfterMs?:number}>,restoreProgress?:Function}} BrowserAdapter */
/** @typedef {{chooseFile:()=>Promise<Uint8Array|null>,showContext:(context:BrowserContext)=>void,showPreview:(preview:BrowserPreview)=>void,showProgress:(progress:BrowserProgress)=>void,showReceipt:(receipt:BrowserReceipt)=>void,showError:(code:string)=>void,onApply:(callback:()=>void)=>()=>void,onCancel:(callback:()=>void)=>()=>void,onBackupAcknowledged:(callback:()=>void)=>()=>void,dispose:()=>void}} BrowserUi */
const lockedAdapters = new WeakSet();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
function safeString(value, max = 256) { return typeof value === 'string' && value.length > 0 && Array.from(value).length <= max; }
function contextOf(value) {
  if (!value || !['appsample', 'hoyolab', 'mapgenie', 'kongying', 'bwiki'].includes(value.provider) || !safeString(value.map, 128) || !safeString(value.contextFingerprint) || !safeString(value.catalogFingerprint) || typeof value.identityKnown !== 'boolean' || ![value.accountLabel, value.saveLabel].every(v => v === null || safeString(v))) fail('invalid-context');
  return clone(value);
}
function sameContext(a, b) {
  return b.identityKnown && a.provider === b.provider && a.map === b.map && a.catalogFingerprint === b.catalogFingerprint && a.contextFingerprint === b.contextFingerprint;
}
function stateOf(value) {
  const ids = list => Array.isArray(list) && list.length <= TRANSFER_LIMITS.RECORDS && list.every(id => safeString(id, 128)) && new Set(list).size === list.length;
  if (!value || !ids(value.foundIds) || !ids(value.catalogIds) || !safeString(value.fingerprint)) fail('readback-unavailable');
  return clone(value);
}
// Codes must be inspected fixed adapter literals/allowlists, never server text, even if it matches slug syntax.
const abortCodes = new Set(['access-denied', 'authentication-required', 'logged-out', 'context-changed', 'generation-changed']);
function outcome(value) {
  if (!value || !['persisted', 'uncertain', 'failed'].includes(value.status) || !(typeof value.code === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(value.code)) || (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0))) return { status: 'uncertain', code: 'unknown-response' };
  return value;
}

/** @typedef {{notBefore:number,lastWriteAt:number|null}} BrowserPacingState */
function validatePacingState(value) {
  const time = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
  if (!value || !time(value.notBefore) || (value.lastWriteAt !== null && !time(value.lastWriteAt))) fail('invalid-pacing-state');
  return value;
}
/** @param {{adapter:BrowserAdapter,ui:BrowserUi,download:(name:string,bytes:Uint8Array)=>Promise<void>,sleep:(ms:number)=>Promise<void>,now:()=>number,pacingState?:BrowserPacingState}} options
 * BrowserPreview additionally carries required copied TransferEnvelope coverage.
 * dispose() aborts, removes listeners/UI, and resolves only after in-flight work settles;
 * a replacement console script must await it before creating another runner.
 * Optional pacingState is mutable page-lifecycle-owned state, never transfer/receipt input.
 * Replacements share it by fixed provider/origin scope across account/save changes. A new
 * page cannot inherit a server deadline that it has never observed; adapters must honor new limits.
 */
function createBrowserTransfer({ adapter, ui, download, sleep, now, pacingState = { notBefore: 0, lastWriteAt: null } }) {
  validatePacingState(pacingState);
  let selected = null; let acknowledged = false; let busy = false; let disposed = false;
  let active = null; let pending = null;
  const show = (method, value) => { if (!disposed) ui[method](clone(value)); };
  function capability(context, writing) {
    let c;
    try { c = validateCapability(adapter.capability); } catch { fail('adapter-unverified'); }
    const v = c.variants.find(v => v.id === adapter.variantId);
    if (!v || c.provider !== context.provider || v.map !== context.map || v.catalogFingerprint !== context.catalogFingerprint || v.read !== 'verified' || !v.evidence.reload) fail('adapter-unverified');
    if (writing && (c.status !== 'supported' || v.write !== 'verified' || !v.evidence.pairAccepted || !v.pacing)) fail('adapter-unverified');
    return { version: c.adapterVersion, pacing: v.pacing, signature: JSON.stringify([c.adapterVersion, v]) };
  }
  async function detect() {
    let context;
    try { context = contextOf(await adapter.detect()); } catch { fail('context-unavailable'); }
    show('showContext', context);
    if (!context.identityKnown) fail('identity-unavailable');
    return context;
  }
  async function fresh(captured, writing = true, signature = null) {
    const current = await detect();
    if (!sameContext(captured, current)) fail('context-changed');
    if (signature !== null && capability(current, writing).signature !== signature) fail('adapter-changed');
    capability(current, writing);
    let state;
    try { state = stateOf(await adapter.read(clone(current))); } catch { fail('readback-unavailable'); }
    // A switch while an asynchronous read was pending must not authorize the next write.
    const after = await detect();
    if (!sameContext(captured, after)) fail('context-changed');
    if (signature !== null && capability(after, writing).signature !== signature) fail('adapter-changed');
    capability(after, writing);
    return state;
  }
  function bind(envelope, context) {
    if (envelope.provider !== context.provider || envelope.map !== context.map) fail('file-scope-mismatch');
    if (envelope.catalog.generation === 'unverified' || envelope.catalog.fingerprint === 'unverified' || !/^[a-f0-9]{64}$/.test(envelope.catalog.fingerprint) || envelope.catalog.fingerprint !== context.catalogFingerprint) fail('catalog-mismatch');
  }
  function plan(envelope, context, state) {
    const found = new Set(state.foundIds); const catalog = new Set(state.catalogIds);
    const eligibleIds = []; const unchanged = []; const skipped = [];
    for (const row of envelope.records) {
      if (!row.state) skipped.push({ id: row.id, reason: 'not-found-observation' });
      else if (!catalog.has(row.id)) skipped.push({ id: row.id, reason: 'outside-catalog' });
      else if (found.has(row.id)) unchanged.push(row.id);
      else eligibleIds.push(row.id);
    }
    return { preview: { context: clone(context), stateFingerprint: state.fingerprint, counts: { add: eligibleIds.length, unchanged: unchanged.length, skipped: skipped.length }, eligibleIds, coverage: clone(envelope.coverage) }, unchanged, skipped };
  }
  async function backup(context, state) {
    let envelope;
    try { envelope = validateTransfer(await adapter.exportProgress(clone(context))); bind(envelope, context); } catch { fail('backup-unavailable'); }
    const backedUp = new Set(envelope.records.filter(r => r.state).map(r => r.id));
    if (state.foundIds.some(id => !backedUp.has(id))) fail('backup-incomplete');
    try { await download('genshin-' + context.provider + '-destination-backup.json', serializeTransfer(envelope)); } catch { fail('backup-download-failed'); }
  }
  function exclusive(work) {
    if (disposed) return Promise.reject(Object.assign(new Error('transfer-disposed'), { code: 'transfer-disposed' }));
    if (busy || lockedAdapters.has(adapter)) return Promise.reject(Object.assign(new Error('transfer-busy'), { code: 'transfer-busy' }));
    busy = true; lockedAdapters.add(adapter);
    pending = Promise.resolve().then(work).finally(() => { busy = false; lockedAdapters.delete(adapter); active = null; });
    return pending;
  }
  async function previewWork(bytes) {
    selected = null; acknowledged = false;
    const envelope = parseTransfer(bytes); const context = await detect();
    bind(envelope, context); const cap = capability(context, true);
    const state = await fresh(context, true, cap.signature); const digest = await digestTransfer(envelope);
    await backup(context, state);
    const planned = plan(envelope, context, state);
    selected = { envelope, context, digest, version: cap.version, signature: cap.signature, stateFingerprint: state.fingerprint, planned, used: false };
    show('showPreview', planned.preview); return clone(planned.preview);
  }
  function receiptCheck(value, s) {
    // A receipt is a report, never authority for IDs or write eligibility.
    if (!value || value.format !== 'genshin-map-overlay.receipt' || value.version !== 1 || value.provider !== s.context.provider || value.map !== s.context.map || value.contextFingerprint !== s.context.contextFingerprint || value.adapterVersion !== s.version || value.transferDigest !== s.digest) fail('receipt-mismatch');
  }
  async function run(external, resuming) {
    const s = selected;
    if (!s || (!resuming && s.used)) fail('preview-required');
    if (!acknowledged) fail('backup-acknowledgement-required');
    if (resuming) receiptCheck(resuming, s);
    active = new AbortController();
    const cancel = () => active?.abort();
    if (external?.aborted) active.abort();
    external?.addEventListener('abort', cancel, { once: true });
    const runSignal = active.signal;
    try {
      let state;
      try {
        state = await fresh(s.context, true, s.signature);
        if (!resuming && state.fingerprint !== s.stateFingerprint) fail('state-changed');
      } catch (error) { selected = null; acknowledged = false; throw error; }
      // Resuming is always a fresh plan. Prior confirmed/failed IDs are not trusted.
      const p = plan(s.envelope, s.context, state); s.used = true;
      const receipt = { format: 'genshin-map-overlay.receipt', version: 1, provider: s.context.provider, map: s.context.map, contextFingerprint: s.context.contextFingerprint, adapterVersion: s.version, transferDigest: s.digest, status: 'partial', confirmed: [], unchanged: p.unchanged, skipped: p.skipped, failed: [], uncertain: [] };
      const pacing = capability(s.context, true).pacing;
      const ids = p.preview.eligibleIds; let stop = null; let canceled = false;
      show('showProgress', { completed: 0, total: ids.length, id: null });
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        if (runSignal.aborted) { stop = 'canceled'; canceled = true; }
        if (stop) { receipt.skipped.push({ id, reason: stop }); continue; }
        let classification = null; let retryDelay = 0;
        for (let attempt = 1; attempt <= pacing.maxAttempts; attempt++) {
          if (runSignal.aborted) { stop = 'canceled'; canceled = true; break; }
          try {
            validatePacingState(pacingState);
            const cooldown = pacingState.notBefore - now();
            if (cooldown > pacing.maxBackoffMs) { stop = 'resume-required'; show('showError', 'resume-required'); break; }
            const wait = Math.max(retryDelay, cooldown, pacingState.lastWriteAt === null ? 0 : pacing.minIntervalMs - (now() - pacingState.lastWriteAt), 0);
            if (wait) await sleep(wait);
            if (runSignal.aborted) { stop = 'canceled'; canceled = true; break; }
            // Each operation and every retry rechecks the observed context and durable state.
            state = await fresh(s.context, true, s.signature);
            if (!state.catalogIds.includes(id)) { stop = 'context-changed'; break; }
            if (state.foundIds.includes(id)) { classification = 'unchanged'; break; }
          } catch (error) { stop = error.code === 'readback-unavailable' ? 'readback-unavailable' : 'context-changed'; break; }
          if (runSignal.aborted) { stop = 'canceled'; canceled = true; break; }
          let result;
          pacingState.lastWriteAt = now();
          try { result = outcome(await adapter.setFound(clone(s.context), id, runSignal)); }
          catch (error) { result = { status: 'uncertain', code: abortCodes.has(error?.code) ? error.code : 'transient' }; }
          if (result.retryAfterMs !== undefined) pacingState.notBefore = Math.max(pacingState.notBefore, Math.min(Number.MAX_SAFE_INTEGER, now() + result.retryAfterMs));
          // Even cancellation cannot skip readback of a write that may have persisted.
          try { state = await fresh(s.context, true, s.signature); }
          catch (error) { classification = 'uncertain'; stop = error.code === 'readback-unavailable' ? 'readback-unavailable' : 'context-changed'; break; }
          if (state.foundIds.includes(id)) { classification = 'confirmed'; if (abortCodes.has(result.code)) stop = result.code; break; }
          if (runSignal.aborted) { classification = result.status === 'failed' ? { code: result.code } : 'uncertain'; stop = 'canceled'; canceled = true; break; }
          if (result.retryAfterMs > pacing.maxBackoffMs) { classification = result.status === 'failed' ? { code: 'retry-after-exceeds-bound' } : 'uncertain'; stop = 'resume-required'; show('showError', 'resume-required'); break; }
          const retry = ['transient', 'rate-limited'].includes(result.code);
          if (!retry || attempt === pacing.maxAttempts) {
            classification = result.status === 'failed' ? { code: result.code } : 'uncertain';
            if (result.status !== 'failed' || !retry) stop = result.status === 'failed' || result.code === 'unknown-response' || abortCodes.has(result.code) ? result.code : 'write-uncertain';
            break;
          }
          retryDelay = Math.max(result.retryAfterMs || 0, Math.min(1000 * 2 ** (attempt - 1), pacing.maxBackoffMs));
        }
        if (typeof classification === 'string') receipt[classification].push(id);
        else if (classification) receipt.failed.push({ id, code: classification.code });
        else receipt.skipped.push({ id, reason: stop || 'resume-required' });
        show('showProgress', { completed: index + 1, total: ids.length, id });
      }
      // Later operations/cloud synchronization can invalidate an earlier observation.
      // Reconcile the final durable set before declaring completion; never trust a receipt.
      if ((receipt.confirmed.length || receipt.unchanged.length) && !['context-changed', 'readback-unavailable'].includes(stop)) {
        try {
          const final = new Set((await fresh(s.context, true, s.signature)).foundIds);
          const lost = receipt.confirmed.filter(id => !final.has(id));
          receipt.confirmed = receipt.confirmed.filter(id => final.has(id));
          receipt.uncertain.push(...lost);
          const changed = receipt.unchanged.filter(id => !final.has(id));
          receipt.unchanged = receipt.unchanged.filter(id => final.has(id));
          receipt.skipped.push(...changed.map(id => ({ id, reason: 'destination-state-changed' })));
          if (changed.length) stop = stop || 'destination-state-changed';
        } catch {
          receipt.uncertain.push(...receipt.confirmed); receipt.confirmed = [];
          receipt.skipped.push(...receipt.unchanged.map(id => ({ id, reason: 'readback-unavailable' }))); receipt.unchanged = [];
          stop = stop || 'readback-unavailable';
        }
      }
      if (runSignal.aborted) canceled = true;
      receipt.status = canceled ? 'canceled' : receipt.failed.length || receipt.uncertain.length || stop ? 'partial' : 'complete';
      show('showReceipt', receipt);
      try { await download('genshin-' + s.context.provider + '-transfer-receipt.json', new TextEncoder().encode(JSON.stringify(receipt, null, 2))); }
      catch { show('showError', 'receipt-download-failed'); }
      return clone(receipt);
    } finally { external?.removeEventListener('abort', cancel); }
  }
  const api = {
    exportProgress: () => exclusive(async () => {
      const context = await detect(); capability(context, false);
      const envelope = validateTransfer(await adapter.exportProgress(clone(context))); bind(envelope, context);
      if (!sameContext(context, await detect())) fail('context-changed');
      await download('genshin-' + context.provider + '-progress.json', serializeTransfer(envelope));
    }),
    preview: bytes => exclusive(() => previewWork(bytes)),
    acknowledgeBackup() { if (selected && !busy && !disposed) acknowledged = true; },
    apply: signal => exclusive(() => run(signal, null)),
    resume: (receipt, signal) => exclusive(() => run(signal, receipt)),
    dispose() {
      disposed = true; active?.abort(); for (const unsubscribe of listeners) unsubscribe(); ui.dispose();
      return pending ? pending.catch(() => {}) : Promise.resolve();
    },
  };
  const listeners = [
    ui.onBackupAcknowledged(() => api.acknowledgeBackup()),
    ui.onCancel(() => active?.abort()),
    ui.onApply(() => { api.apply().catch(error => show('showError', ['preview-required', 'backup-acknowledgement-required', 'state-changed', 'context-changed', 'identity-unavailable', 'transfer-busy'].includes(error.code) ? error.code : 'transfer-unavailable')); }),
  ];
  return api;
}
module.exports = { createBrowserTransfer };
