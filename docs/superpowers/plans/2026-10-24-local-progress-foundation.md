# Local Progress Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single legacy found-marker file with named local profiles, explicit durable edits, portable backups and authoritative overlay updates, providing the shared prerequisite for map transfers and future Drive sync.

**Architecture:** One main-process service serializes profile selection and edits through an atomic repository. Canonical progress uses the register model already specified by the Drive plan; local transfer metadata will extend its persistence envelope without entering canonical state. Renderers consume complete snapshots through narrowly validated IPC.

**Tech Stack:** Existing Electron 45/CommonJS/vanilla JavaScript, Node built-in `node:test`, `node:fs/promises` and `node:crypto`; no new runtime dependencies. Use Node `>=22.12.0`, matching the existing Drive plan.

**Spec:** [Map-save interoperability design](../specs/2026-10-24-map-save-interoperability-design.md), especially “Storage and application integration.” Coordinate with [the existing Drive implementation plan](2026-10-24-google-drive-sync.md) and [the transfer plan](2026-10-24-map-save-interoperability.md).

## Global Constraints

- “Use the existing Electron/CommonJS/vanilla-JavaScript architecture and EN/DE translations.”
- “The app's progress identity stays `appsample:gim:2` plus stable marker ID for current Teyvat progress, matching the Google Drive proposal.”
- “Local false/undo registers remain meaningful in the progress model, but first-release site exports only add confirmed found states.”
- “A prerequisite is its local subset: migration from `found.json`, named local profiles, explicit set operations, atomic persistence, backups and complete-state notifications.”
- “Website transfer does not depend on OAuth, a Google Cloud project or the Drive worker.”
- “A transfer attachment and canonical state must commit/recover together.”
- “Failed validation or persistence leaves the original profile intact.”

## Review Focus

1. Corrupt legacy settings are currently overwritten by `config.load()`; migration must preserve their original bytes and enter recovery (Task 3).
2. Disk failure after a rapid mark/undo must reconcile the overlay to durable state without reviving an older intention (Tasks 2, 6).
3. Switching A → B → A during a pending operation must invalidate the earlier selection, even though its profile ID matches again (Tasks 4–6).
4. Unknown catalog IDs/type keys and Unicode/HTML-like profile names must survive storage and backup without becoming markup (Tasks 1, 4, 6).
5. Closing the application with queued edits must drain local persistence, including a failed write, without starting a second quit loop (Task 6).

---

## Scope, coordination and file map

This is an independently usable prerequisite: local profiles and backups work before any website adapter exists. It extracts the local portions of Drive Tasks 1–4 and 9–12; do not execute both plans' duplicate tasks. If those modules have landed when execution starts, inspect and reuse them, adding only missing behavior/tests. OAuth, credentials, HTTP transport and Drive scheduling remain in the Drive plan.

The Drive design is tracked but deleted in the planning working tree. Its historical copy was consulted read-only for paths/register semantics; do not restore it as part of this work. Treat its old branch/push instructions as document context, not authorization. No branch name or execution method has been chosen for this feature.

At planning time, `package.json`, `package-lock.json` and research/spec files have unrelated changes. Preserve them. During execution use an isolated checkout as required by the execution skill; stage only owned hunks. This plan itself changes documentation only.

| Files | Responsibility |
| --- | --- |
| `src/progress/schema.js`, `merge.js` | Canonical schemas, bounds and deterministic register operations |
| `src/progress/atomic-file.js`, `repository.js` | Serialized, recoverable file transactions |
| `src/progress/migration.js` | One-time conversion with original-byte backups |
| `src/progress/profiles.js`, `backup.js`, `service.js` | Profile commands, portable data and session ownership |
| `src/progress/ipc.js`, `runtime.js` | Trusted Electron boundary and lifecycle |
| `src/overlay/progress-view.js` | Pending intentions and complete-state reconciliation |
| `src/settings/{window.js,index.html,preload.js,settings.js,settings.css}` | Shared focusable profile/settings window |
| `tests/progress/{helpers.js,*.test.js}` | Offline deterministic tests |
| Existing main/config/overlay/i18n files, both READMEs | Composition, migration safety and user instructions |

### Shared contracts

Use JSDoc in owning modules; no TypeScript conversion.

- `Register<T> = {value:T,clock:number,actor:string}`; actor and profile IDs are lowercase UUIDs; clocks are positive safe integers.
- `Profile = {name:Register<string>,region:Register<string>,enabledTypes:Register<string[]>,hideFound:Register<boolean>,markers:Record<string,Register<boolean>>}`. Marker keys are canonical decimal positive safe integers; type keys match `/^o[1-9]\d{0,14}$/` with safe integer suffixes.
- `ProgressState = {namespace:'appsample:gim:2',profiles:Record<string,Profile>}`. Preserve absent versus explicitly false registers.
- `Scope = {kind:'local'} | {kind:'account',accountKey:string}`. Account keys are 64 lowercase SHA-256 hex characters; this plan activates only local scope.
- `LocalEnvelope = {version:1,state:ProgressState,clock:number,revision:number,dirtyRevision:number,acknowledgedRevision:number,selectedProfileId:string|null,migrationComplete:boolean,sync:object|null}`. Local `sync` is null. The transfer plan adds a validated optional `extensions.transfer` field; never put it inside `state`. Account sync metadata remains owned by the Drive plan.
- `Context = {sessionGeneration:string,profileId:string}`. Rotate the opaque session UUID on every profile/scope activation, including returning to a previously selected profile. Check context when enqueuing and before committing.
- `PublicSnapshot = {sessionGeneration:string,viewVersion:number,scope:'local'|'account',account:{email:string|null,connected:boolean}|null,profiles:Array<{id:string,name:string,region:string}>,activeProfile:{id:string,name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}|null,sync:{phase:string,code:string|null,lastSuccessAt:number|null}}`. Versions increase within a session. No registers, installation actors, account keys or paths cross IPC.
- `Result<T> = {ok:true,value:T} | {ok:false,error:{code:string,messageKey:string},snapshot:PublicSnapshot}`. Use safe error codes, not raw exceptions.
- `PortableBackup = {format:'genshin-map-overlay.backup',version:1,namespace:'appsample:gim:2',profiles:Array<{name:string,region:string,foundIds:number[],enabledTypes:string[],hideFound:boolean}>}`. Backups copy effective progress into new profiles; they do not transport clocks/actors.

Retain the Drive plan's bounds: 16 MiB local envelope, 4 MiB v1 portable body, 100 profiles, 200,000 marker registers across profiles, 4,096 enabled type keys per profile, trimmed Unicode names 1–80 code points, regions 0–80, and 10 recovery backups. Limits reject rather than truncate. The transfer plan explicitly revises the local/backup bounds for attachments and tests those revisions.

Run commands from the repository root. Each commit follows a passing focused test plus `npm run test:progress`. Use `git diff --cached` to check staged hunks before committing.

### Task 1: Define canonical progress and register semantics

**Files:** Create `src/progress/schema.js`, `src/progress/merge.js`, `tests/progress/helpers.js`, `tests/progress/schema.test.js`, `tests/progress/merge.test.js`. Modify `package.json:scripts,engines` and `.github/workflows/mac.yml:setup-node`.

**Interfaces:**
- Produce `ProgressError(code:string)`, `LIMITS`, `validateState(value:unknown):ProgressState` and `validateEnvelope(value:unknown,scope:Scope):LocalEnvelope`.
- Produce `mergeStates(a:ProgressState,b:ProgressState):ProgressState`, `nextClock(clock:number,state:ProgressState):number` and `foundIds(profile:Profile):number[]`.
- Test helpers export fixed UUIDs `ACTOR_A`, `ACTOR_B`, `PROFILE_A`, `PROFILE_B` and `makeState({actor=ACTOR_A,clock=1,profileId=PROFILE_A,found={},name='Main',region='',enabledTypes=['o5'],hideFound=false}={}):ProgressState`.

- [x] **Step 1: Write the failing tests** with these names/assertions; arrange profiles with marker 42 true at clock 7 and false at clock 8.

```js
// 'merge is commutative associative and idempotent'
assert.deepEqual(mergeStates(a, b), mergeStates(b, a));
assert.deepEqual(mergeStates(mergeStates(a, b), c), mergeStates(a, mergeStates(b, c)));
assert.deepEqual(mergeStates(a, a), a);
// 'explicit undo survives older progress'
assert.deepEqual(foundIds(mergeStates(foundAt7, undoAt8).profiles[PROFILE_A]), []);
// 'unknown identities and profile text survive validation'
assert.equal(valid.profiles[PROFILE_A].markers['900000001'].value, true);
assert.equal(valid.profiles[PROFILE_A].name.value, '旅人 <img onerror=alert(1)>');
assert.ok(valid.profiles[PROFILE_A].enabledTypes.value.includes('o999999'));
```

Also assert ASCII actor tie-breaking, metadata clocks contributing to `nextClock`, independent markers/profiles surviving, and rejection of contradictory equal-clock/equal-actor registers, overflow, wrong namespaces, unsafe IDs, prototype keys and every declared bound.

- [x] **Step 2: Run** `node --test tests/progress/schema.test.js tests/progress/merge.test.js`. Expected: FAIL on missing module exports.
- [x] **Step 3: Implement the declared exports** using plain own-property objects and immutable merge inputs. Reject newer schemas without rewriting them. Add `"test:progress": "node --test \"tests/progress/*.test.js\""` and `engines.node: ">=22.12.0"` without changing dependency versions; update the existing Mac workflow's Node 20 to `22.12.0`.
- [x] **Step 4: Run** `npm run test:progress`. Expected: all model tests PASS offline.
- [x] **Step 5: Commit** only the five new files and owned package/workflow hunks: `git commit -m "feat: define shared local profile progress model"`.

### Task 2: Persist serialized recoverable transactions

**Files:** Create `src/progress/atomic-file.js`, `src/progress/repository.js`, `tests/progress/repository.test.js`.

**Interfaces:**
- Consume Task 1 validation/types.
- Produce `atomicWriteFile(file:string,bytes:Buffer,{fs,maxBytes,backupFile?}):Promise<void>`, with default `node:fs/promises`.
- Produce `ProgressRepository({root:string,fs?,uuid?})` with `init():Promise<{writerId:string,activeScope:Scope}>`, `load(scope:Scope):Promise<LocalEnvelope>`, `transact(scope:Scope,mutate:(draft:LocalEnvelope)=>void):Promise<LocalEnvelope>`, `backup(scope:Scope,reason:'migration'|'import'):Promise<void>`, `restoreLastGood(scope:Scope):Promise<LocalEnvelope>` and `flush():Promise<void>`.

- [x] **Step 1: Write failing disk/restart tests** with real temporary directories and injected failures.

```js
// 'failed rename preserves the committed save and in-memory state'
await assert.rejects(repo.transact(scope, edit42), { code: 'local-write-failed' });
assert.deepEqual(await repo.load(scope), before);
assert.deepEqual(await reopened.load(scope), before);
// 'queued independent edits survive restart'
assert.deepEqual(foundIds(after.state.profiles[PROFILE_A]), [42, 43]);
// 'corruption requires explicit recovery'
await assert.rejects(repo.load(scope), { code: 'local-recovery-required' });
assert.deepEqual(await fs.readFile(stateFile), corruptOriginal);
```

Inject interruption after temp write, sync, backup replacement and final rename; reopening yields only complete old/new envelopes. Test no-op revisions, validation before writes, size exhaustion, malformed installation identity, backup failure/pruning and failed recovery preserving both files.

- [x] **Step 2: Run** `node --test tests/progress/repository.test.js`. Expected: FAIL on missing repository.
- [x] **Step 3: Implement atomic replacement and repository methods.** Under `root = <userData>/progress` use `installation.json`, `local/state.json`, `accounts/<validated-account-key>/state.json` and `backups/`. One queue covers loads/mutations/backups; increment revision on changed drafts only. Sync/close a same-directory temp file, retain a validated last-good copy, then rename; sync the directory where supported. Never unlink a good destination as a workaround or automatically replace corrupt primary bytes. Recovery first preserves the corrupt original.
- [x] **Step 4: Run** the focused test and `npm run test:progress`. Expected: PASS through each crash/failure boundary.
- [x] **Step 5: Commit** the three files: `git commit -m "feat: persist profile edits with recoverable atomic transactions"`.

### Task 3: Migrate legacy progress exactly once

**Files:** Create `src/progress/migration.js`, `tests/progress/migration.test.js`. Modify `src/config.js:6-19,45-86`.

**Interfaces:**
- Consume `ProgressRepository` and `nextClock`.
- Produce `migrateLegacy({repository:ProgressRepository,userData:string,readFile?,uuid?}):Promise<LocalEnvelope>`.
- Extend `config.load({preserveMalformed=false}={}):object` and export `DEFAULT_PROFILE_PREFERENCES`. The preservation mode returns defaults without replacing unreadable/malformed files.

- [x] **Step 1: Write failing migration tests** using `{"ids":[42,42,43]}`, `enabledTypes:['o6','o5']` and `hideFound:true`.

```js
// 'migration preserves progress preferences and original bytes'
assert.equal(profile.name.value, 'Local progress');
assert.deepEqual(foundIds(profile), [42, 43]);
assert.deepEqual(profile.enabledTypes.value, ['o5', 'o6']);
assert.equal(profile.hideFound.value, true);
assert.equal(after.migrationComplete, true);
assert.deepEqual(await fs.readFile(legacyFile), original);
// 'restart cannot duplicate the migrated profile'
assert.equal(Object.keys(twice.state.profiles).length, 1);
```

Test missing/empty files, invalid IDs, malformed present preference fields, permission failures and crashes before/after the durable flag. For corrupt settings assert the original bytes survive `config.load({preserveMalformed:true})` and migration rejects with `local-recovery-required`.

- [x] **Step 2: Run** `node --test tests/progress/migration.test.js`. Expected: FAIL on missing migration/preservation behavior.
- [x] **Step 3: Implement migration and config preservation.** Strictly validate legacy numeric IDs before conversion; back up original found/settings bytes before writing. Commit the one “Local progress” profile, preferences and completion flag together. Only ENOENT means absent; other read failures enter recovery. Never watch/reimport later changes to `found.json`.
- [x] **Step 4: Run** the focused test and `npm run test:progress`. Expected: PASS, with identical original bytes after failed migration.
- [x] **Step 5: Commit** owned config/migration files: `git commit -m "feat: migrate legacy progress without losing recovery data"`.

### Task 4: Own durable profile commands and portable backups

**Files:** Create `src/progress/profiles.js`, `backup.js`, `service.js` and `tests/progress/profiles.test.js`, `backup.test.js`, `service.test.js`.

**Interfaces:**
- Produce draft operations `createProfile(draft:LocalEnvelope,{id:string,name:string,region:string},actor:string):string`, `renameProfile(draft:LocalEnvelope,{id:string,name?:string,region?:string},actor:string):void`, `setFound(draft:LocalEnvelope,{profileId:string,id:number,found:boolean},actor:string):void` and `setPreferences(draft:LocalEnvelope,{profileId:string,enabledTypes?:string[],hideFound?:boolean},actor:string):void`.
- Produce `exportBackup(state:ProgressState,profileIds:string[]):string`, `parseBackup(bytes:Buffer):PortableBackup` and `importProfiles(draft:LocalEnvelope,backup:PortableBackup,{actor:string,uuid:()=>string}):string[]`.
- Produce `ProgressService({repository,uuid,onSnapshot})` with `initialize({userData:string}):Promise<PublicSnapshot>`, `snapshot():PublicSnapshot`, `setFound(context:Context,{id:number,found:boolean}):Promise<Result<PublicSnapshot>>`, `setPreferences(context:Context,patch:{enabledTypes?:string[],hideFound?:boolean}):Promise<Result<PublicSnapshot>>`, `createProfile({sessionGeneration:string,name:string,region:string}):Promise<Result<PublicSnapshot>>`, `renameProfile(context:Context,patch:{name?:string,region?:string}):Promise<Result<PublicSnapshot>>`, `selectProfile(context:Context):Promise<Result<PublicSnapshot>>`, `importBackup({sessionGeneration:string,bytes:Buffer}):Promise<Result<PublicSnapshot>>`, `exportBackup({sessionGeneration:string,profileIds:string[]}):Promise<Result<string>>`, `restoreLocalBackup({sessionGeneration:string}):Promise<Result<PublicSnapshot>>` and `shutdown():Promise<void>`.
- Internal extension point: `runProfileTransaction(context:Context,{expectedRevision?:number,reason:'edit'|'import'|'restore'},mutate:(draft:LocalEnvelope,actor:string)=>void):Promise<LocalEnvelope>`. It serializes with selection, checks context/revision, backs up imports/restores, commits once and emits after durability. Do not expose draft callbacks through IPC.

- [x] **Step 1: Write failing profile/service/backup tests.**

```js
// 'desired values are replayable and explicit false remains a register'
assert.equal(afterUndo.state.profiles[PROFILE_A].markers['42'].value, false);
assert.equal(afterRepeated.revision, afterFirst.revision);
// 'returning to the same profile invalidates the old operation'
assert.equal((await service.setFound(oldA, { id: 42, found: true })).error.code, 'stale-context');
// 'backup import creates a fresh profile and restamps effective progress'
assert.notEqual(importedId, PROFILE_A);
assert.deepEqual(foundIds(imported), [42, 900000001]);
assert.equal(imported.markers['42'].actor, ACTOR_B);
```

Also assert backup failure prevents mutation; malformed/newer/oversized backups are wholly rejected; names/type keys survive; backups exclude clocks/actors/paths/secrets; existing profile false registers are untouched when importing new profiles; transient failure returns the current snapshot; unchanged setters do not advance clocks.

- [x] **Step 2: Run** `node --test tests/progress/profiles.test.js tests/progress/backup.test.js tests/progress/service.test.js`. Expected: FAIL on missing commands.
- [x] **Step 3: Implement pure profile/backup operations.** Every changed register gets the next local clock and `dirtyRevision`; importing never trusts clocks. Validate complete portable data before draft mutation and create new UUIDs. Preserve unknown valid identities.
- [x] **Step 4: Implement service ownership and the internal transaction extension point.** Initialize migration before snapshots; rotate selection sessions and return only durable snapshots. Recovery is read-only until explicit validated restore. Keep local mode usable with no cloud modules. `shutdown` drains the service/repository queues.
- [x] **Step 5: Run** the three focused tests and `npm run test:progress`. Expected: all PASS offline.
- [x] **Step 6: Commit** the six files: `git commit -m "feat: add durable named profile commands and portable backups"`.

### Task 5: Establish trusted IPC and local runtime

**Files:** Create `src/progress/ipc.js`, `runtime.js`, `tests/progress/ipc.test.js`, `runtime.test.js`.

**Interfaces:**
- Produce `registerProgressIpc({ipcMain,service,getOverlayWindow,getSettingsWindow,openSettings,dialogs}):()=>void`.
- Produce `createProgressRuntime({app,log,onSnapshot}):Promise<{service:ProgressService,shutdown:()=>Promise<void>}>`.
- Channels: `progress:get`, `progress:set-found`, `progress:set-preferences`, `progress:select-profile`, `profiles:open-settings` and settings-only `profiles:command`. Commands: `create`, `rename`, `select`, `import-backup`, `export-backup` and `restore-local`. Payloads mirror Task 4; import/export paths are chosen only by main-owned dialogs.

- [ ] **Step 1: Write failing trusted-boundary/lifecycle tests.**

```js
// 'only the expected top frame can mutate progress'
assert.equal(childFrameReply.error.code, 'unauthorized-sender');
assert.equal(trackerReply.error.code, 'unauthorized-sender');
assert.equal(mutations, 0);
// 'selection during a file picker invalidates its continuation'
assert.equal(dialogReply.error.code, 'stale-context');
assert.deepEqual(after, before);
```

Reject extra keys, unknown commands, renderer paths, numeric strings/NaN IDs and oversized labels before service calls. Test canceled dialogs, destroyed windows, bounded reads before JSON parsing, runtime disposal, and preservation-mode config read → repository/migration → initial snapshot → window initialization order.

- [ ] **Step 2: Run** `node --test tests/progress/ipc.test.js tests/progress/runtime.test.js`. Expected: FAIL on missing adapters.
- [ ] **Step 3: Implement the declared adapters.** Require both expected `event.sender` and `event.senderFrame === window.webContents.mainFrame`. Capture sessions before dialogs and recheck afterward. Keep dependencies injectable and raw paths/errors in main only. Do not activate the new store in main until Task 6.
- [ ] **Step 4: Run** focused tests and `npm run test:progress`. Expected: PASS without loading Electron in unit tests.
- [ ] **Step 5: Commit** the four files: `git commit -m "feat: expose trusted local profile IPC and lifecycle"`.

### Task 6: Switch the application and shared settings window together

**Files:** Create `src/overlay/progress-view.js`, `src/settings/window.js`, `index.html`, `preload.js`, `settings.js`, `settings.css`, `tests/progress/overlay-progress.test.js`, `settings.test.js` and `app-lifecycle.test.js`. Modify `src/main.js:7-34,92-150,215-223,311-346,392-395,478-495,554-679`, `src/config.js`, `src/overlay/{preload.js,overlay.js,index.html,overlay.css}`, `src/shared/i18n.js`, `README.md`, `README.de.md`. Delete `src/data/found.js` after cutover passes.

**Interfaces:**
- Produce browser/CommonJS `createProgressView({sendSetFound,onChange,onError})` with `applySnapshot(snapshot:PublicSnapshot):void`, `setFound(id:number,found:boolean):Promise<void>` and `current():{context:Context|null,foundIds:number[],enabledTypes:string[],hideFound:boolean}`.
- Produce `createSettingsWindow({BrowserWindow,onClosed?}):BrowserWindow` with a singleton focus/reopen owner in main.
- Overlay preload adds `getProgress`, `setFound`, `setProfilePreferences`, `selectProfile` and `openProfileSettings` matching Task 5; subscribe to `progress:snapshot`.
- Settings preload exposes `profileApi.getState():Promise<Result<PublicSnapshot>>`, `command(operation:string,payload:object):Promise<Result<unknown>>` and `onSnapshot(callback):()=>void` using Task 5's allowlist. Future transfer/Drive work extends this window.

- [ ] **Step 1: Write failing reconciliation/window/lifecycle tests.**

```js
// 'same-profile authoritative replacement refreshes every progress view'
assert.deepEqual(view.current().foundIds, [42, 43]);
assert.equal(effects.recount, 1);
assert.equal(effects.refreshSpot, 1);
// 'late failed mark cannot roll back a newer undo or another profile'
assert.deepEqual(view.current().foundIds, []);
assert.equal(view.current().context.profileId, PROFILE_B);
// 'normal settings window stays sandboxed and reusable'
assert.equal(options.focusable, true);
assert.equal(options.webPreferences.sandbox, true);
assert.equal(options.webPreferences.contextIsolation, true);
assert.equal(options.webPreferences.nodeIntegration, false);
assert.equal(secondOpen, firstOpen);
```

Arrange `onChange` in the first test to invoke the actual renderer refresh adapter; avoid testing a copied rendering algorithm. Also test pending desired-value ordering, HTML-like names via text nodes, unknown enabled types surviving edits, A → B → A replies, EN/DE key parity, close/reopen subscriptions and quit while writes are queued/failing. On a failed quit drain assert `quitCalls === 0` and `errorShown === 1`; after a successful retry assert `quitCalls === 1`.

- [ ] **Step 2: Run** `node --test tests/progress/overlay-progress.test.js tests/progress/settings.test.js tests/progress/app-lifecycle.test.js`. Expected: FAIL before app integration.
- [ ] **Step 3: Implement the progress view and main/overlay cutover.** At startup use `config.load({preserveMalformed:true})` before initializing the service; do not normalize/write legacy settings before migration or while recovery is pending. Keep immediate optimistic feedback but serialize explicit intentions and reconcile failures. Initial load, profile changes and bulk updates replace found IDs/preferences/counters together; same-profile updates refresh `renderSpotFound()`, profile changes close spot/lightbox. Move enabled types/hide-found/F9 to profile commands; local settings messages must no longer reset them. Preserve valid hidden type keys. Replace the delayed FoundStore shutdown with a guarded asynchronous queue drain; a failed drain keeps the app open with an error, and a successful retry quits once.
- [ ] **Step 4: Implement the shared profile settings window and navigation.** Provide create/rename/region/select, portable import/export and explicit recovery. Tray EN “Profiles & transfers” / DE “Profile & Übertragung” and an overlay shortcut open the same focusable window. Use local assets, strict CSP, blocked navigation/new windows, textContent for names, and complete EN/DE copy. No Google setup is required.
- [ ] **Step 5: Update both READMEs** for local profile storage, legacy migration/recovery and portable backups; keep capture/tracker instructions accurate.
- [ ] **Step 6: Verify** `npm run test:progress`, `node --check src/main.js`, `node --check src/overlay/overlay.js`, `node --check src/settings/settings.js` and `git diff --check`. Expected: all tests PASS, syntax checks exit 0, and no whitespace errors. Run `rg -n 'FoundStore|overlay:found-toggle|found:all|found:changed' src`; expected no matches (exit 1). In `npm start` verify right-click/undo, F9, profile focus/switch, counters/spot refresh, restart and canceled dialogs with local test data. Windows/macOS packaged checks are completed in the transfer plan's delivery task.
- [ ] **Step 7: Commit** only the listed files/hunks: `git commit -m "feat: integrate authoritative local profiles and shared settings"`.

### Task 7: Drain accepted renderer edits before profile boundaries

**Problem/evidence:** profile-switch-probe.json confirms an accepted optimistic undo can be silently lost when a settings profile switch enters the service queue before the renderer sends that undo. Exports can likewise read a stale intermediate state.

**Files:** Create src/progress/client-barrier.js and tests/progress/client-barrier.test.js; modify src/progress/ipc.js, src/main.js, and focused existing progress integration tests as needed. Reuse createRendererQuitDrain from app-lifecycle.js and the production ProgressView; preserve narrow preloads and exact local document guards.

**Main-only contract:** createClientProgressBarrier({overlayDrain,quitDrain}) exports run(operation):Promise<T>, shutdown(operation):Promise<void>, active():boolean, dispose(). run queues outside ProgressService, prepares/freezes/drains overlay, invokes trusted callback, then resumes overlay on success/failure. shutdown immediately rejects new run submissions, queues behind already accepted runs, prepares all clients then drains service; failed shutdown resumes clients/reopens acceptance for retry. Existing accepted runs finish even if quit is submitted later. A shared FIFO ensures drain nonce lifecycles do not overlap. Keep the service Electron-free.

Extend registerProgressIpc with optional main-owned withProgressBarrier(operation), default calling operation. Profile selections (ordinary and settings), create, import-backup, export-backup, restore-local and retry-local use the barrier. Dialogs and bounded file validation happen first; prepare only around the bounded service operation, never while user interacts with a picker. Recheck captured owner/frame and current session after waiting for drain before touching service/file mutation. Preserve final reply gates and allow intentional session rotations. Rename and ordinary found/preference setters need no barrier. Renderer payload cannot select/inject a callback.

main owns separate overlay-only and all-client quit drains with one shared barrier. Overlay-only avoids deadlocking on the initiating pending settings command. Quit runs through barrier.shutdown; block opening settings during preparation; dispose all resources only after successful drain. Keep failed-quit visible errors/retry. This callback is the shared trusted boundary for future transfer preview/apply/export.

**Tests first:** (1) actual production view/service/repository/IPC with held mark, queued undo, switchB/switchA persists false; (2) export with that pending undo excludes42; (3) failed prepare performs no profile/file mutation, resumes edits, retry works; (4) accepted profile run then quit finishes in order without settings self-deadlock; (5) new operations during quit reject safely; (6) failed quit reopens acceptance and retries; (7) frame/session change during drain invalidates continuation. Preserve existing forged/stale ACK tests. Use temporary test data only.

Run focused tests, npm run test:progress, npm run test:transfer, node --check src/main.js, git diff --check. No commit/staging (grouped commits by controller), no new dependencies, no subagents. Report implementation/API, RED/GREEN evidence, self-review, concerns.

## Handoff

Then execute the linked transfer plan. When Drive work begins, reuse these files and the transfer extension; extend the service/runtime/IPC/window rather than rerunning migration or replacing the repository. The only deliberate refinement to its old context contract is session invalidation on every profile activation. Its canonical register and cloud wire formats remain unchanged.

Self-review coverage: register/undo and bounds → Task 1; durability/recovery → Task 2; legacy conversion → Task 3; profile/backups/transaction extension → Task 4; frame/session validation → Task 5; complete overlay/settings/lifecycle behavior → Task 6. All five Review Focus conditions have owning tests. This plan does not implement Google connectivity.

## Execution status (2026-10-25)

Subagent-driven execution on local branch `import-export`. Tasks 1–4 passed independent task reviews; per-task commit instructions are grouped into milestone commits at the user’s request. Implementation currently uses the original writable checkout after the managed worktree was blocked by the sandbox. Remaining tasks are tracked in the SDD ledger.
