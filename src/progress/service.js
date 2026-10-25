'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProgressError } = require('./schema');
const { foundIds } = require('./merge');
const { migrateLegacy } = require('./migration');
const commands = require('./profiles');
const backups = require('./backup');
const LOCAL = Object.freeze({ kind: 'local' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_CODES = new Set([
  'invalid-command', 'invalid-profile', 'profile-not-found', 'invalid-backup', 'unsupported-version', 'limit-exceeded',
  'invalid-clock', 'clock-exhausted', 'revision-exhausted', 'invalid-envelope', 'invalid-state', 'invalid-mutation',
  'local-recovery-required', 'local-read-failed', 'local-write-failed', 'local-backup-failed', 'local-durability-uncertain',
  'invalid-installation', 'unsupported-scope', 'invalid-scope', 'stale-context', 'revision-conflict', 'service-closed',
  'not-initialized', 'local-operation-failed',
]);
const DISK_CODES = new Set(['local-recovery-required', 'local-read-failed', 'local-write-failed', 'local-backup-failed', 'local-durability-uncertain', 'unsupported-version']);
function fail(code) { throw new ProgressError(code); }
function safeError(error) { return new ProgressError(error instanceof ProgressError && SAFE_CODES.has(error.code) ? error.code : 'local-operation-failed'); }
function input(value, required, optional = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid-command');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if ((!required.includes(key) && !optional.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-command');
  }
  if (!required.every(key => Object.hasOwn(value, key))) fail('invalid-command');
  return value;
}
function copyPatch(value, required, optional = []) { input(value, required, optional); return structuredClone(value); }

/** @typedef {{sessionGeneration:string,profileId:string}} Context */
/** @typedef {{sessionGeneration:string,viewVersion:number,scope:'local',account:null,profiles:Array<{id:string,name:string,region:string}>,activeProfile:{id:string,name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}|null,sync:{phase:string,code:string|null,lastSuccessAt:null}}} PublicSnapshot */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{code:string,messageKey:string},snapshot:PublicSnapshot}} Result */

/**
 * Main-process owner of local progress. Selection and commands share this queue;
 * no renderer can supply draft callbacks. Public phases are initializing, local,
 * recovery. Recovery snapshots are read-only, including any previously durable
 * displayed profile. Only initialize retry or explicit restore can clear it.
 */
class ProgressService {
  constructor({ repository, uuid = randomUUID, onSnapshot = () => {} }) {
    if (!repository || typeof uuid !== 'function' || typeof onSnapshot !== 'function') fail('invalid-command');
    this.repository = repository;
    this.uuid = uuid;
    this.onSnapshot = onSnapshot;
    this.tail = Promise.resolve();
    this.envelope = null;
    this.actor = null;
    this.userData = null;
    this.sessionGeneration = this._uuid();
    this.viewVersion = 0;
    this.phase = 'initializing';
    this.code = null;
    this.closing = false;
    this.shutdownPromise = null;
    this.pendingRestoreActivation = false;
  }

  _uuid() {
    const id = this.uuid();
    if (typeof id !== 'string' || !UUID.test(id)) fail('invalid-command');
    return id;
  }
  _rotate() {
    const next = this._uuid();
    if (next === this.sessionGeneration) fail('invalid-command');
    this.sessionGeneration = next;
  }
  _enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  /** Return detached display data; no persistence/register/actor/path information. @returns {PublicSnapshot} */
  snapshot() {
    const profiles = this.envelope ? Object.entries(this.envelope.state.profiles).map(([id, p]) => ({ id, name: p.name.value, region: p.region.value })) : [];
    const id = this.envelope && this.envelope.selectedProfileId;
    const active = id && this.envelope.state.profiles[id];
    return {
      sessionGeneration: this.sessionGeneration, viewVersion: this.viewVersion, scope: 'local', account: null, profiles,
      activeProfile: active ? { id, name: active.name.value, region: active.region.value, foundIds: foundIds(active), enabledTypes: [...active.enabledTypes.value], hideFound: active.hideFound.value } : null,
      sync: { phase: this.phase, code: this.code, lastSuccessAt: null },
    };
  }
  _publish() {
    this.viewVersion++;
    const snapshot = this.snapshot();
    // Persistence already succeeded. A consumer exception must never become a
    // false disk failure or poison later commands; async consumer rejections are
    // isolated too. Consumers receive their own detached snapshot.
    try {
      const returned = this.onSnapshot(snapshot);
      if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => {});
    } catch { /* Notification failures do not change committed state. */ }
  }
  _usable(envelope) {
    return envelope.migrationComplete && envelope.selectedProfileId !== null && Object.hasOwn(envelope.state.profiles, envelope.selectedProfileId);
  }
  _adopt(envelope, rotate = false) {
    if (!this._usable(envelope)) fail('local-recovery-required');
    if (rotate || this.pendingRestoreActivation || !this.envelope || this.envelope.selectedProfileId !== envelope.selectedProfileId) this._rotate();
    this.envelope = structuredClone(envelope);
    this.pendingRestoreActivation = false;
    this.phase = 'local'; this.code = null;
    this._publish();
  }
  _recover(code) { this.phase = 'recovery'; this.code = code; this._publish(); }
  _context(context, mode) {
    input(context, mode === 'generation' ? ['sessionGeneration'] : ['sessionGeneration', 'profileId']);
    if (typeof context.sessionGeneration !== 'string' || context.sessionGeneration !== this.sessionGeneration) fail('stale-context');
    if (mode !== 'generation') {
      if (typeof context.profileId !== 'string' || !UUID.test(context.profileId)) fail('invalid-command');
      if (mode === 'active' && (!this.envelope || context.profileId !== this.envelope.selectedProfileId)) fail('stale-context');
      if (mode === 'target' && (!this.envelope || !Object.hasOwn(this.envelope.state.profiles, context.profileId))) fail('profile-not-found');
    }
  }
  _writable() {
    if (this.phase === 'recovery') fail(this.code || 'local-recovery-required');
    if (this.phase !== 'local' || !this.envelope) fail('not-initialized');
  }
  async _failure(cause) {
    const error = safeError(cause);
    if (DISK_CODES.has(error.code)) {
      // Never reassert an old in-memory snapshot as freshly durable after a
      // rename. load retries directory sync, then reads the actual disk state.
      try {
        // Startup can fail before initialize captures the writer. A recovered
        // usable envelope is editable only after its installation actor is held.
        if (this.actor === null) this.actor = (await this.repository.init()).writerId;
        this._adopt(await this.repository.load(LOCAL));
      }
      catch (reloadError) { this._recover(safeError(reloadError).code); }
    }
    return { ok: false, error: { code: error.code, messageKey: `progress.error.${error.code}` }, snapshot: this.snapshot() };
  }
  _submit(context, mode, prepare, operation, allowRecovery = false) {
    let captured; let args; let initialError;
    try {
      if (this.closing) fail('service-closed');
      this._context(context, mode);
      captured = { ...context };
      args = prepare();
    } catch (error) { initialError = error; }
    return this._enqueue(async () => {
      try {
        if (initialError) throw initialError;
        this._context(captured, mode);
        if (!allowRecovery) this._writable();
        return { ok: true, value: await operation(captured, args) };
      } catch (error) { return this._failure(error); }
    });
  }

  /** Migration completes before any editable snapshot is published. Repeated initialization retries durability/recovery reads. @param {{userData:string}} options @returns {Promise<PublicSnapshot>} */
  initialize(options) {
    let userData; let invalid;
    try {
      input(options, ['userData']);
      if (this.closing) fail('service-closed');
      if (typeof options.userData !== 'string' || !options.userData.length) fail('invalid-command');
      userData = path.resolve(options.userData);
      if (this.userData !== null && this.userData !== userData) fail('invalid-command');
    } catch (error) { invalid = error; }
    return this._enqueue(async () => {
      try {
        if (invalid) throw invalid;
        if (this.userData !== null && this.userData !== userData) fail('invalid-command');
        this.userData = userData;
        this.actor = (await this.repository.init()).writerId;
        const envelope = await migrateLegacy({ repository: this.repository, userData, uuid: () => this._uuid() });
        this._adopt(envelope, true);
      } catch (error) {
        const failure = await this._failure(error);
        if (!DISK_CODES.has(failure.error.code) && failure.error.code !== 'service-closed') this._recover(failure.error.code);
      }
      return this.snapshot();
    });
  }

  async _transaction(context, options, mutate) {
    this._context(context, 'active'); this._writable();
    input(options, ['reason'], ['expectedRevision']);
    if (!['edit', 'import', 'restore'].includes(options.reason) || typeof mutate !== 'function') fail('invalid-command');
    if (Object.hasOwn(options, 'expectedRevision') && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) fail('invalid-command');
    if (Object.hasOwn(options, 'expectedRevision')) {
      const before = await this.repository.load(LOCAL);
      if (before.revision !== options.expectedRevision) fail('revision-conflict');
    }
    if (options.reason !== 'edit') await this.repository.backup(LOCAL, 'import');
    const after = await this.repository.transact(LOCAL, draft => {
      this._context(context, 'active');
      if (Object.hasOwn(options, 'expectedRevision') && draft.revision !== options.expectedRevision) fail('revision-conflict');
      return mutate(draft, this.actor);
    });
    this._adopt(after);
    return after;
  }

  /**
   * Internal main-process extension point. One synchronous void callback commits
   * canonical state and future local attachments atomically. Never expose this
   * method through IPC. Import/restore reasons archive current state first.
   * @param {Context} context
   * @param {{expectedRevision?:number,reason:'edit'|'import'|'restore'}} options
   * @param {(draft:import('./schema').LocalEnvelope,actor:string)=>void} mutate
   * @returns {Promise<import('./schema').LocalEnvelope>}
   */
  runProfileTransaction(context, options, mutate) {
    let captured; let copied; let invalid;
    try {
      if (this.closing) fail('service-closed');
      this._context(context, 'active'); captured = { ...context };
      copied = copyPatch(options, ['reason'], ['expectedRevision']);
    } catch (error) { invalid = error; }
    return this._enqueue(async () => {
      try { if (invalid) throw invalid; return await this._transaction(captured, copied, mutate); }
      catch (error) { await this._failure(error); throw safeError(error); }
    });
  }

  /** @param {Context} context @param {{id:number,found:boolean}} patch @returns {Promise<Result<PublicSnapshot>>} */
  setFound(context, patch) {
    return this._submit(context, 'active', () => copyPatch(patch, ['id', 'found']), async (ctx, data) => {
      await this._transaction(ctx, { reason: 'edit' }, (draft, actor) => commands.setFound(draft, { profileId: ctx.profileId, ...data }, actor));
      return this.snapshot();
    });
  }
  /** @param {Context} context @param {{enabledTypes?:string[],hideFound?:boolean}} patch @returns {Promise<Result<PublicSnapshot>>} */
  setPreferences(context, patch) {
    return this._submit(context, 'active', () => copyPatch(patch, [], ['enabledTypes', 'hideFound']), async (ctx, data) => {
      await this._transaction(ctx, { reason: 'edit' }, (draft, actor) => commands.setPreferences(draft, { profileId: ctx.profileId, ...data }, actor));
      return this.snapshot();
    });
  }
  /** Creates and activates a new profile with default preferences. @param {{sessionGeneration:string,name:string,region:string}} options @returns {Promise<Result<PublicSnapshot>>} */
  createProfile(options) {
    let ctx;
    try { input(options, ['sessionGeneration', 'name', 'region']); ctx = { sessionGeneration: options.sessionGeneration }; }
    catch { ctx = null; }
    return this._submit(ctx, 'generation', () => copyPatch(options, ['sessionGeneration', 'name', 'region']), async (_, data) => {
      const id = this._uuid();
      const after = await this.repository.transact(LOCAL, draft => {
        this._context({ sessionGeneration: data.sessionGeneration }, 'generation');
        commands.createProfile(draft, { id, name: data.name, region: data.region }, this.actor);
        draft.selectedProfileId = id;
      });
      this._adopt(after);
      return this.snapshot();
    });
  }
  /** @param {Context} context @param {{name?:string,region?:string}} patch @returns {Promise<Result<PublicSnapshot>>} */
  renameProfile(context, patch) {
    return this._submit(context, 'active', () => copyPatch(patch, [], ['name', 'region']), async (ctx, data) => {
      await this._transaction(ctx, { reason: 'edit' }, (draft, actor) => commands.renameProfile(draft, { id: ctx.profileId, ...data }, actor));
      return this.snapshot();
    });
  }
  /** profileId is the target; sessionGeneration belongs to the current activation. Every successful selection rotates the session, even if the persisted ID is unchanged. @param {Context} context @returns {Promise<Result<PublicSnapshot>>} */
  selectProfile(context) {
    return this._submit(context, 'target', () => null, async ctx => {
      const after = await this.repository.transact(LOCAL, draft => {
        this._context(ctx, 'target');
        if (!Object.hasOwn(draft.state.profiles, ctx.profileId)) fail('profile-not-found');
        draft.selectedProfileId = ctx.profileId;
      });
      this._adopt(after, true);
      return this.snapshot();
    });
  }
  /** Import as new profiles and activate the first imported profile. @param {{sessionGeneration:string,bytes:Buffer}} options @returns {Promise<Result<PublicSnapshot>>} */
  importBackup(options) {
    let ctx;
    try { input(options, ['sessionGeneration', 'bytes']); ctx = { sessionGeneration: options.sessionGeneration }; }
    catch { ctx = null; }
    return this._submit(ctx, 'generation', () => { input(options, ['sessionGeneration', 'bytes']); return backups.parseBackup(options.bytes); }, async (_, backup) => {
      const activeContext = { sessionGeneration: ctx.sessionGeneration, profileId: this.envelope.selectedProfileId };
      await this._transaction(activeContext, { reason: 'import' }, (draft, actor) => {
        const ids = backups.importProfiles(draft, backup, { actor, uuid: () => this._uuid() });
        draft.selectedProfileId = ids[0];
      });
      return this.snapshot();
    });
  }
  /** @param {{sessionGeneration:string,profileIds:string[]}} options @returns {Promise<Result<string>>} */
  exportBackup(options) {
    let ctx;
    try { input(options, ['sessionGeneration', 'profileIds']); ctx = { sessionGeneration: options.sessionGeneration }; }
    catch { ctx = null; }
    return this._submit(ctx, 'generation', () => copyPatch(options, ['sessionGeneration', 'profileIds']), async (_, data) => {
      const actual = await this.repository.load(LOCAL);
      const bytes = backups.exportBackup(actual.state, data.profileIds);
      this._adopt(actual);
      return bytes;
    });
  }
  /** Restore validated last-good, preserving originals via repository recovery; rerun migration when last-good is the initial incomplete envelope. @param {{sessionGeneration:string}} context @returns {Promise<Result<PublicSnapshot>>} */
  restoreLocalBackup(context) {
    return this._submit(context, 'generation', () => null, async ctx => {
      if (!this.userData) fail('not-initialized');
      this.actor = (await this.repository.init()).writerId;
      this._context(ctx, 'generation');
      let after;
      try {
        after = await this.repository.restoreLastGood(LOCAL);
        this.pendingRestoreActivation = true;
      } catch (error) {
        // Replacement may already have happened. Carry the restore activation
        // through immediate or later durability reconciliation, even if its
        // selected profile ID matches the old one. Never clear it on a failed
        // read/sync; only adopting usable durable state consumes this intent.
        if (error.code === 'local-durability-uncertain') this.pendingRestoreActivation = true;
        throw error;
      }
      if (!after.migrationComplete) after = await migrateLegacy({ repository: this.repository, userData: this.userData, uuid: () => this._uuid() });
      this._adopt(after, true);
      return this.snapshot();
    }, true);
  }
  /** Drain all accepted commands and repository persistence, including rejected commands. Persistent durability uncertainty rejects shutdown safely. @returns {Promise<void>} */
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = this._enqueue(async () => {
      try {
        await this.repository.flush();
        if (this.code === 'local-durability-uncertain') this._adopt(await this.repository.load(LOCAL));
      } catch (error) {
        await this._failure(error);
        // A failed close leaves recovery available and permits a later quit to
        // retry directory durability. Only a successful shutdown stays closed.
        this.closing = false;
        this.shutdownPromise = null;
        throw safeError(error);
      }
    });
    return this.shutdownPromise;
  }
}

module.exports = { ProgressService };
