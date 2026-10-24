# Google Drive Progress Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, offline-first Google Drive sync for several named Genshin progress profiles, with durable local edits, account isolation and portable backups.

**Architecture:** Main owns a serialized progress service, account-scoped atomic storage, desktop OAuth and one sync worker. Pure register merging and immutable per-writer Drive snapshots preserve independent offline edits and explicit undo; sandboxed renderers receive authoritative, display-safe profile snapshots. Public map downloads and recognition remain separate.

**Tech Stack:** CommonJS, Electron 45, vanilla JavaScript/HTML/CSS, Node.js `>=22.12.0`, Node built-in `node:test`, `google-auth-library`, Google Drive API v3, asynchronous Electron `safeStorage`.

**Spec:** [2026-10-24-google-drive-sync-design.md](../specs/2026-10-24-google-drive-sync-design.md). Also read [the project analysis](../research/2026-10-24-project-analysis.md), but use the current source where its inventory has changed.

## Global Constraints

- “Optional Google connection; a fresh installation works without signing in.”
- “Use CommonJS and the existing Electron/vanilla-JavaScript architecture. Node for build/test tooling must be `>=22.12.0`. Windows and macOS Apple Silicon are supported targets.”
- “Sync found/open marker states, profile labels/regions, enabled marker types and hide-found preference.”
- “Keep all other app settings local, including language, opacity, marker size, game path, hotkeys, screen/capture settings and data-server configuration.”
- “Profile selection is local to the device. Profile deletion/archival is deferred for the first version.”
- “Logical dataset namespace: `appsample:gim:2`.”
- “Marker registers store explicit booleans, including `false` for undo. Never remove false registers in v1.”
- “Imported backup values are restamped as new local edits, rather than trusting imported clocks/actors.”
- “Never include tokens, device identifiers, logs, screenshots, caches or local paths in backups.”
- “Coalesce local changes for 2 seconds and poll remote changes every 60 seconds while connected; suspend polling during OS sleep.”
- “Run at most one sync cycle at a time.”
- “Do not introduce webhooks or a backend.”
- “No live Google account is required for ordinary automated tests.”
- “Publishing Google configuration, a website or a release is a later explicit deployment step.”

## Review Focus

1. Rapid mark/undo followed by a failed disk write: keep the latest pending intention visible, then reconcile to durable state without applying an older reply to another profile. Tests: Tasks 2, 11.
2. Account switches during OAuth, token refresh, import dialogs or upload acknowledgement: stale work cannot bind credentials, mutate the new account or upload the previous cache. Tests: Tasks 6, 9, 10.
3. Corrupt, oversized, contradictory or newer data among otherwise valid saves: preserve original bytes and useful cached progress, and block publication rather than silently dropping input. Tests: Tasks 1–4, 7–8.
4. An empty listing after prior sync, or a file disappearing between list and download: distinguish explicit cloud restoration from a cleanup race; neither means undo. Tests: Tasks 7–8.
5. Removed dataset entries, unknown type keys and unfamiliar Unicode profile labels: preserve valid identities and text across merge, backup and profile replacement without rendering HTML. Tests: Tasks 1, 4, 11–12.

---

## Execution context and decisions

This is one feature with shared persistence and ownership invariants, so keep one ordered plan. The spec's engineering proposals remain proposals until the human reviews this plan; writing/committing the plan does not authorize implementation or deployment.

Work on the user-requested branch `google-drive-sync`. Keep `docs/` tracked. At planning time `package.json` and `package-lock.json` already contain unrelated local edits; preserve them and stage only task-owned changes. Their working-tree root versions already both read `1.1.0`, unlike the older analysis. Do not invent a release bump or restore older dependency versions.

Run commands from the repository root. Add `"test:progress": "node --test \"tests/progress/*.test.js\""` in Task 1; the quoted glob works across Windows/macOS with the [Node 22.12 runner](https://nodejs.org/download/release/v22.12.0/docs/api/test.html#running-tests-from-the-command-line). Each focused command below uses the Node runner directly; run `npm run test:progress` before each implementation commit once the suite exists. Fixtures use synthetic IDs and injected dependencies, never Google credentials or downloaded map tiles. Commit steps list only that task's paths; inspect the staged diff before committing when a file has pre-existing edits.

### File map

| Paths | Responsibility |
| --- | --- |
| `src/progress/schema.js`, `merge.js` | Schema versions, bounds, register comparison and pure merge/derivation |
| `src/progress/atomic-file.js`, `repository.js` | Crash-safe files, installation identity, serialized scope transactions and durable sync metadata |
| `src/progress/migration.js` | Idempotent legacy conversion and original-byte preservation |
| `src/progress/profiles.js`, `backup.js` | Profile edits/copies and portable export/import |
| `src/cloud/token-vault.js`, `oauth.js`, `oauth-config.js` | Secure credentials, browser OAuth and public desktop-client configuration |
| `src/cloud/snapshot.js`, `drive.js`, `errors.js` | Immutable wire schema, bounded REST transport and safe error classification |
| `src/cloud/sync-worker.js` | Pull/merge/publication/retry/cleanup state machine |
| `src/progress/service.js`, `ipc.js`, `runtime.js` | Account-session ownership, renderer boundary and Electron lifecycle composition |
| `src/overlay/progress-view.js`, existing overlay files | Optimistic intentions, authoritative reconciliation, selector and sync status |
| `src/settings/{window.js,index.html,preload.js,settings.js,settings.css}` | Ordinary cloud/profile settings window |
| `src/main.js`, `src/config.js`, `src/shared/i18n.js` | Thin composition, local/profile preference split and EN/DE copy |
| `tests/progress/*.test.js`, `tests/progress/helpers.js` | Offline tests and reusable deterministic fixtures |
| `tools/check-progress-package.js`, packaging/workflow files | Packaged dependency/config checks and supported Node floor |
| Both READMEs, `server/public/index.html`, `server/public/privacy.html`, `docs/google-drive-setup.md` | User privacy, maintainer configuration and acceptance instructions |

### Shared contracts

Use JSDoc types in the owning modules; these are JavaScript objects, not a TypeScript migration.

- `Register<T> = {value:T, clock:number, actor:string}`. Actors/profile IDs are lowercase UUIDs; clocks are positive safe integers. Compare actors with fixed ASCII lexical comparison, never `localeCompare()`.
- `Profile = {name:Register<string>, region:Register<string>, enabledTypes:Register<string[]>, hideFound:Register<boolean>, markers:Record<string,Register<boolean>>}`. Marker keys are canonical decimal positive safe integers; type keys match `/^o[1-9]\d{0,14}$/` and have a safe-integer numeric suffix. Unknown valid IDs/types survive.
- `ProgressState = {namespace:'appsample:gim:2', profiles:Record<string,Profile>}`. Missing registers mean unedited, not an explicit false. Every profile has all four metadata/preference registers.
- `Scope = {kind:'local'} | {kind:'account', accountKey:string}`. `accountKey` is lowercase SHA-256 hex of JSON `[normalizedIssuer, subject]`, derived only from verified identity. Normalize Google's two accepted issuer spellings to `https://accounts.google.com`; email is display-only.
- `LocalEnvelope = {version:1, state:ProgressState, clock:number, revision:number, dirtyRevision:number, acknowledgedRevision:number, selectedProfileId:string|null, migrationComplete:boolean, sync:SyncMetadata|null}`. Local-only envelopes have `sync:null`; account envelopes have `SyncMetadata = {writerGeneration:number, pending:PendingPublication|null, knownFiles:Record<string,KnownFile>, everSynced:boolean, requiresCloudRestore:boolean, lastSuccessAt:number|null}`. `KnownFile = {hash:string, writerId:string, generation:number}`.
- `PendingPublication = {body:string, hash:string, writerId:string, generation:number, revision:number, fileId:string|null}`. Body bytes and generation never change after preparation. Acknowledging revision R never clears dirty changes newer than R.
- `Context = {sessionGeneration:string, profileId:string}`. Main generates a fresh opaque session UUID on activation/reconnection/disconnection; renderer mutations carry the current context. Check it both on enqueue and immediately before transaction commit. Profile selection drains earlier writes and increments the view version; switching scopes invalidates the session.
- `PublicSnapshot = {sessionGeneration:string, viewVersion:number, scope:'local'|'account', account:{email:string|null, connected:boolean}|null, profiles:Array<{id:string,name:string,region:string}>, activeProfile:{id:string,name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}|null, sync:{phase:string,code:string|null,lastSuccessAt:number|null}}`. `viewVersion` increases for every service emission within a session, including transient status changes. No registers, account keys, paths or credentials cross IPC.
- `Result<T> = {ok:true,value:T} | {ok:false,error:{code:string,messageKey:string},snapshot:PublicSnapshot}`. Main logs safe codes; never return raw exception messages or response bodies to renderers.

Implementation choices where the spec intentionally leaves values open: portable/remote JSON body limit **4 MiB**, local envelope limit **16 MiB** (includes a pending body), **100 profiles**, **200,000 marker registers across profiles**, **10,000 discovered remote files**, **4,096 enabled type keys per profile**, names **1–80** trimmed Unicode code points, regions **0–80**, and at most **10 local recovery backups**. These are rejection limits, never truncation rules. Before accepting an account mutation, also check that its resulting wire snapshot fits the remote body limit; never acknowledge new edits that cannot be published. An oversized remote merge blocks publication while preserving the previous durable save. Reaching limits leaves current progress intact and presents a specific limit error. Clock/generation overflow blocks mutation rather than wrapping.

### Task 1: Define the progress schema and register merge

**Files:** Create `src/progress/schema.js`, `src/progress/merge.js`, `tests/progress/helpers.js`, `tests/progress/schema.test.js`, `tests/progress/merge.test.js`. Modify `package.json:scripts`.

**Interfaces:**
- Produce `validateState(value:unknown):ProgressState`, `validateEnvelope(value:unknown, scope:Scope):LocalEnvelope`, `ProgressError(code:string)`, and exported `LIMITS` from `schema.js`.
- Produce `mergeStates(a:ProgressState,b:ProgressState):ProgressState`, `nextClock(clock:number,state:ProgressState):number`, `foundIds(profile:Profile):number[]` from `merge.js`.
- Helpers export fixed valid `ACTOR_A`, `ACTOR_B`, `PROFILE_A`, `PROFILE_B`, and `makeState({actor=ACTOR_A,clock=1,profileId=PROFILE_A,found={},name='Main',region='',enabledTypes=['o5'],hideFound=false}={}):ProgressState`; `found` maps numeric IDs to booleans.

- [ ] **Step 1: Write the failing schema and merge tests.** Use named `node:test` cases with these arrangements/assertions:

```js
// 'merge is commutative, associative and idempotent': use three actors/states.
assert.deepEqual(mergeStates(a, b), mergeStates(b, a));
assert.deepEqual(mergeStates(mergeStates(a, b), c), mergeStates(a, mergeStates(b, c)));
assert.deepEqual(mergeStates(a, a), a);
// 'explicit undo wins over an observed found': clocks 7/8, same profile/marker 42.
assert.deepEqual(foundIds(mergeStates(foundAt7, undoAt8).profiles[PROFILE_A]), []);
// 'clock advances beyond every field, not just markers': highest region clock is 50.
assert.equal(nextClock(3, stateWithRegionAt50), 51);
```

Also pin: equal clocks use `ACTOR_B` over `ACTOR_A`; independent markers/profiles survive; merging preserves unknown ID `900000001` and type `o999999`; enabled types are sorted/unique; clocks `0`, unsafe integers, malformed UUIDs, nonboolean marker values, wrong namespace, newer envelope version, prototype keys and bounds are rejected. Equal `(clock,actor)` with unequal values is recognized corruption, not an order-dependent winner. Overflow throws `clock-exhausted`.

- [ ] **Step 2: Run** `node --test tests/progress/schema.test.js tests/progress/merge.test.js`. Expected: FAIL because new module exports do not exist.
- [ ] **Step 3: Implement the declared schema/merge exports and fixtures.** Validate plain objects and own properties; canonicalize valid arrays at construction boundaries, reject noncanonical persisted documents, and never mutate merge inputs. Add the test script without changing existing scripts/dependencies.
- [ ] **Step 4: Run** `npm run test:progress`. Expected: all schema/algebra tests PASS without Electron or network access.
- [ ] **Step 5: Commit** only the five new files and the script hunk: `git commit -m "feat: define profile progress schema and deterministic merge"`.

### Task 2: Add durable scoped transactions

**Files:** Create `src/progress/atomic-file.js`, `src/progress/repository.js`, `tests/progress/repository.test.js`.

**Interfaces:**
- Consume Task 1 validation and state types.
- Produce `atomicWriteFile(file:string, bytes:Buffer, {fs,maxBytes,backupFile}):Promise<void>`; injected `fs` defaults to `node:fs/promises`, and `backupFile` is optional.
- Produce `accountKeyFor(identity:{issuer:string,subject:string}):string` and `ProgressRepository({root:string,fs?,uuid?})` with `init():Promise<{writerId:string,activeScope:Scope}>`, `load(scope:Scope):Promise<LocalEnvelope>`, `transact(scope:Scope,mutate:(draft:LocalEnvelope)=>void):Promise<LocalEnvelope>`, `setActiveScope(scope:Scope):Promise<void>`, `backup(scope:Scope,reason:'migration'|'import'):Promise<void>`, `restoreLastGood(scope:Scope):Promise<LocalEnvelope>`, `flush():Promise<void>`.

- [ ] **Step 1: Write failing transaction/restart tests** in real temporary directories with injected filesystem failures:

```js
// 'failed rename keeps durable and in-memory state': inject EACCES on destination rename.
await assert.rejects(repo.transact(scope, edit42), { code: 'local-write-failed' });
assert.deepEqual(await repo.load(scope), before);
assert.deepEqual(await reopened.load(scope), before);
// 'concurrent writes serialize': enqueue independent edits for 42 and 43.
assert.deepEqual(foundIds(after.state.profiles[PROFILE_A]), [42, 43]);
```

Test interruption after temp write, file sync, backup replacement and final rename; only complete valid states may load. Invalid primary bytes stay untouched with `local-recovery-required`, even when a good backup exists; recovery is explicit. `restoreLastGood()` must validate the backup and durably preserve the corrupt original before replacement; a missing/invalid backup leaves both untouched. ENOENT alone allows initialization. Test missing/invalid installation identity separately, account-path traversal rejection, email changes preserving account keys, byte limits, last-good backup retention and pruning to ten backups only after the new backup is durable.

- [ ] **Step 2: Run** `node --test tests/progress/repository.test.js`. Expected: FAIL on missing repository.
- [ ] **Step 3: Implement atomic file replacement.** Create same-directory temporary files, write/sync/close, preserve the last validated destination through an atomic backup, then rename; sync the parent directory where supported. Never unlink a good destination as a rename workaround. Set restrictive file permissions where supported and propagate disk/permission failures.
- [ ] **Step 4: Implement repository transactions and installation storage.** Use one promise queue and validated cloned drafts; assign the next `draft.revision` before calling `mutate`, and publish in-memory state only after replacement succeeds. If no other field changed, discard the provisional revision as a no-op. Store `installation.json` with version, writer UUID and local active-scope pointer; account identity/token binding belongs to the vault. Persist all envelopes at the spec's exact local/account paths. Implement explicit last-good recovery, never automatic fallback. `flush()` drains local work only.
- [ ] **Step 5: Run** `node --test tests/progress/repository.test.js` and `npm run test:progress`. Expected: all PASS, including injected disk failure/reopen cases.
- [ ] **Step 6: Commit** the three files: `git commit -m "feat: persist scoped progress with atomic transactions"`.

### Task 3: Migrate existing progress without losing recovery data

**Files:** Create `src/progress/migration.js`, `tests/progress/migration.test.js`. Modify `src/config.js:6-19,45-68,72-86`.

**Interfaces:**
- Consume `ProgressRepository`, `nextClock()` and schema validation.
- Produce `migrateLegacy({repository:ProgressRepository,userData:string,readFile?,uuid?}):Promise<LocalEnvelope>`.
- Export `DEFAULT_PROFILE_PREFERENCES` from `config.js`; add `load({preserveMalformed=false}={}):object`. `preserveMalformed:true` returns defaults without writing over unreadable/malformed legacy settings, allowing migration to report recovery.

- [ ] **Step 1: Write failing migration tests.** Starting with `found.json` bytes `{"ids":[42,42,43]}` and legacy `enabledTypes:['o6','o5']`, `hideFound:true`, assert:

```js
assert.equal(profile.name.value, 'Local progress');
assert.deepEqual(foundIds(profile), [42, 43]);
assert.deepEqual(profile.enabledTypes.value, ['o5', 'o6']);
assert.equal(profile.hideFound.value, true);
assert.equal(after.migrationComplete, true);
```

Run migration twice and after each injected crash boundary: exactly one profile remains. Missing source files create the initial local profile with current config defaults; malformed JSON, invalid IDs or malformed present filter values enter recovery with byte-for-byte originals and no completed flag. Test that settings normalization cannot overwrite malformed source bytes before migration reads them. Back up the raw legacy file(s) before conversion, including empty valid input.

- [ ] **Step 2: Run** `node --test tests/progress/migration.test.js`. Expected: FAIL on missing migration exports.
- [ ] **Step 3: Implement migration and non-destructive config loading.** Strictly accept legacy numeric positive safe IDs, deduplicate them, stamp true registers with the installation actor, and commit profile plus `migrationComplete` together. Preserve raw source bytes in bounded pre-migration backups and leave legacy files available. Once complete, never reimport late edits to legacy files automatically.
- [ ] **Step 4: Run** `node --test tests/progress/migration.test.js` and `npm run test:progress`. Expected: PASS across restarts, empty input and malformed-source cases.
- [ ] **Step 5: Commit** migration files and config changes: `git commit -m "feat: migrate legacy found progress with recovery backups"`.

### Task 4: Add profile operations and portable backup conversion

**Files:** Create `src/progress/profiles.js`, `src/progress/backup.js`, `tests/progress/profiles.test.js`, `tests/progress/backup.test.js`.

**Interfaces:**
- Consume `LocalEnvelope`, schema bounds and `nextClock()`.
- Produce pure draft-mutating `createProfile(draft:LocalEnvelope,{id:string,name:string,region:string},actor:string):string`, `renameProfile(draft:LocalEnvelope,{id:string,name?:string,region?:string},actor:string):void`, `setFound(draft:LocalEnvelope,{profileId:string,id:number,found:boolean},actor:string):void`, `setPreferences(draft:LocalEnvelope,{profileId:string,enabledTypes?:string[],hideFound?:boolean},actor:string):void` in `profiles.js`. Changed synced values advance the clock and set `dirtyRevision` to the transaction's new revision. Setting an existing register to its stored value is a no-op; explicitly setting an absent marker to false still creates a false register.
- Produce `exportBackup(state:ProgressState,profileIds:string[]):string`, `parseBackup(bytes:Buffer):PortableBackup`, `importProfiles(draft:LocalEnvelope,backup:PortableBackup,{actor:string,uuid:()=>string}):string[]`, `copyProfile(draft:LocalEnvelope,source:Profile,{id:string,actor:string}):string` in `backup.js`.
- `PortableBackup = {format:'genshin-map-overlay.backup',version:1,namespace:'appsample:gim:2',profiles:Array<{name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}>}`. It contains effective true IDs, no register metadata or source profile IDs.

- [ ] **Step 1: Write failing profile/backup tests.** Round-trip one/all profiles, including name `旅人 <img onerror=alert(1)>`, unknown ID/type, empty true-ID list and an explicit false register:

```js
assert.deepEqual(portable.profiles[0].foundIds, [42]); // marker 43 was explicitly false
assert.deepEqual(Object.keys(portable).sort(), ['format', 'namespace', 'profiles', 'version']);
assert.notEqual(importedId, PROFILE_A);
assert.equal(imported.name.actor, ACTOR_B);
assert.ok(imported.name.clock > previousMaxClock);
assert.deepEqual(existingProfileAfterImport, existingProfileBeforeImport);
```

Assert export uses an explicit whitelist and excludes credentials, actors/writer IDs, email, paths, pending uploads and active selection. Reject an invalid final profile, extra token/actor/clock fields, unsupported version or >4 MiB before any mutation. Copy/import produces new UUIDs and fresh clocks for every imported value, including explicit preferences; import never replaces an existing profile. Test independent name/region registers, canonical enabled types, false-on-absent creating an undo register, and repeated sets to the same stored value leaving its clock unchanged.

- [ ] **Step 2: Run** `node --test tests/progress/profiles.test.js tests/progress/backup.test.js`. Expected: FAIL on missing exports.
- [ ] **Step 3: Implement the declared operations and codecs.** Validate the entire portable document before touching a draft. Keep disk backup/transaction orchestration in the service (Task 9); these functions remain pure and must never receive tokens or filesystem paths. Copy only effective progress into a fresh profile and restamp it.
- [ ] **Step 4: Run** the focused command and `npm run test:progress`. Expected: PASS, including atomic rejection of the last invalid imported profile.
- [ ] **Step 5: Commit** the four files: `git commit -m "feat: add named profiles and portable progress backups"`.

### Task 5: Protect persisted credentials with asynchronous safeStorage

**Files:** Create `src/cloud/token-vault.js`, `tests/progress/token-vault.test.js`.

**Interfaces:**
- Consume `atomicWriteFile()` and `accountKeyFor()`.
- Produce `TokenVault({file:string,safeStorage:object,fs?})` with `read():Promise<VaultResult>`, `write(credentials:StoredCredentials):Promise<'saved'|'unavailable'>`, `clear():Promise<void>`.
- `StoredCredentials = {version:1,clientId:string,identity:{issuer:string,subject:string,email:string|null},refreshToken:string}`. `VaultResult = {kind:'ready',credentials:StoredCredentials} | {kind:'empty'|'unavailable'|'reconnect-required'}`. Access tokens stay outside this type.

- [ ] **Step 1: Write failing vault tests** with a fake asynchronous `safeStorage` and real temp files:

```js
assert.equal(await unavailableVault.write(credentials), 'unavailable');
assert.deepEqual(await fs.readFile(file), previousEncryptedBytes);
assert.equal((await undecryptableVault.read()).kind, 'reconnect-required');
assert.deepEqual(progressBytesAfter, progressBytesBefore);
```

Test round-trip `{result:plaintext,shouldReEncrypt:false}`, key rotation with `shouldReEncrypt:true`, temporary-unavailability rejection, encrypt/rename failure preserving old credentials, and `clear()` removing only credentials. Assert no file contains the refresh/access token plaintext; no synchronous `safeStorage` API is called.

- [ ] **Step 2: Run** `node --test tests/progress/token-vault.test.js`. Expected: FAIL on missing vault.
- [ ] **Step 3: Implement vault reads/writes after Electron readiness.** Use `isAsyncEncryptionAvailable()`, `encryptStringAsync()` and `decryptStringAsync()`, whose result is an object with `result`/`shouldReEncrypt`. On rotation, encrypt the recovered string again and atomically replace the blob only after success. Temporary unavailability preserves the good blob; permanent decryption failure requests reconnection without deleting progress. Session-only connections never overwrite a good vault entry with plaintext or empty data. See [Electron 45 API](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/safe-storage.md).
- [ ] **Step 4: Run** the focused test and `npm run test:progress`. Expected: PASS without loading Electron in Node.
- [ ] **Step 5: Commit** the two files: `git commit -m "feat: secure Google credentials with async safeStorage"`.

### Task 6: Implement system-browser desktop OAuth

**Files:** Create `src/cloud/oauth.js`, `src/cloud/oauth-config.js`, `tests/progress/oauth.test.js`. Modify `package.json:dependencies`, `package-lock.json`.

**Interfaces:**
- Consume `StoredCredentials`, verified identity/account-key rules and `TokenVault` through the service (not directly from OAuth).
- Produce `authorizeDesktop({clientConfig:ClientConfig,openExternal:(url:string)=>Promise<void>,signal:AbortSignal,oauthClientFactory?,createServer?,timers?}):Promise<AuthSession>`.
- `ClientConfig = {clientId:string,clientSecret?:string,environment:'development'|'production'}`; `loadOAuthConfig({isPackaged:boolean,env:object}):ClientConfig|null` reads a maintainer-configured public desktop-client object in this main-only module, with development overrides allowed only in unpackaged builds. Missing config disables Connect with `oauth-not-configured`, never local use.
- `AuthSession = {identity:{issuer:string,subject:string,email:string|null},refreshToken:string|null,getAccessToken({forceRefresh:boolean,signal:AbortSignal}):Promise<string>,onRefresh(callback:(refreshToken:string)=>Promise<void>):()=>void,dispose():void}`. Also produce `resumeSession(credentials:StoredCredentials,{clientConfig:ClientConfig,oauthClientFactory?}):AuthSession`; identity comes from the previously encrypted, verified binding. Refresh credentials use `onRefresh()` callbacks registered by the service after identity verification, never writes from OAuth itself.

- [ ] **Step 1: Write failing OAuth tests** with an injected OAuth client/system-browser opener and an ephemeral loopback server:

```js
assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
assert.equal(url.searchParams.get('access_type'), 'offline');
assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set([
  'openid', 'email', 'https://www.googleapis.com/auth/drive.appdata',
]));
assert.equal(callbackBind.host, '127.0.0.1');
assert.equal(callbackBind.port, 0);
assert.equal(verifyArgs.audience, clientConfig.clientId);
```

Test wrong method/path/state, duplicate query fields, denial, duplicate callback, 300,000 ms timeout, browser-open failure and AbortSignal cancellation. Reject invalid issuer/audience/expiry or missing subject before returning a session. Assert server/sockets/timers are closed on every exit. Refresh omitting a refresh token retains the session's existing one; account B cannot inherit account A's token. A canceled token exchange cannot return an activatable session. Never log callback URLs/codes/tokens.

- [ ] **Step 2: Run** `node --test tests/progress/oauth.test.js`. Expected: FAIL on missing OAuth module/dependency.
- [ ] **Step 3: Add `google-auth-library` as a production dependency** using a compatible current 10.x release; `10.5.0` is the primary-source baseline checked for this plan. Preserve unrelated package edits, regenerate lock metadata with the supported Node/npm toolchain, and keep both root versions equal to `package.json` (currently `1.1.0`). See [library package metadata](https://github.com/googleapis/google-auth-library-nodejs/blob/main/package.json).
- [ ] **Step 4: Implement the declared OAuth/config exports.** Use `OAuth2Client`, its PKCE/token APIs and `verifyIdToken({idToken,audience})`; verify accepted issuer and nonempty subject before normalizing identity. Bind a random port before opening the system browser, use `/oauth2/callback`, random state and S256, accept exactly one matching callback, and clean up in `finally`. Scope denial is actionable; retrying consent is an explicit user action. Do not use ADC/service accounts. Follow [Google's desktop flow](https://developers.google.com/identity/protocols/oauth2/native-app).
- [ ] **Step 5: Run** the focused test, `npm run test:progress`, and `npm ls google-auth-library --omit=dev`. Expected: PASS and one production auth dependency with no missing packages.
- [ ] **Step 6: Commit** OAuth files and only dependency/lockfile changes owned by this task: `git commit -m "feat: connect Google accounts with desktop OAuth and PKCE"`.

### Task 7: Add the versioned snapshot codec and narrow Drive adapter

**Files:** Create `src/cloud/snapshot.js`, `src/cloud/drive.js`, `src/cloud/errors.js`, `tests/progress/snapshot.test.js`, `tests/progress/drive.test.js`, `tests/progress/errors.test.js`.

**Interfaces:**
- Consume `ProgressState`, `AuthSession`, schema limits and `ProgressError`.
- Produce `makeSnapshot(state:ProgressState,{writerId:string,generation:number}):RemoteSnapshot`, `encodeSnapshot(doc:RemoteSnapshot):{body:string,hash:string}`, `decodeSnapshot(bytes:Buffer):RemoteSnapshot`.
- `RemoteSnapshot = {format:'genshin-map-overlay.progress',version:1,writerId:string,generation:number,state:ProgressState}`. Generation is a positive safe integer. Encode deterministic UTF-8 JSON with recursively sorted object keys; hash the exact bytes with SHA-256.
- Produce `DriveAdapter({fetch:Function,auth:AuthSession})` with `listSnapshots({signal}):Promise<DriveFile[]>`, `generateFileId({signal}):Promise<string>`, `readSnapshot(id:string,{signal}):Promise<{body:string,hash:string,document:RemoteSnapshot}>`, `createSnapshot(pending:PendingPublication,{signal}):Promise<void>`, `deleteSnapshot(id:string,{signal}):Promise<void>`. `DriveFile = {id:string,appProperties:object,size:string,mimeType:string}`.
- Produce `classifyCloudError(error:unknown):{code:string,retryable:boolean,refreshOnce:boolean}`. Codes include `network`, `rate-limit`, `server`, `reconnect-required`, `scope-denied`, `account-policy`, `drive-quota`, `remote-invalid`, `protocol-newer`, `publication-conflict`, `remote-not-found`, `aborted`. Only codes/HTTP reason allowlists are loggable.

- [ ] **Step 1: Write failing wire/REST/error tests.** Use injected `fetch` responses and record request URLs/headers/bodies:

```js
assert.equal(listUrl.searchParams.get('spaces'), 'appDataFolder');
assert.equal(generateUrl.searchParams.get('space'), 'appDataFolder');
assert.deepEqual(uploadMetadata.parents, ['appDataFolder']);
assert.equal(uploadMetadata.id, pending.fileId);
assert.equal(uploadMetadata.mimeType, 'application/json');
assert.equal(encodeSnapshot(decodeSnapshot(Buffer.from(body))).hash, hash);
```

Test all pages, an empty intermediate page with a next token, repeated-token/incomplete-list errors, 404 between list/get, abort, oversized streamed body, metadata/content mismatch, forged tags, malformed recognized content and newer protocol. On ambiguous create retry returning 409, read/validate the existing exact ID/body/hash before success; mismatched content returns `publication-conflict`. Assert a newer-version file is discoverable because listing filters by app identity, not version 1 alone. Table-test network/429/rate-limit 403/5xx as retryable; quota/policy/denied scope as distinct nonretryable states; 401 permits one refresh/retry only. Unrecognized unrelated files are ignored, never deleted.

- [ ] **Step 2: Run** `node --test tests/progress/snapshot.test.js tests/progress/drive.test.js tests/progress/errors.test.js`. Expected: FAIL on missing modules.
- [ ] **Step 3: Implement snapshot encoding/validation and error classification.** Wire/export schemas whitelist fields and exclude selection, email, credentials and local paths. Strictly reject recognizable malformed/newer envelopes; never downgrade them to empty state. Bound download bytes while reading, not only from untrusted Content-Length.
- [ ] **Step 4: Implement the Drive REST methods.** Use v3 `files.list`, `files.generateIds`, `files.get?alt=media`, multipart `files.create` and `files.delete`. Tag metadata with `app=genshin-map-overlay`, protocol/version, writer/generation/hash; validate body and tags on discovery. Use the 4 MiB cap to stay below multipart's 5 MB guidance. Disable implicit transport retries so the worker controls scheduling. Keep bearer tokens in headers and handle one forced refresh on authorization failure. References: [app data](https://developers.google.com/workspace/drive/api/guides/appdata), [generated IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds), [safe upload retries](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
- [ ] **Step 5: Run** the focused command and `npm run test:progress`. Expected: PASS with zero real Google requests and no sensitive error-body output.
- [ ] **Step 6: Commit** the six files: `git commit -m "feat: add immutable Drive snapshot protocol and transport"`.

### Task 8: Implement serialized pull/publish/retry lifecycle

**Files:** Create `src/cloud/sync-worker.js`, `tests/progress/sync-worker.test.js`.

**Interfaces:**
- Consume `ProgressRepository`, `DriveAdapter`, snapshot codec, merge and error classifier.
- Produce `SyncWorker({repository:ProgressRepository,scope:Scope,writerId:string,drive:DriveAdapter,isCurrent:()=>boolean,onStatus:(status:object)=>void,timers?,now?:()=>number,random?:()=>number})` with `start():void`, `markDirty():void`, `syncNow():Promise<void>`, `suspend():void`, `resume():void`, `restoreCachedToDrive():Promise<void>`, `stop():Promise<void>`.
- Worker captures one service session generation via `isCurrent`; every async result checks it before committing. Status phases: `pending`, `syncing`, `synced`, `offline`, `reconnect-required`, `error`; local-only is supplied by the service.

- [ ] **Step 1: Write failing worker tests** with fake timers, a scripted Drive adapter and real repository restarts:

```js
// 'new local edit survives pending acknowledgement': pending revision 5, local revision 6.
assert.equal(after.acknowledgedRevision, 5);
assert.equal(after.dirtyRevision, 6);
assert.equal(after.sync.pending, null);
// 'restart reuses the same immutable publication after timeout'.
assert.equal(secondCreate.fileId, firstCreate.fileId);
assert.equal(secondCreate.body, firstCreate.body);
assert.equal(secondCreate.generation, firstCreate.generation);
```

Pin crash points before/after pending-body commit, generated-ID persistence, upload and acknowledgement. No upload occurs before both body and ID are durable. Test edits coalesce at 2,000 ms; polls run at 60,000 ms; manual/startup/resume/reconnect pull before publishing; simultaneous triggers never overlap. Merge every valid discovered generation, not just the newest per writer. Missing get results trigger relisting and retain state. A successful complete empty listing after `everSynced:true` sets `requiresCloudRestore` and forbids even a pending create until `restoreCachedToDrive()`; a fresh empty account may publish normally.

Also test malformed/newer discovered files block upload/cleanup while keeping current progress; same ID with changed hash is corruption. Cleanup retains this writer's newest two acknowledged valid snapshots and cannot delete another writer/unknown version; cleanup failure leaves sync successful. Stop/suspend cancel timers and in-flight requests. Backoff stays within 300,000 ms and resets after success; sleep makes no polling requests. No background action opens OAuth.

- [ ] **Step 2: Run** `node --test tests/progress/sync-worker.test.js`. Expected: FAIL on missing worker.
- [ ] **Step 3: Implement discovery and durable merge.** Complete the entire paginated listing/download validation before publication; cache immutable validated contents by ID/hash within this account's worker and persist merged state plus `knownFiles`. Only a changed merge marks the account dirty, without restamping remote registers. Raise the stored clock to at least the maximum observed clock. After a complete listing, prune metadata/cache entries for missing files without erasing any registers; bound current discoveries/cache and never truncate a listing to fit.
- [ ] **Step 4: Implement immutable publication and acknowledgement.** Persist one full merged body/hash/new generation/revision, then generated ID, then create/reconcile 409, then acknowledge in a transaction. If merging changes state while an older pending body exists, finish the old immutable body and publish the newer dirty revision next. Cleanup uses validated writer IDs/generations only after durable successor acknowledgement.
- [ ] **Step 5: Implement scheduling and recovery actions.** Use one cycle promise and one coalesced follow-up flag. Retry only classified transient failures with full jitter `random() * min(300000, 1000 * 2**attempt)`; manual Sync now cancels waiting backoff and requests one immediate cycle. Respect Retry-After within the cap. Quota/recovery/protocol/auth states wait for an actionable change. Restore cached progress requires an explicit service command, durably clears the restore gate and prepares a fresh generation when appropriate.
- [ ] **Step 6: Run** the focused test and `npm run test:progress`. Expected: PASS for all crash/retry/timing cases with deterministic fake time.
- [ ] **Step 7: Commit** the two files: `git commit -m "feat: sync scoped progress with durable immutable publications"`.

### Task 9: Own account sessions and local mutations in one service

**Files:** Create `src/progress/service.js`, `tests/progress/service.test.js`.

**Interfaces:**
- Consume Tasks 2–8. Produce `ProgressService({repository,vault,authorize,resumeSession,workerFactory,uuid,clientConfig,onSnapshot})`.
- Methods: `initialize({userData:string}):Promise<PublicSnapshot>`, `snapshot():PublicSnapshot`, `setFound(context:Context,{id:number,found:boolean}):Promise<Result<PublicSnapshot>>`, `setPreferences(context:Context,patch:{enabledTypes?:string[],hideFound?:boolean}):Promise<Result<PublicSnapshot>>`, `createProfile({sessionGeneration:string,name:string,region:string}):Promise<Result<PublicSnapshot>>`, `renameProfile(context:Context,patch:{name?:string,region?:string}):Promise<Result<PublicSnapshot>>`, `selectProfile(context:Context):Promise<Result<PublicSnapshot>>`.
- Connection/recovery methods: `connect({persistence:'persistent'|'session'}):Promise<Result<PublicSnapshot>>`, `disconnect():Promise<Result<PublicSnapshot>>`, `selectLocal():Promise<Result<PublicSnapshot>>`, `copyLocalProfile({sessionGeneration:string,localProfileId:string}):Promise<Result<PublicSnapshot>>`, `importBackup({sessionGeneration:string,bytes:Buffer}):Promise<Result<PublicSnapshot>>`, `exportBackup({sessionGeneration:string,profileIds:string[]}):Promise<Result<string>>`, `syncNow():Promise<Result<PublicSnapshot>>`, `restoreCachedToDrive({sessionGeneration:string}):Promise<Result<PublicSnapshot>>`, `restoreLocalBackup({sessionGeneration:string}):Promise<Result<PublicSnapshot>>`, `startBackground():void`, `suspend():void`, `resume():void`, `shutdown():Promise<void>`.

- [ ] **Step 1: Write failing ownership/service tests.** Use deferred OAuth/refresh/download/upload promises to switch A → B before resolving A:

```js
assert.equal((await service.setFound(oldContext, { id: 42, found: true })).error.code, 'stale-context');
assert.deepEqual(await repository.load(accountB), beforeB);
assert.equal(uploadsUsingBAuth.some(x => x.body.includes(accountAOnlyProfileId)), false);
assert.equal(service.snapshot().account.email, 'b@example.test');
```

Assert old callbacks cannot overwrite `credentials.enc`, status or acknowledgements, even after cancellation returns. Test startup local migration before first snapshot; saved disconnected scope survives restart without Google; switching local/account drains old local writes; selection is local and absent from uploads. Connect never auto-copies local progress, decline preserves it, explicit copy creates a fresh cloud UUID/clocks, and a previously cached account is reused only after verified matching identity. Imports take a pre-import backup and commit all new profiles in one transaction. Failed backup/import/credential write preserves progress. Corrupt startup state returns a recovery snapshot with writes/sync blocked; explicit `restoreLocalBackup()` restores only a validated backup and retains original bytes. A refresh-token omission reuses a token only for the same verified identity and client ID. Session-only is an explicit option, never a silent plaintext fallback. Quit drains local writes while a never-resolving Drive call is aborted.

- [ ] **Step 2: Run** `node --test tests/progress/service.test.js`. Expected: FAIL on missing service.
- [ ] **Step 3: Implement local operations and snapshot projection.** Recheck context at commit, apply profile draft operations in repository transactions and acknowledge only durable state. Generate monotonic per-session `viewVersion`, derive complete active-profile state and report safe `Result` errors. No active profile is allowed on an empty new account; expose Create profile. A load/migration error returns a read-only recovery snapshot instead of preventing the settings window from opening. Expose validated last-good recovery as an explicit action. Preserve the last account's cached profiles after Disconnect and make Local only an explicit scope switch.
- [ ] **Step 4: Implement account lifecycle and import/copy orchestration.** Invalidate generation and abort old callbacks/workers before activating another connection. Verify identity before selecting a hashed store; commit credentials/binding only if the attempt is still current. On canceled/failed connection keep the prior cache usable and permit reconnection, without a mixed-account upload. Refresh persistence callbacks capture identity, client and generation; serialize credential commits with connection transitions so an in-flight vault write cannot replace a new binding. Bound-account offline edits stay in that account. Flush each old scope before selection/connection transition; ensure import/dialog/export results are rechecked after awaiting. `initialize()` constructs but does not start a resumed worker; `startBackground()` starts it after the initial windows are ready.
- [ ] **Step 5: Run** the focused test and `npm run test:progress`. Expected: PASS with no account cross-contamination and no network requirement.
- [ ] **Step 6: Commit** the two files: `git commit -m "feat: isolate progress mutations and Google account sessions"`.

### Task 10: Build trusted IPC and the Electron lifecycle adapter

**Files:** Create `src/progress/ipc.js`, `src/progress/runtime.js`, `tests/progress/ipc.test.js`, `tests/progress/runtime.test.js`. Keep the running app on its existing persistence path until Task 11 switches main and overlay together.

**Interfaces:**
- Consume `ProgressService` and `PublicSnapshot`. Produce `registerProgressIpc({ipcMain,service,getOverlayWindow,getSettingsWindow,openSettings?,onNetworkOnline,dialogs}):()=>void` and `createProgressRuntime({app,safeStorage,shell,powerMonitor,net,log,onSnapshot}):Promise<ProgressRuntime>`.
- `ProgressRuntime = {service:ProgressService,startBackground:()=>void,networkOnline:()=>void,shutdown:()=>Promise<void>}`. Construction awaits service initialization; it does not start background sync. Main will call `startBackground()` after window creation in Task 11. OS hooks call service methods and return disposer functions internally. `networkOnline()` checks main's `net.isOnline()` before asking the service for a reconnect pull; workers still classify real network failures independently.
- Define the preload contract consumed by Task 11: `getProgress():Promise<Result<PublicSnapshot>>`, `setFound(context:Context,change:{id:number,found:boolean}):Promise<Result<PublicSnapshot>>`, `setProfilePreferences(context:Context,patch:{enabledTypes?:string[],hideFound?:boolean}):Promise<Result<PublicSnapshot>>`, `selectProfile(context:Context):Promise<Result<PublicSnapshot>>`, `openCloudSettings():Promise<Result<null>>`, and allowlisted `progress:snapshot` events. `openSettings` is a main-owned callback, supplied by Task 12 when its window exists.
- IPC channels: `progress:get`, `progress:set-found`, `progress:set-preferences`, `progress:select-profile`, `progress:network-online`, `cloud:open-settings`, plus settings-only `cloud:command` with the Task 12 operation allowlist. The overlay preload sends a no-payload `progress:network-online` hint on its browser `online` event; validate its window/top frame and call `onNetworkOnline`. This does not expose HTTP control. Main-only file dialogs return bytes internally; IPC never accepts renderer paths. Until Task 12 supplies `openSettings`, its handler returns `settings-unavailable` safely.

- [ ] **Step 1: Write failing IPC/lifecycle tests.** Send valid-looking requests from tracker, another window and a child frame of the overlay:

```js
assert.equal(reply.error.code, 'unauthorized-sender');
assert.equal(serviceMutationCalls, 0);
assert.equal((await staleDialogReply).error.code, 'stale-context');
assert.equal(initialSnapshot.activeProfile.name, 'Local progress');
```

Assert `event.sender === expectedWindow.webContents` and `event.senderFrame === expectedWindow.webContents.mainFrame` are both required. Reject numeric strings, NaN, unknown operations, extra keys, oversized labels/arrays, profile IDs from another scope and renderer file paths. Test a real import-dialog continuation after switching accounts and after window destruction. Runtime tests assert readiness → migration/load → windows' initial snapshot → background worker order; suspend/resume and reconnect hooks; before-quit local flush without waiting for Drive; helper process never initializes progress/OAuth.

- [ ] **Step 2: Run** `node --test tests/progress/ipc.test.js tests/progress/runtime.test.js`. Expected: FAIL on missing integration exports.
- [ ] **Step 3: Implement IPC validation and runtime composition.** Keep dependencies injectable for Node tests. Main dialogs apply the 4 MiB bound before decoding, capture scope/session before opening, and recheck afterward. Export cancellation is a safe result, not an error toast. No arbitrary HTTP/file APIs or tokens are exposed. Validate settings operations against the service signatures; add their window-specific command registration in Task 12.
- [ ] **Step 4: Implement runtime startup/background/shutdown boundaries.** Load configuration for migration without overwriting malformed sources, initialize progress, and allow main to start the worker only after its first profile snapshot/window initialization. Register `powerMonitor` suspend/resume listeners and implement the validated reconnect-hint callback with main-owned dependencies. `shutdown()` detaches hooks, aborts the worker and drains local/credential queues without awaiting a Drive response. This adapter is independently testable before the application cutover.
- [ ] **Step 5: Run** `node --test tests/progress/ipc.test.js tests/progress/runtime.test.js` and `npm run test:progress`. Expected: PASS; the unchanged running app still uses FoundStore until Task 11.
- [ ] **Step 6: Commit** the four new files: `git commit -m "feat: add trusted progress IPC and Electron lifecycle adapter"`.

### Task 11: Switch main and overlay to authoritative profile state

**Files:** Create `src/overlay/progress-view.js`, `tests/progress/overlay-progress.test.js`. Modify `src/main.js:7-14,92-96,112-150,215-223,311-323,392-395,478-495,634-676`, `src/config.js:45-86`, `src/overlay/overlay.js:13-21,421-448,648-670,799-805,833-844,879-925`, `src/overlay/index.html:58-64,108-111`, `src/overlay/overlay.css`, `src/overlay/preload.js:4-20`, `src/shared/i18n.js`. Delete `src/data/found.js` only after main and renderer integration passes. Extend `tests/progress/runtime.test.js` for the application cutover.

**Interfaces:**
- Consume Task 10 runtime/IPC exports, its declared preload contract and `PublicSnapshot`.
- Produce a CommonJS/browser-compatible `createProgressView({send:(context:Context,change:{id:number,found:boolean})=>Promise<Result<PublicSnapshot>>,onChange:(snapshot:PublicSnapshot)=>void,onError:(error:object)=>void})` with `apply(snapshot:PublicSnapshot):void`, `setFound(id:number,found:boolean):Promise<void>`, `snapshot():PublicSnapshot|null`.
- The view keeps a durable authoritative snapshot plus ordered local intentions. It projects immediate optimistic state, serializes marker requests, ignores old-session/older-version replies and never marks an intention durable before success.

- [ ] **Step 1: Write failing overlay reconciliation tests.** Use deferred send replies and record `onChange` snapshots:

```js
// 'rapid mark then undo stays immediate while first commit is pending'.
assert.deepEqual(view.snapshot().activeProfile.foundIds, []);
// 'failed write restores durable state and reports once'.
assert.deepEqual(finalSnapshot.activeProfile.foundIds, durableFoundIds);
assert.equal(errors[0].code, 'local-write-failed');
// 'an old-profile reply cannot replace a newly selected profile'.
assert.equal(view.snapshot().activeProfile.id, PROFILE_B);
```

Pin earlier-success/later-failure ordering, remote updates during pending edits and no wrong-profile rollback. Through `onChange` spies assert one profile replacement requests found-set/counter/filter replacement and closes the spot; a remote update in the same profile refreshes its found button. Unknown found IDs persist even when absent from marker arrays; counters count known dataset IDs only and cannot underflow. Preserve unknown enabled-type keys when changing one currently visible type.

- [ ] **Step 2: Run** `node --test tests/progress/overlay-progress.test.js`. Expected: FAIL on missing view module.
- [ ] **Step 3: Implement the view controller and connect existing rendering.** Replace optimistic toggle IPC with `view.setFound(id,!currentFound)`. Apply complete snapshot state in one synchronous render turn, rebuilding counts/filters and refreshing `renderSpotFound()` for same-profile updates; close spot/lightbox on profile change. Use a small callback adapter so tests exercise the actual replacement/refresh decision, not copied renderer logic. Prevent old `settings` messages from resetting profile preferences. Reconcile failure to the returned authoritative snapshot plus still-pending newer intentions and show a localized error.
- [ ] **Step 4: Switch main/preload/config to the same progress path.** Initially use `config.load({preserveMalformed:true})`; await runtime initialization before creating windows/initial messages, register new IPC, emit one complete snapshot, then start background sync. Implement the Task 10 preload contract/reconnect hint and remove the old toggle/found events. Remove profile filters from `publicSettings()`/`overlay:settings` and global config saves after migration; retain raw legacy values for recovery. Route F9 through profile preference mutation, and keep reload-settings from changing active filters. On quit, prevent recursive quit, stop requests/timers, await only local/config flush and call `app.quit()` again. Remove FoundStore only after both sides use the new path. Add runtime assertions for these integration points.
- [ ] **Step 5: Add compact profile/status controls and local focus handling.** Add a select control in the existing panel; use the overlay keyboard focus bridge for the selector and release focus on blur/Escape. Show sync status separately from tracker status; use textContent for labels. Persist filter changes via `setProfilePreferences()` with context; keep opacity/capture/marker-size on the local path. Preserve valid unknown type keys rather than reconstructing the preference from today's type table. Task 12 adds the settings shortcut when its window is available.
- [ ] **Step 6: Run** `node --test tests/progress/overlay-progress.test.js tests/progress/runtime.test.js`, `npm run test:progress`, and syntax checks for main/preload/overlay scripts. Run `rg -n 'FoundStore|overlay:found-toggle|found:all|found:changed' src`; expected: no matches (exit 1), all tests/syntax PASS. Manually check right-click/spot button, F9, selector keyboard focus and counters in `npm start` without Google.
- [ ] **Step 7: Commit** the listed main/config/overlay/test files and retired store: `git commit -m "feat: integrate durable profile state into main and overlay"`.

### Task 12: Add the cloud/profile settings window

**Files:** Create `src/settings/window.js`, `src/settings/index.html`, `src/settings/preload.js`, `src/settings/settings.js`, `src/settings/settings.css`, `tests/progress/settings.test.js`. Modify `src/main.js:createTray/updateTrayMenu`, `src/progress/ipc.js`, `src/overlay/index.html`, `src/overlay/overlay.js`, `src/shared/i18n.js`.

**Interfaces:**
- Consume service methods through trusted IPC and shared I18n.
- Produce `createSettingsWindow({BrowserWindow,parent?,onClosed?}):BrowserWindow` in `window.js`. Reopen/focus the one existing normal window rather than creating duplicates.
- Dedicated preload exposes `cloudApi.getState():Promise<Result<PublicSnapshot>>`, `cloudApi.command(operation:string,payload:object):Promise<Result<unknown>>`, `cloudApi.onSnapshot(callback:(snapshot:PublicSnapshot)=>void):()=>void`. Allowed commands: `connect`, `disconnect`, `select-local`, `create-profile`, `rename-profile`, `select-profile`, `sync-now`, `copy-local-profile`, `import`, `export`, `restore-cached`, `restore-local`. Payloads mirror Task 9 service arguments; import supplies only `sessionGeneration` and main obtains bytes from its picker, export adds `profileIds` and main chooses the destination. Validate exact operation payloads; renderer paths are never accepted.

- [ ] **Step 1: Write failing window/command tests** with injected BrowserWindow/IPC stubs:

```js
assert.equal(options.webPreferences.sandbox, true);
assert.equal(options.webPreferences.contextIsolation, true);
assert.equal(options.webPreferences.nodeIntegration, false);
assert.equal(secondOpen, firstWindow);
assert.equal(result.error.code, 'invalid-operation'); // renderer requests arbitrary HTTP
assert.notEqual(I18n.t('de', 'cloud.connect'), 'cloud.connect');
assert.notEqual(I18n.t('en', 'cloud.connect'), 'cloud.connect');
```

Test command allowlists, parent-frame rejection, window close/reopen subscriptions, EN/DE status/error key parity, canceled dialogs, and Unicode/HTML-like names rendered as text. Verify Connect/unavailable-vault flow offers session-only or reconnect later; the empty-account view offers Create profile; disconnect leaves bound profiles editable offline. No technical IDs or OAuth configuration fields appear in the user UI.

- [ ] **Step 2: Run** `node --test tests/progress/settings.test.js tests/progress/ipc.test.js`. Expected: FAIL on missing window/settings command support.
- [ ] **Step 3: Implement window creation and the settings-only IPC allowlist.** Use local assets/scripts, a dedicated preload, strict local CSP and normal focusable window behavior. Block unexpected navigation/new windows. Add EN “Cloud sync & profiles” / DE “Cloud-Sync & Profile” tray entries and an overlay shortcut routed to the same window. Keep window construction in its module and main orchestration small.
- [ ] **Step 4: Implement settings controls and EN/DE copy.** Display optional connection, account email, profile name/region create/rename/select, separate local-only selection, Sync now, Disconnect, import/export one/all, explicit local-progress copy and explicit “Restore cached progress to Drive”. Offer a separate validated last-good local-backup recovery action in local-data recovery state; unavailable backups leave originals intact with recovery instructions. On first successful connection list cloud profiles and offer copy; decline preserves local profiles. Show last-success time and distinct pending/syncing/offline/reconnect/quota/policy/scope/local-data/newer-protocol states with the appropriate retry/reconnect/update/recovery action. Never add automatic login prompts or deletion/archive controls.
- [ ] **Step 5: Run** focused tests, `npm run test:progress` and syntax checks for settings scripts. Expected: PASS. Manually test focus, repeated open/close, language changes, canceled import/export, long valid names, reconnect failure and independent tracker status on Windows/macOS during final acceptance.
- [ ] **Step 6: Commit** settings window, IPC/tray and translation changes: `git commit -m "feat: add cloud sync and profile settings window"`.

### Task 13: Verify integration, packaging, privacy and two-device acceptance

**Files:** Create `tests/progress/acceptance.test.js`, `tools/check-progress-package.js`, `docs/google-drive-setup.md`, `server/public/privacy.html`. Modify `package.json:engines/build.files/scripts`, `package-lock.json` only if dependency metadata changes, `.github/workflows/mac.yml`, `README.md`, `README.de.md`, `server/public/index.html`.

**Interfaces:**
- Consume the real service/worker with injected OAuth and fake Drive; no duplicate merge algorithm in tests.
- Produce `node tools/check-progress-package.js <resources/app.asar|unpacked-app-root>`: exit 0 only when the package resolves `google-auth-library` and all transitive runtime dependencies, includes settings/preload scripts and main-only OAuth config, and excludes `.env*`, `credentials.enc`, runtime `progress/` data and service-account/private-key material. Use the builder-installed `@electron/asar` (currently `3.4.1` in the lockfile) to extract an ASAR into a temporary directory, then `module.createRequire()` from the extracted root to validate the production dependency closure. Remove temporary extraction in `finally`. Add `"check:progress-package": "node tools/check-progress-package.js"`. A missing real production client ID remains a separately reported release gate, not a reason to prevent a local-only development package.

- [ ] **Step 1: Write the failing whole-feature acceptance tests.** Run two repositories/writer UUIDs against one in-memory Drive, plus another isolated fake Google account:

```js
assert.deepEqual(deviceA.snapshot().activeProfile.foundIds, [42, 43]);
assert.deepEqual(deviceB.snapshot().activeProfile.foundIds, [42, 43]);
// B pulls A's found 42, then deliberately undoes it; both pull again.
assert.deepEqual(deviceA.snapshot().activeProfile.foundIds, [43]);
assert.deepEqual(otherGoogleAccount.snapshot().profiles, []);
```

Include independent offline profile creation; same-marker offline deterministic ties without wall-clock assumptions; explicit edit after observing merge; restart with pending upload; export/import without auth; active selection/opacity/language/capture settings staying device-local; disconnect/reconnect to another Google account; and sensitive-data absence in uploaded/exported bodies. Assert runtime packaging checks fail for a fixture missing the auth dependency or settings preload.

- [ ] **Step 2: Run** `node --test tests/progress/acceptance.test.js`. Expected: missing package checker/new acceptance assertions fail before delivery changes; existing sync behavior tests should already pass. If they do not, repair the owning module and rerun its focused tests before proceeding.
- [ ] **Step 3: Update packaging and build validation.** Set `engines.node` to `>=22.12.0`, use Node `22.12.0` or newer compatible 22.x in the Mac workflow, and run `npm run test:progress` before packaging. Ensure electron-builder's explicit `build.files` includes the auth dependency's complete production closure, not just its top-level JS file. Keep the existing app identity consistent across supported production builds; choose a separate development Cloud project. Add package validation after building and before release-upload steps. Do not run the publishing workflow or change an unrelated Wrangler version.
- [ ] **Step 4: Update user/maintainer documentation and static privacy copy.** Both READMEs explain optional Drive upload, exact synced fields, offline use, conflict semantics, separate Genshin/Google profiles, disconnect/cache retention, export/import and hidden-data deletion/recovery. Keep screen-capture-local promises accurate. Add a bilingual privacy page linked from the website/footer and update user/release links to `mikilimj/GenshinMapOverlay`, preserving upstream/AppSample credit. `docs/google-drive-setup.md` records Cloud project/Drive API/Desktop client/scopes, separate test/production configuration, public-client configuration limitations, Testing-mode tester/grant restrictions, production privacy URL and publishing prerequisites. The shipped app must support local use with missing config; real production config/public privacy hosting are maintainer release gates, not user setup requirements. Do not invent a deployed URL or publish it.
- [ ] **Step 5: Run automated delivery checks.** Run `npm run test:progress`, `npm ls --omit=dev`, and `git diff --check`. On macOS run `npm run dist:mac` then `npm run check:progress-package -- "dist/mac-arm64/Genshin Map Overlay.app/Contents/Resources/app.asar"`; on Windows run `npm run dist -- --publish never` then the checker on `dist/win-unpacked/resources/app.asar`. If packaging produces an unpacked app directory, pass that path instead. Expected: tests/checker PASS and auth dependency/config/settings present. Run existing `npm run test:match` only when its required fixtures/cache are available; document unavailable prerequisites instead of triggering unrelated bulk downloads.
- [ ] **Step 6: Record real packaged acceptance results in `docs/google-drive-setup.md`.** Use a Windows client and Apple Silicon Mac with the same production app/Cloud identity, two actual Google accounts and at least two named Genshin profiles each. Verify independent offline marker edits/undo, concurrent profile creation/rename/preferences, local-only opt-in copy, no account leakage, app restart/credential persistence, session-only connection, revocation/reconnect, suspend/resume, cloud deletion/explicit restore, backup recovery, profile selector/spot/counters/focus and existing capture/tracker/hotkey behavior. Repeat cross-build access after an update/ad hoc Mac signature; a new Keychain prompt must preserve progress. Use a separate test project during development; do not infer production cross-build storage access from one fake transport. Mark unavailable device/production configuration checks as pending release gates, never as passed.
- [ ] **Step 7: Commit** the listed delivery/test/docs/site changes only: `git commit -m "feat: document and validate Google Drive progress sync delivery"`. Do not push, publish OAuth configuration, deploy the site or release binaries as part of this plan.

## Self-review and handoff

Coverage: schema/merge → Task 1; persistence/recovery → Task 2; migration → Task 3; profiles/backups → Task 4; secure storage/OAuth → Tasks 5–6; immutable Drive protocol/errors/lifecycle → Tasks 7–8; account ownership → Task 9; trusted IPC/startup/quit → Task 10; overlay/settings UX → Tasks 11–12; production configuration/privacy/builds/two-device acceptance → Task 13. Each Review Focus item has a named owning test step above. No implementation or product deployment is included in the planning commit.

Recommended execution: **Subagent-driven**, because the 13 tasks share data-loss and account-isolation contracts that benefit from independent review at each boundary. After the human reviews this plan, preserve their selected execution method. Native execution remains a lower-cost option with one independent whole-branch review at the end. Real-device and production OAuth checks require the maintainer's configured clients/devices; automated development tests do not.
