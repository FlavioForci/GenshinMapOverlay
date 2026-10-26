'use strict';
const { randomUUID } = require('node:crypto');
const { parseTransfer, digestTransfer } = require('./envelope');
const { mergeAttachment } = require('./attachments');
const { planImport, planExport } = require('./planner');
const { getProvider } = require('./registry');
const { ProgressError, LIMITS } = require('../progress/schema');
const { createProfile, setFound } = require('../progress/profiles');
const pkg = require('../../package.json');
const TTL = 15 * 60 * 1000;
const APPLY_CODES = new Set(['invalid-command', 'stale-context', 'stale-preview', 'duplicate-import', 'service-closed', 'not-initialized', 'local-operation-failed', 'local-recovery-required', 'local-read-failed', 'local-write-failed', 'local-backup-failed', 'local-durability-uncertain', 'limit-exceeded', 'invalid-envelope', 'invalid-state', 'invalid-profile', 'clock-exhausted', 'revision-exhausted', 'unsupported-version']);
const fail = code => { throw new ProgressError(code); };
function input(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-command');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key];
    if ((!required.includes(key) && !optional.includes(key)) || !d.enumerable || !Object.hasOwn(d, 'value')) fail('invalid-command');
  }
  if (!required.every(key => Object.hasOwn(value, key))) fail('invalid-command');
}
function destinations(envelope, digest) {
  return Object.entries(envelope.extensions?.transfer.profiles || {}).filter(([, attachment]) => attachment.imports.some(receipt => receipt.digest === digest && receipt.createdProfile)).map(([id]) => ({ id, name: envelope.state.profiles[id].name.value }));
}
const signature = plan => JSON.stringify({ decisions: plan.decisions, foundIds: plan.foundIds, counts: plan.counts });
/** @typedef {{id:string,context:import('../progress/service').Context,revision:number,catalogFingerprint:string,digest:string,counts:import('./planner').Counts,coverage:import('./envelope').TransferEnvelope['coverage'],priorDestinations:Array<{id:string,name:string}>,canApply:boolean}} ImportPreview */
/** Electron-free main controller. Construct one per settings window. Main composition
 * must run preview/apply/export through its existing withProgressBarrier, outside
 * the service queue, and repeat frame/context checks after renderer drain.
 */
class TransferController {
  constructor({ progress, getCatalog, getMapping, uuid = randomUUID, now = Date.now }) {
    if (!progress || typeof progress.readTransferState !== 'function' || [getCatalog, getMapping, uuid, now].some(fn => typeof fn !== 'function')) fail('invalid-command');
    this.progress = progress; this.getCatalog = getCatalog; this.getMapping = getMapping; this.uuid = uuid; this.now = now;
    // A single private slot bounds large parsed files/plans per settings window.
    this.preview = null;
    this.preparation = 0;
  }
  /** Main-only lifecycle hook. Trusted routing/catalog changes revoke all pending authority. */
  invalidatePreview() { this.preparation++; this.preview = null; }
  /** Main-only report read; no token internals or raw file escape to IPC.
   * @param {import('../progress/service').Context} context @param {string} previewId
   * @returns {Promise<import('./planner').TransferReport>}
   */
  async readImportReport(context, previewId) {
    input(context, ['sessionGeneration', 'profileId']);
    const token = this.preview;
    const check = () => {
      if (!token || this.preview !== token || typeof previewId !== 'string' || token.public.id !== previewId || this.now() >= token.expiresAt || this.getCatalog().fingerprint !== token.public.catalogFingerprint) fail('stale-preview');
      if (context.sessionGeneration !== token.public.context.sessionGeneration || context.profileId !== token.public.context.profileId) fail('stale-context');
    };
    check();
    const read = await this.progress.readTransferState(context); check();
    if (read.envelope.revision !== token.public.revision) fail('stale-preview');
    const plan = planImport(token.envelope, token.mode === 'new' ? { markers: {} } : read.profile, this.getCatalog(), this.getMapping(token.envelope.provider, token.envelope.map));
    if (signature(plan) !== token.signature) fail('stale-preview');
    return structuredClone({ format: 'genshin-map-overlay.transfer-report', version: 1, provider: token.envelope.provider, map: token.envelope.map, counts: plan.counts, coverage: token.envelope.coverage, decisions: plan.decisions });
  }
  /** @param {import('../progress/service').Context} context @param {{bytes:Buffer,mode:'new'|'merge',name?:string,region?:string}} options @returns {Promise<ImportPreview>} */
  async previewImport(context, options) {
    // A new attempt, including invalid input, invalidates an older preview.
    const preparation = ++this.preparation; this.preview = null;
    input(options, ['bytes', 'mode'], ['name', 'region']);
    if (!Buffer.isBuffer(options.bytes) || !['new', 'merge'].includes(options.mode)) fail('invalid-command');
    const { mode } = options;
    const name = options.name ?? 'Imported progress', region = options.region ?? '';
    if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > LIMITS.NAME_CODE_POINTS || typeof region !== 'string' || Array.from(region).length > LIMITS.REGION_CODE_POINTS) fail('invalid-command');
    const envelope = parseTransfer(options.bytes);
    const read = await this.progress.readTransferState(context);
    const catalog = this.getCatalog(); const pack = this.getMapping(envelope.provider, envelope.map);
    const plan = planImport(envelope, mode === 'new' ? { markers: {} } : read.profile, catalog, pack);
    const digest = await digestTransfer(envelope);
    const priorDestinations = destinations(read.envelope, digest);
    if (preparation !== this.preparation) fail('stale-preview');
    const id = this.uuid();
    if (typeof id !== 'string' || !id.length) fail('invalid-command');
    const preview = { id, context: { ...context }, revision: read.envelope.revision, catalogFingerprint: catalog.fingerprint, digest, counts: plan.counts, coverage: envelope.coverage, priorDestinations, canApply: mode === 'merge' || priorDestinations.length === 0 };
    this.preview = { public: structuredClone(preview), envelope, signature: signature(plan), mode, name: name.trim(), region, expiresAt: this.now() + TTL };
    return structuredClone(preview);
  }
  /** @param {import('../progress/service').Context} context @param {{previewId:string,createAnother?:boolean}} options @returns {Promise<import('../progress/service').Result<{snapshot:import('../progress/service').PublicSnapshot,receipt:import('./attachments').ImportReceipt}>>} */
  async applyImport(context, options) {
    let token;
    try {
      input(options, ['previewId'], ['createAnother']);
      input(context, ['sessionGeneration', 'profileId']);
      if (typeof options.previewId !== 'string' || (Object.hasOwn(options, 'createAnother') && typeof options.createAnother !== 'boolean')) fail('invalid-command');
      token = this.preview;
      if (!token || token.public.id !== options.previewId) fail('stale-preview');
      const p = token.public;
      if (context.sessionGeneration !== p.context.sessionGeneration || context.profileId !== p.context.profileId) fail('stale-context');
      const check = () => {
        if (this.preview !== token || this.now() >= token.expiresAt || this.getCatalog().fingerprint !== p.catalogFingerprint) fail('stale-preview');
      };
      check();
      const read = await this.progress.readTransferState(context);
      check();
      if (read.envelope.revision !== p.revision) fail('stale-preview');
      if (token.mode === 'new' && destinations(read.envelope, p.digest).length && !options.createAnother) fail('duplicate-import');
      const compatiblePlan = () => {
        check();
        const plan = planImport(token.envelope, token.mode === 'new' ? { markers: {} } : read.profile, this.getCatalog(), this.getMapping(token.envelope.provider, token.envelope.map));
        if (signature(plan) !== token.signature) fail('stale-preview');
        return plan;
      };
      let receipt;
      await this.progress.runProfileTransaction(context, { reason: 'import', expectedRevision: p.revision }, (draft, actor) => {
        const plan = compatiblePlan();
        const id = token.mode === 'new' ? this.uuid() : context.profileId;
        if (token.mode === 'new') createProfile(draft, { id, name: token.name, region: token.region }, actor);
        for (const canonicalId of plan.foundIds) setFound(draft, { profileId: id, id: Number(canonicalId), found: true }, actor);
        const previous = draft.extensions?.transfer.profiles[id];
        // Preserve the first receipt, including original counts, on digest replay.
        receipt = previous?.imports.find(row => row.digest === p.digest) || { digest: p.digest, provider: token.envelope.provider, map: token.envelope.map, counts: plan.counts, createdProfile: token.mode === 'new' };
        plan.attachment.imports = previous?.imports.some(row => row.digest === p.digest) ? [] : [receipt];
        const attachment = mergeAttachment(previous, plan.attachment);
        if (!draft.extensions) draft.extensions = { transfer: { version: 1, profiles: {} } };
        draft.extensions.transfer.profiles[id] = attachment;
        if (token.mode === 'new') draft.selectedProfileId = id;
      }, () => { compatiblePlan(); });
      this.preview = null;
      return { ok: true, value: { snapshot: this.progress.snapshot(), receipt: structuredClone(receipt) } };
    } catch (error) {
      const code = error.code === 'revision-conflict' ? 'stale-preview' : APPLY_CODES.has(error.code) ? error.code : 'local-operation-failed';
      // A failed disk operation needs a refreshed preview even if reconciliation
      // discovers that rename already installed the whole transaction.
      if (code !== 'duplicate-import' && this.preview === token) this.preview = null;
      return { ok: false, error: { code, messageKey: `progress.error.${code}` }, snapshot: this.progress.snapshot() };
    }
  }
  /** @param {import('../progress/service').Context} context @param {{provider:string,map:string}} options @returns {Promise<{envelope:import('./envelope').TransferEnvelope,report:import('./planner').TransferReport}>} */
  async exportProfile(context, options) {
    input(options, ['provider', 'map']);
    const provider = getProvider(options.provider);
    const read = await this.progress.readTransferState(context);
    return planExport(read.profile, read.envelope.extensions?.transfer.profiles[context.profileId], { ...options, catalog: this.getCatalog(), pack: this.getMapping(options.provider, options.map), metadata: { producer: { name: pkg.name, version: pkg.version }, exportedAt: new Date(this.now()).toISOString(), adapterVersion: provider.adapterVersion } });
  }
}
module.exports = { TransferController };
