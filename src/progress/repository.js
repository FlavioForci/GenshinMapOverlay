'use strict';

const defaultFs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { atomicWriteFile, readFileBounded, syncDirectory } = require('./atomic-file');
const { ProgressError, LIMITS, validateEnvelope } = require('./schema');

/** @typedef {import('./schema').Scope} Scope */
/** @typedef {import('./schema').LocalEnvelope} LocalEnvelope */
const LOCAL = Object.freeze({ kind: 'local' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALLATION_BYTES = 4096;
const ARCHIVE_NAME = /^local-(migration|import|recovery)-\d+-[0-9a-f-]+\.json$/;

function emptyEnvelope() {
  return {
    version: 1, state: { namespace: 'appsample:gim:2', profiles: {} },
    clock: 0, revision: 0, dirtyRevision: 0, acknowledgedRevision: 0,
    selectedProfileId: null, migrationComplete: false, sync: null,
  };
}
function checkScope(scope) {
  // Reuse the schema's exact own-field and account-key checks before deriving
  // any path. Valid account identities deliberately remain unsupported.
  validateEnvelope(emptyEnvelope(), scope);
}
function fail(code) { throw new ProgressError(code); }

/**
 * Main-process local repository. One instance owns this root; all of its reads,
 * edits and backups share one queue. Returned data is detached from disk.
 * Revision is repository-owned; canonical changes also advance dirtyRevision.
 * There is no cache that can outlive a failed write or explicit restore.
 */
class ProgressRepository {
  constructor({ root, fs = defaultFs, uuid = randomUUID, platform = process.platform }) {
    if (typeof root !== 'string' || root.length === 0 || typeof uuid !== 'function') fail('invalid-repository');
    this.root = path.resolve(root);
    this.fs = fs;
    this.uuid = uuid;
    this.platform = platform;
    this.tail = Promise.resolve();
    this.identity = null;
    this.pendingDirectories = new Set();
  }

  _enqueue(operation) {
    const result = this.tail.then(operation);
    // Failed callers retain their rejection, while later work and shutdown can
    // still drain the queue without an unhandled or permanently poisoned tail.
    this.tail = result.catch(() => {});
    return result;
  }

  _paths(scope) {
    checkScope(scope);
    return { state: path.join(this.root, 'local/state.json'), lastGood: path.join(this.root, 'local/state.last-good.json') };
  }

  async _retryDurability() {
    for (const directory of this.pendingDirectories) {
      try {
        await syncDirectory(directory, this.fs, this.platform);
        this.pendingDirectories.delete(directory);
      } catch {
        fail('local-durability-uncertain');
      }
    }
  }

  async _write(file, bytes, backupFile) {
    try {
      await atomicWriteFile(file, bytes, { fs: this.fs, maxBytes: LIMITS.LOCAL_ENVELOPE_BYTES, backupFile, platform: this.platform });
    } catch (error) {
      if (error.replacementOccurred) this.pendingDirectories.add(path.dirname(file));
      throw error;
    }
  }

  async _init() {
    await this._retryDurability();
    if (this.identity) return structuredClone(this.identity);
    try {
      await this.fs.mkdir(this.root, { recursive: true });
      await this.fs.mkdir(path.join(this.root, 'local'), { recursive: true });
      await this.fs.mkdir(path.join(this.root, 'backups'), { recursive: true });
      // Persist newly created directory entries as well as file replacements.
      await syncDirectory(path.dirname(this.root), this.fs, this.platform);
      await syncDirectory(this.root, this.fs, this.platform);
    } catch {
      fail('local-write-failed');
    }
    // A prior process may have renamed state.json without confirming its
    // directory entry. A new instance must establish that durability too;
    // syncing root does not sync the renamed child entry inside local.
    this.pendingDirectories.add(path.join(this.root, 'local'));
    await this._retryDurability();
    const file = path.join(this.root, 'installation.json');
    let bytes;
    try {
      bytes = await readFileBounded(file, INSTALLATION_BYTES, this.fs);
    } catch (error) {
      if (error.code === 'limit-exceeded') fail('local-recovery-required');
      if (error.code !== 'ENOENT') fail('local-read-failed');
    }
    if (bytes === undefined) {
      const writerId = this.uuid();
      if (typeof writerId !== 'string' || !UUID.test(writerId)) fail('invalid-installation');
      const identity = { version: 1, writerId, activeScope: { ...LOCAL } };
      await this._write(file, Buffer.from(JSON.stringify(identity)));
      this.identity = { writerId, activeScope: { ...LOCAL } };
    } else {
      let identity;
      try { identity = JSON.parse(bytes.toString('utf8')); } catch { fail('local-recovery-required'); }
      if (identity && Number.isSafeInteger(identity.version) && identity.version > 1) fail('unsupported-version');
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || Object.keys(identity).length !== 3 || identity.version !== 1
        || typeof identity.writerId !== 'string' || !UUID.test(identity.writerId)) fail('local-recovery-required');
      try { checkScope(identity.activeScope); } catch (error) {
        if (error.code === 'unsupported-scope') throw error;
        fail('local-recovery-required');
      }
      this.identity = { writerId: identity.writerId, activeScope: { ...LOCAL } };
    }
    return structuredClone(this.identity);
  }

  /** @returns {Promise<{writerId:string,activeScope:Scope}>} */
  init() { return this._enqueue(() => this._init()); }

  async _readEnvelope(file, scope) {
    let bytes;
    try {
      bytes = await readFileBounded(file, LIMITS.LOCAL_ENVELOPE_BYTES, this.fs);
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      if (error.code === 'limit-exceeded') fail('local-recovery-required');
      fail('local-read-failed');
    }
    try {
      return { bytes, envelope: validateEnvelope(JSON.parse(bytes.toString('utf8')), scope) };
    } catch (error) {
      if (error.code === 'unsupported-version') throw error;
      fail('local-recovery-required');
    }
  }

  async _load(scope) {
    const files = this._paths(scope);
    await this._init();
    try {
      return (await this._readEnvelope(files.state, scope)).envelope;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Missing primary beside an existing recovery copy is lost/corrupt state,
    // not a first launch. Recovery must remain an explicit user action.
    try {
      await this.fs.stat(files.lastGood);
      fail('local-recovery-required');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof ProgressError) throw error;
        fail('local-read-failed');
      }
    }
    try {
      if ((await this.fs.readdir(path.join(this.root, 'backups'))).some(name => ARCHIVE_NAME.test(name))) {
        fail('local-recovery-required');
      }
    } catch (error) {
      if (error instanceof ProgressError) throw error;
      fail('local-read-failed');
    }
    const initial = emptyEnvelope();
    await this._write(files.state, Buffer.from(JSON.stringify(initial)));
    return initial;
  }

  /** Retry any pending directory sync before returning a durable detached state. @returns {Promise<LocalEnvelope>} */
  load(scope) { return this._enqueue(() => this._load(scope)); }

  /** @param {Scope} scope @param {(draft:LocalEnvelope)=>void} mutate @returns {Promise<LocalEnvelope>} */
  transact(scope, mutate) {
    return this._enqueue(async () => {
      const before = await this._load(scope);
      if (typeof mutate !== 'function') fail('invalid-mutation');
      const draft = structuredClone(before);
      const returned = mutate(draft);
      if (returned !== undefined) {
        // Never adopt asynchronous mutations. Attach a handler so a rejected
        // accidental async callback cannot create an unhandled rejection.
        if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => {});
        fail('invalid-mutation');
      }
      if (draft.revision !== before.revision) fail('invalid-envelope');
      if (isDeepStrictEqual(draft, before)) return structuredClone(before);
      if (before.revision === Number.MAX_SAFE_INTEGER) fail('revision-exhausted');
      draft.revision = before.revision + 1;
      const after = validateEnvelope(draft, scope);
      // Validate the caller's counters before deriving canonical dirty state.
      // Otherwise an invalid supplied dirtyRevision could be silently repaired.
      if (!isDeepStrictEqual(after.state, before.state)) after.dirtyRevision = after.revision;
      const files = this._paths(scope);
      await this._write(files.state, Buffer.from(JSON.stringify(after)), files.lastGood);
      return after;
    });
  }

  _archiveName(reason) {
    return path.join(this.root, 'backups', `local-${reason}-${Date.now()}-${randomUUID()}.json`);
  }

  async _prune(newest) {
    const directory = path.join(this.root, 'backups');
    const names = (await this.fs.readdir(directory)).filter(name => ARCHIVE_NAME.test(name));
    const entries = await Promise.all(names.map(async name => {
      const file = path.join(directory, name);
      return { file, time: (await this.fs.stat(file)).mtimeMs };
    }));
    entries.sort((a, b) => a.time - b.time || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    let excess = entries.length - LIMITS.RECOVERY_BACKUPS;
    for (const entry of entries) {
      if (excess <= 0) break;
      if (entry.file === newest) continue;
      await this.fs.unlink(entry.file);
      excess--;
    }
    if (entries.length > LIMITS.RECOVERY_BACKUPS) await syncDirectory(directory, this.fs, this.platform);
  }

  /** @param {Scope} scope @param {'migration'|'import'} reason @returns {Promise<void>} */
  backup(scope, reason) {
    return this._enqueue(async () => {
      this._paths(scope);
      if (!['migration', 'import'].includes(reason)) fail('invalid-backup-reason');
      const envelope = await this._load(scope);
      const archive = this._archiveName(reason);
      try {
        await atomicWriteFile(archive, Buffer.from(JSON.stringify(envelope)), { fs: this.fs, maxBytes: LIMITS.LOCAL_ENVELOPE_BYTES, platform: this.platform });
        await this._prune(archive);
      } catch {
        fail('local-backup-failed');
      }
    });
  }

  /**
   * Preserve exact pre-migration bytes as internal recovery data, including any
   * legacy settings fields. This is never a portable progress backup. Each raw
   * file is bounded at 4 MiB and copied before queueing so caller mutation cannot
   * change the archive. Null records an absent source rather than an empty file.
   * @param {{found:Buffer|null,settings:Buffer|null}} input
   * @returns {Promise<void>}
   */
  preserveLegacyBackup(input) {
    let bytes;
    let invalid;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-legacy-backup');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(descriptors).length !== 2) fail('invalid-legacy-backup');
      const archive = { format: 'genshin-map-overlay.legacy-backup', version: 1 };
      for (const key of ['found', 'settings']) {
        const descriptor = descriptors[key];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid-legacy-backup');
        const value = descriptor.value;
        if (value !== null && !Buffer.isBuffer(value)) fail('invalid-legacy-backup');
        if (value !== null && value.length > LIMITS.PORTABLE_BODY_BYTES) fail('limit-exceeded');
        archive[key] = value === null ? null : value.toString('base64');
      }
      bytes = Buffer.from(JSON.stringify(archive));
    } catch (error) { invalid = error; }
    return this._enqueue(async () => {
      if (invalid) throw invalid;
      await this._init();
      const archive = this._archiveName('migration');
      // Two base64 strings, each independently bounded above, plus metadata.
      const maxBytes = 2 * Math.ceil(LIMITS.PORTABLE_BODY_BYTES / 3) * 4 + 1024;
      try {
        await atomicWriteFile(archive, bytes, { fs: this.fs, maxBytes, platform: this.platform });
        await this._prune(archive);
      } catch { fail('local-backup-failed'); }
    });
  }

  // Preserve arbitrary corrupt bytes without parsing or reading an unbounded
  // file into memory. Complete and fsync its archive before touching primary.
  async _preserveOriginal(file) {
    const archive = this._archiveName('recovery');
    const temporary = `${archive}.tmp`;
    let handle;
    try {
      try {
        await this.fs.stat(file);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      // copyFile ENOENT can also mean that the destination directory vanished.
      // Only the separate source stat may establish that there is no original.
      await this.fs.copyFile(file, temporary, constants.COPYFILE_EXCL);
      handle = await this.fs.open(temporary, 'r+');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fs.rename(temporary, archive);
      await syncDirectory(path.dirname(archive), this.fs, this.platform);
      return archive;
    } catch {
      fail('local-backup-failed');
    } finally {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(temporary).catch(() => {});
    }
  }

  /** Explicitly restore validated last-good; preserve original first. @returns {Promise<LocalEnvelope>} */
  restoreLastGood(scope) {
    return this._enqueue(async () => {
      const files = this._paths(scope);
      await this._init();
      let good;
      try { good = await this._readEnvelope(files.lastGood, scope); } catch (error) {
        if (error.code === 'ENOENT') fail('local-recovery-required');
        throw error;
      }
      const preserved = await this._preserveOriginal(files.state);
      // All fallible archive maintenance must finish before changing primary.
      // Keep the newly preserved original protected if pruning fails.
      try { await this._prune(preserved); } catch { fail('local-backup-failed'); }
      // Never pass backupFile here: the corrupt primary must not replace the
      // validated last-good copy, even when the final restore rename fails.
      await this._write(files.state, good.bytes);
      return good.envelope;
    });
  }

  /** Drain queued operations (including rejected callers); retry uncertain syncs. @returns {Promise<void>} */
  flush() { return this._enqueue(() => this._retryDurability()); }
}

module.exports = { ProgressRepository };
