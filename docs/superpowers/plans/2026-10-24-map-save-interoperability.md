# Map Save Interoperability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer completed exploration markers between the overlay and AppSample, international HoYoLAB, MapGenie, Kongying Tavern/Yuanshen and BWIKI through previewed portable files and bundled DevTools scripts.

**Architecture:** A shared local profile service owns durable imports; transfer envelopes, reviewed mapping packs and profile-local provenance provide both-direction identity without guessing. Self-contained browser adapters use the map's existing session and verified save mechanism, with backup acknowledgement, explicit found operations and readback receipts. Provider availability follows dated two-direction acceptance, never the existence of a JSON exporter alone.

**Tech Stack:** Existing Electron 45/CommonJS/vanilla JavaScript/HTML/CSS, Node `>=22.12.0` to align with the shared progress plan, `node:test`, browser File/Blob/Web Crypto APIs, and the existing AppSample catalog/`Geo` helpers. No transfer backend or new runtime dependencies.

**Spec:** [2026-10-24-map-save-interoperability-design.md](../specs/2026-10-24-map-save-interoperability-design.md). Read its [research record](../research/2026-10-24-map-save-interoperability.md) and the prerequisite [local progress foundation plan](2026-10-24-local-progress-foundation.md). The [Drive plan](2026-10-24-google-drive-sync.md) is coordination context, not an instruction to implement OAuth here.

## Global Constraints

- “Use the existing Electron/CommonJS/vanilla-JavaScript architecture and EN/DE translations.”
- “Delivery order: AppSample, HoYoLAB, MapGenie, Kongying, BWIKI.”
- “Finish each import/export pair before moving its status to supported.”
- “First-release support is scoped to the app's currently displayed Teyvat map, including validated marker levels within that map.”
- “Scripts are bundled, inspectable code with no remote script loader or remotely evaluated code.”
- “The app's progress identity stays `appsample:gim:2` plus stable marker ID for current Teyvat progress, matching the Google Drive proposal.”
- “Missing entries mean unknown, not explicitly uncollected.”
- “Local false/undo registers remain meaningful in the progress model, but first-release site exports only add confirmed found states.”
- “Transfer attachments are local-only in the first release and are included in the app's portable backup format through a versioned extension.”
- “A transfer attachment and canonical state must commit/recover together.”
- “First-release behavior is to retain and report ambiguous records, with a downloadable report; no manual match editor is included.”
- “No writes to a user's real save are part of planning.”
- “Use sanitized progress and small catalog fixtures; never commit cookies, tokens, actual account identifiers or private saves.”

## Review Focus

1. Undoing an imported mapped marker must suppress its retained original found state on export; an unknown same-provider ID must still pass through (Task 4).
2. Duplicate/conflicting IDs, prototype keys, deceptive mapping evidence and oversized nested metadata must fail before file/profile mutation (Task 2).
3. A catalog refresh, changed profile, or A → B → A selection during preview must require a fresh preview rather than redirecting the import (Task 4).
4. Same coordinates on different floors, puzzle/reward pairs and duplicate destinations must remain unresolved rather than mark extra objects (Task 3).
5. A timeout after a successful website write, followed by logout or cancellation, must produce an accurate partial receipt and a fresh-state retry without another write (Tasks 5, 7–11).

---

## Scope and execution order

The spec spans a reusable persistence subsystem and the transfer feature. Keep [local profiles](2026-10-24-local-progress-foundation.md) in their own independently usable plan; do not build a second store alongside the Drive plan. This plan contains the shared transfer pipeline and five adapter tasks against one contract.

Start Task 1's provider feasibility work in the stated order, investigating AppSample and HoYoLAB first. The local foundation can proceed while access-dependent feasibility checks are pending. Complete the foundation before Tasks 2–4 modify progress modules. Complete one provider pair before advancing to the next provider implementation. Pure tests/build preparation may proceed while manual acceptance is pending; never mark that provider supported or the five-provider feature complete.

The current code has `FoundStore.toggle`, no `src/progress`, no `src/settings` and no general unit-test suite. Current `decodeMarkers` retains only `mid === 2` and exposes stable IDs plus pixel coordinates/levels; use `data.types[markers.type[i]].key` for categories, never its array index as identity. The current `found:all` listener does not refresh the open spot button; the prerequisite replaces that path.

The Drive design is deleted in the current working tree; preserve that deletion and other existing package/research/spec edits. The prerequisite carries the needed local contracts. No branch name, implementation method, live-account writes or deployment is authorized by writing this plan.

### File map

| Files | Responsibility |
| --- | --- |
| `src/transfer/{capabilities.js,registry.js,envelope.js,attachments.js}` | Provider status, strict portable schema and local provenance |
| `src/transfer/{catalog.js,mapping.js,spatial-index.js}` | Stable catalog identity and conservative bidirectional matching |
| `src/transfer/{planner.js,controller.js}` | Preview, merge-only export and one durable import |
| `src/transfer/browser/{runtime.js,ui.js}` | Shared browser preview/backup/write/readback flow |
| `src/transfer/providers/<provider>/{capability.json,adapter.js,normalize.js,mapping.json}` | Provider-specific evidence, detection/read/write paths, parsers and reviewed mappings |
| `src/transfer/scripts/<provider>-{export,import}.js` | Ten generated inspectable console scripts |
| `src/transfer/{ipc.js,runtime.js}` | Main-owned dialogs, preview tokens, script/report downloads and composition |
| `tools/{build-transfer-scripts.js,check-transfer-package.js}`, `tools/transfer/catalog-report.js` | Deterministic bundling, package checks and measured catalog coverage |
| `tests/transfer/{helpers.js,*.test.js,fixtures/<provider>/*}` | Offline fixtures and failure/round-trip tests |
| Shared progress/settings/main/overlay/i18n files | Transaction, backup-extension and UI integration |
| `docs/map-transfers.md`, `docs/map-transfers.de.md`, `docs/superpowers/research/2026-10-24-map-transfer-capabilities.md` | Instructions and dated support/acceptance evidence |

Here `<provider>` is exactly one of `appsample`, `hoyolab`, `mapgenie`, `kongying`, `bwiki`. Each fixture directory contains `catalog.json`, `progress.json`, `context.json` and `expected.json`; later tests add explicit failure fixtures where required. Preserve raw field names only in sanitized provider fixtures, not in portable envelopes.

### Shared contracts and decisions

Use the foundation's `Context`, `LocalEnvelope`, `Profile`, `PublicSnapshot` and `Result<T>` types. Own new JSDoc types in the modules below.

- `ProviderId = 'appsample'|'hoyolab'|'mapgenie'|'kongying'|'bwiki'`. A capability record contains `{provider,adapterVersion,status,variants,reasonCode}`; `status` is `planned|unavailable|supported`. Each variant names exact origins, map namespace, site generation, account tier, browser/version, catalog fingerprint, measured pacing/endpoint allowlists, read/write/restore capability and dated evidence. “Supported” requires both directions, reload/readback and an existing destination-only found ID. Missing evidence is unverified, not inferred.
- `TransferRecord = {id:string,map:string,category:string|null,level:string|null,state:boolean,position:{x:number,y:number,space:string}|null,mappingEvidence?:{namespace:'appsample:gim:2',id:string,mappingVersion:string}}`. External IDs remain opaque strings; only verified AppSample IDs become canonical numeric IDs.
- `TransferEnvelope = {format:'genshin-map-overlay.transfer',version:1,producer:{name:string,version:string},exportedAt:string,provider:ProviderId,adapterVersion:string,map:string,catalog:{generation:string,fingerprint:string},coverage:{categories:string[],levels:string[],complete:boolean},records:TransferRecord[]}`. One file has one provider/map scope; other realms use separate files and remain recoverable attachments. Every record map must equal the envelope map. `exportedAt` is an ISO timestamp, never a logical clock.
- `Counts = {matched:number,alreadyFound:number,ambiguous:number,unsupported:number,unknown:number,invalid:number,ignoredNotFound:number,duplicates:number}`. Nonduplicate records receive exactly one outcome. Invalid envelopes have no apply token.
- `ValidationIssue = {recordIndex:number|null,code:string}`. `TransferResult<T>` is the foundation's `Result<T>` with optional `validation:{invalidCount:number,issues:ValidationIssue[]}` on its failure branch; include at most 100 safe issue codes/indices, never input text. Count distinct invalid records; a root/parse failure counts as one invalid envelope.
- `MappingDecision = {sourceId:string,status:'matched'|'ambiguous'|'unsupported'|'unknown',canonicalId:string|null,confidence:'exact'|'reviewed'|'spatial'|null,mappingVersion:string|null,reason:string}`.
- `TransferReport = {format:'genshin-map-overlay.transfer-report',version:1,provider:ProviderId,map:string,counts:Counts,coverage:TransferEnvelope['coverage'],decisions:MappingDecision[]}`. Export decisions use canonical source IDs; import decisions use provider source IDs.
- `RetainedRecord = {provider:ProviderId,map:string,catalog:{generation:string,fingerprint:string},record:TransferRecord,mapping:{canonicalId:string,confidence:'exact'|'reviewed'|'spatial',mappingVersion:string}|null}`.
- `ImportReceipt = {digest:string,provider:ProviderId,map:string,counts:Counts,createdProfile:boolean}`. `ProfileAttachment = {version:1,records:RetainedRecord[],imports:ImportReceipt[]}`. `LocalEnvelope.extensions.transfer = {version:1,profiles:Record<string,ProfileAttachment>}` is optional; absent means empty. Keys are actual local profile IDs. All attachment changes share the canonical transaction/file.
- Portable backup v2 keeps v1's profile array and adds `extensions:{transfer:{version:1,profiles:Record<string,ProfileAttachment>}}` keyed by the exported profile's decimal array index. It never exports internal profile IDs. v1 remains readable; v2 is emitted when attachments exist and imported to fresh profile IDs.
- `transferDigest` is SHA-256 of deterministically ordered provider/map/catalog/coverage/records, excluding producer/time. Retained records are upserted by JSON `[provider,map,id]`; within-file identical duplicates collapse, contradictory duplicates reject. Later explicit imports replace that source observation, never trust source timestamps.

Bounds chosen for implementation: 64 MiB transfer input, 250,000 records per transfer and across one envelope's attachments, 1–128 Unicode code points for IDs/map/category/level/coordinate-space names, 256 for other schema strings, 4,096 categories/levels per coverage array, finite coordinates with magnitude at most `1e12`, and 1,000 import receipts per local envelope. Increase the foundation's local-file limit to 128 MiB and attachment-bearing portable-backup limit to 96 MiB; keep v1 backup and all canonical profile/register bounds unchanged. Before support is advertised, measure a full current catalog against these limits (Task 1); revise explicit limits/tests if measurements require it. Never truncate a save.

No arbitrary properties, credentials, source URLs, filesystem paths, HTML or raw storage blobs belong in these schemas. Mapping evidence in a file is untrusted; revalidate it against bundled mapping data. Full developer catalog downloads stay in ignored `server/cache/transfer/`; commit only small sanitized fixtures, reviewed mapping metadata and aggregate reports.

Add `"test:transfer": "node --test \"tests/transfer/*.test.js\""` and `"build:transfer-scripts": "node tools/build-transfer-scripts.js"` when their files exist. Run focused tests, `npm run test:progress` and `npm run test:transfer` before implementation commits. Stage owned paths/hunks and inspect `git diff --cached`.

### Task 1: Establish provider feasibility records and honest availability

**Files:** Create `src/transfer/capabilities.js`, `registry.js`, all five `src/transfer/providers/<provider>/capability.json` files, `tools/transfer/catalog-report.js`, `tests/transfer/capabilities.test.js`, `tests/transfer/helpers.js`, all five fixture directories and `docs/superpowers/research/2026-10-24-map-transfer-capabilities.md`. Modify `package.json:scripts`.

**Interfaces:**
- Produce `validateCapability(value:unknown):ProviderCapability`, `listProviders():ProviderCapability[]` and `getProvider(id:ProviderId):ProviderCapability`. `ProviderCapability` is the capability record defined above; `getProvider` rejects unknown IDs. `ProviderVariant` has `{id:string,origins:string[],map:string,generation:string,accountTier:string,browser:{family:'chromium'|'firefox',version:string},catalogFingerprint:string,read:'unverified'|'verified'|'unavailable',write:'unverified'|'verified'|'unavailable',restore:'unverified'|'verified'|'unavailable',pacing:{batchSize:number,minIntervalMs:number,maxAttempts:3,maxBackoffMs:30000}|null,endpoints:Array<{method:string,origin:string,path:string}>,statePaths:string[],evidence:{checkedAt:string,read:boolean,write:boolean,reload:boolean,destinationOnlyPreserved:boolean,pairAccepted:boolean,restore:boolean},reasonCode:string|null}`. No account identifiers belong in capability records. Unobserved versions/fingerprints use an empty string only in unverified variants, which cannot enable writes.
- Produce `catalogReport({provider:ProviderId,map:string,catalog:TransferRecord[],progress:TransferRecord[]}):{provider:ProviderId,map:string,catalogFingerprint:string,catalogCount:number,progressRecordCount:number,progressBytes:number,categories:string[],levels:string[],maxIdLength:number,maxStringLength:number,maxAbsCoordinate:number}`. CLI: `node tools/transfer/catalog-report.js --provider ID --map MAP --catalog FILE --progress FILE --out FILE`. Inputs are normalized metadata arrays from the feasibility probe; measure an all-found synthetic progress array covering the full catalog as well as the small save. Its explicit developer CLI paths are never read from transfer JSON.
- Helpers export `fixture(provider:ProviderId,name:string):object`, `makeTransfer(overrides?:object):TransferEnvelope` and `makeBrowserHarness({provider,foundIds?,failures?}):object`. The last is a deterministic fake adapter/UI/time harness implementing Task 5's contract, extended there; no fake credentials.

- [ ] **Step 1: Write failing registry/evidence tests.**

```js
// 'five distinct provider families stay visible without invented support'
assert.deepEqual(listProviders().map(p => p.provider), ['appsample','hoyolab','mapgenie','kongying','bwiki']);
assert.equal(validateCapability(onlyReadProved).status, 'planned');
assert.throws(() => validateCapability(claimedSupportedWithoutWriteProof), { code: 'invalid-capability' });
assert.equal(catalogReport(sample).catalogCount, sample.catalog.length);
```

Test that an international HoYoLAB result cannot validate mainland endpoints; untested mobile/client variants and account tiers cannot inherit website acceptance.

- [ ] **Step 2: Run** `node --test tests/transfer/capabilities.test.js`. Expected: FAIL on missing registry/validator.
- [ ] **Step 3: Implement the declared registry/report interfaces** and add `test:transfer`. Initially record unverified/unavailable facts honestly. A browser probe uses only fixed, inspected site code and the site's session; no credential extraction or broad storage dumping.
- [ ] **Step 4: Prove AppSample feasibility** on a disposable save or explicitly designated test account: identify stable catalog IDs, fully loaded scope, current read interface, explicit set-found/save/readback, account persistence, reload and progress-only restore. Record date/browser/site generation/limits, a source-only ID, a destination-only ID and normalized field examples. No real-save writes occur during this planning turn.
- [ ] **Step 5: Prove international HoYoLAB feasibility** with the same read → add one test marker → reload/readback → restore sequence; identify international origins/fixed same-site endpoints, authentication behavior, map/layer/category semantics, catalog access and measured pacing.
- [ ] **Step 6: Prove MapGenie feasibility** with that sequence and record account-tier restrictions. Respect blocked access; do not bypass it or infer mobile propagation.
- [ ] **Step 7: Prove Kongying feasibility** for a specifically identified web generation/selected save, separating permanent completion from timed respawn state and verifying normal save persistence/restore.
- [ ] **Step 8: Prove BWIKI feasibility** for one identified map generation/browser-local save, identifying the authoritative progress records and UI refresh/reload path.
- [ ] **Step 9: Record sanitized fixtures and measured reports** for each proved variant. Run the CLI on full current catalogs and retain aggregate counts/bytes/fingerprints in the research record. Select concrete provider pacing and exact endpoint/storage/method allowlists from observations. Record inaccessible variants as unavailable with their reason. If no designated test save/account is available, retain that live check as pending; do not fabricate a fixture or silently reduce the five-provider target.
- [ ] **Step 10: Run** `npm run test:transfer` and `git diff --check`. Expected: all evidence/schema tests PASS; manual evidence distinguishes passed, failed and pending. Probes alone do not set `supported` before the production script round trip.
- [ ] **Step 11: Commit** owned registry/fixture/report files: `git commit -m "feat: record verified map transfer capabilities and provider gates"`.

### Task 2: Validate envelopes and extend local provenance/backups

**Files:** Create `src/transfer/envelope.js`, `attachments.js`, `tests/transfer/envelope.test.js`, `attachments.test.js`. Modify `src/progress/schema.js`, `backup.js`, `service.js` and `tests/progress/backup.test.js`.

**Interfaces:**
- Produce browser-compatible `parseTransfer(bytes:Uint8Array):TransferEnvelope`, `validateTransfer(value:unknown):TransferEnvelope`, `serializeTransfer(value:TransferEnvelope):Uint8Array` and `digestTransfer(value:TransferEnvelope):Promise<string>`. Use TextEncoder/TextDecoder and Web Crypto; Node Buffers are valid Uint8Arrays.
- Produce `TransferValidationError(code:string,invalidCount:number,issues:ValidationIssue[])` with those public properties. Invalid records are aggregated before throwing; invalid root/byte parsing fails before record inspection.
- Produce `validateAttachments(value:unknown,profileIds:string[]):Record<string,ProfileAttachment>` and `mergeAttachment(previous:ProfileAttachment|undefined,incoming:ProfileAttachment):ProfileAttachment`.
- Extend `exportBackup(state,profileIds,{transferByProfile?:Record<string,ProfileAttachment>}={}):string` and `parseBackup(bytes):PortableBackupV1|PortableBackupV2`. `PortableBackupV1` is the foundation's `PortableBackup`; v2 is defined above. Service exports/imports/recovers state and extensions together; no Drive serializer includes them.

- [ ] **Step 1: Write failing validation/backup tests.**

```js
// 'invalid input is atomic'
assert.throws(() => parseTransfer(oversized), { code: 'transfer-too-large' });
assert.throws(() => validateTransfer(conflictingDuplicate), { code: 'invalid-transfer' });
assert.throws(() => validateTransfer(withTokenOrPathField), { code: 'invalid-transfer' });
assert.equal(twoInvalidRecordsError.invalidCount, 2);
assert.ok(manyInvalidRecordsError.issues.length <= 100);
// 'unknown realms and IDs survive a portable backup'
assert.equal(restoredAttachment.records[0].record.id, 'absent-from-current-catalog');
assert.equal(restoredAttachment.records[0].map, unsupportedRealm);
assert.equal(backup.version, 2);
assert.equal(backup.extensions.transfer.profiles['0'].version, 1);
assert.deepEqual(parseBackup(legacyV1).profiles, legacyProfiles);
```

Cover all declared bounds at/over limit, newer versions, invalid UTF-8/JSON, nonboolean states, NaN/infinite coordinates, wrong declared scope, oversized nested evidence, prototype keys, missing fields, exact duplicate collapse and timestamp-independent digests. Assert deceptive evidence cannot authorize a mapping. Reject unknown extension versions without discarding stored data.

- [ ] **Step 2: Run** `node --test tests/transfer/envelope.test.js tests/transfer/attachments.test.js tests/progress/backup.test.js`. Expected: FAIL on missing schema/extensions.
- [ ] **Step 3: Implement the declared codecs and normalized attachment merge.** Bound bytes before decoding, validate all records before returning, and allow only explicit fields. Do not execute text or resolve file-supplied URLs/paths. Enforce updated local/portable bounds and preserve old envelopes with no extension.
- [ ] **Step 4: Extend portable backup/service import and recovery** to validate v2 fully and remap array-index attachments to fresh profile UUIDs in the same transaction. Include canonical data and provenance in local backups; cloud state projections remain `envelope.state` only.
- [ ] **Step 5: Run** the focused tests plus both suites. Expected: PASS for v1/v2 round trips and rejection before mutation.
- [ ] **Step 6: Commit** owned files: `git commit -m "feat: validate portable transfers and preserve local provenance"`.

### Task 3: Match stable identities conservatively in both directions

**Files:** Create `src/transfer/catalog.js`, `mapping.js`, `spatial-index.js`, `tests/transfer/catalog.test.js`, `mapping.test.js`. Add `mapping.json` to each provider directory as that provider's measured pack becomes available.

**Interfaces:**
- Produce `canonicalCatalog(data:{types:Array<{key:string}>,markers:{count:number,id:ArrayLike<number>,type:ArrayLike<number>,level:ArrayLike<number>,x:ArrayLike<number>,y:ArrayLike<number>}}):CanonicalCatalog` where `CanonicalCatalog = {namespace:'appsample:gim:2',fingerprint:string,markers:Array<{id:string,category:string,level:string|null,x:number,y:number}>}`. Hash stable sorted semantic fields, excluding localized names/array order.
- `CatalogPoint = {id:string,category:string,level:string|null,x:number,y:number}`; `CalibrationPoint = {source:[number,number],target:[number,number],sourceId:string,canonicalId:string}`.
- `MappingPack = {version:1,provider:ProviderId,map:string,sourceCatalogFingerprint:string,canonicalCatalogFingerprint:string,sourceCoordinateSpace:string,sourceMarkers:CatalogPoint[],categoryPairs:Array<{source:string,target:string,permanent:boolean}>,levelPairs:Array<{source:string,target:string}>,pairs:Array<{sourceId:string,canonicalId:string}>,spatial:null|{coefficients:[number,number,number,number,number,number],radius:number,minMargin:number,maxResidual:number,anchors:CalibrationPoint[],heldOut:CalibrationPoint[]}}`. Include minimal public source-catalog points so reverse/collision checks cover all candidates, not only imported found markers. Fingerprints and coefficients/tolerances come from Task 1's measured data and provider tasks, never the community script's constants. Identity-only AppSample uses namespace/current ID membership instead of a cross-provider transform.
- Produce `validateMappingPack(value:unknown):MappingPack`, `matchRecords(envelope:TransferEnvelope,catalog:CanonicalCatalog,pack:MappingPack|null):MappingDecision[]` and `reverseIds(canonicalIds:string[],catalog:CanonicalCatalog,pack:MappingPack):{ids:string[],excluded:string[]}`.
- Produce `createSpatialIndex(markers:CanonicalCatalog['markers'],cellSize:number):{query(x:number,y:number,radius:number):CanonicalCatalog['markers']}` and `fitAffine(anchors:Array<{source:[number,number],target:[number,number]}>):[number,number,number,number,number,number]`.

- [ ] **Step 1: Write failing identity/spatial tests.**

```js
// 'provider numerals never share identity accidentally'
assert.equal(hoyo42WithoutPack.status, 'unknown');
assert.equal(appsample42InCorrectMap.canonicalId, '42');
// 'stacked duplicates and semantic collisions stay unresolved'
assert.equal(unknownFloor.status, 'ambiguous');
assert.equal(puzzleToReward.status, 'unsupported');
assert.equal(twoSourcesOneDestination.every(x => x.status !== 'matched'), true);
// 'reviewed round trips add no completions'
assert.deepEqual(reverseIds(matchedIds, catalog, pack).ids.sort(), sourceIds.sort());
assert.equal(reorderedCatalog.fingerprint, catalog.fingerprint);
```

Include wrong realm/category/floor, equal-distance candidates, insufficient margin, non-reciprocal nearest neighbors, duplicate pins, stale catalog/transform, unreviewed one-to-many pairs, farm/respawn state, singular calibration and held-out residual violations. A known affine synthetic fixture must recover its coefficients and transform independent held-out points. Explicit reviewed pairs take precedence over spatial candidates.

- [ ] **Step 2: Run** `node --test tests/transfer/catalog.test.js tests/transfer/mapping.test.js`. Expected: FAIL on missing matching exports.
- [ ] **Step 3: Implement catalog identity and reviewed pair lookup.** Use existing map pixels and stable category keys/level values. Translate source levels through reviewed `levelPairs`; neither unknown floors nor a provider's zero value can be assumed to mean the canonical surface. Require provider/map/catalog/coordinate-space compatibility for cross-provider packs; reject corrupt packs. Unknown AppSample IDs/realms remain retained, never guessed.
- [ ] **Step 4: Implement measured affine matching and reverse lookup.** Use a uniform grid for radius queries. Fit affine coefficients from independently identified anchors, validate across held-out regions, and disable spatial matching if that model fails. Require unique category/realm/level-compatible candidates, the pack's margin/radius/residual thresholds, reverse consistency and collision checks against full catalogs. Unknown floors in stacked/dense cases are ambiguous. First release keeps non-bijective semantic relationships unmapped.
- [ ] **Step 5: Run** focused tests and both suites. Expected: PASS; matched round trips preserve exactly the eligible set, regardless of input order.
- [ ] **Step 6: Commit** code/tests and only measured reviewed packs: `git commit -m "feat: add conservative bidirectional marker matching"`.

### Task 4: Preview and commit imports through the shared progress service

**Files:** Create `src/transfer/planner.js`, `controller.js`, `tests/transfer/planner.test.js`, `controller.test.js`. Modify `src/progress/service.js` and `tests/progress/service.test.js`.

**Interfaces:**
- Produce `planImport(envelope:TransferEnvelope,profile:Profile,catalog:CanonicalCatalog,pack:MappingPack|null):{decisions:MappingDecision[],foundIds:string[],attachment:ProfileAttachment,counts:Counts}` and `planExport(profile:Profile,attachment:ProfileAttachment|undefined,{provider:ProviderId,map:string,catalog:CanonicalCatalog,pack:MappingPack|null,metadata:{producer:{name:string,version:string},exportedAt:string,adapterVersion:string}}):{envelope:TransferEnvelope,report:TransferReport}`. A new-profile preview plans against an empty profile; the planner returns retained records with an empty receipt list, and the controller adds its destination-aware receipt.
- Produce `TransferController({progress:ProgressService,getCatalog:()=>CanonicalCatalog,getMapping:(provider:ProviderId,map:string)=>MappingPack|null,uuid:()=>string,now:()=>number})` with `previewImport(context:Context,{bytes:Buffer,mode:'new'|'merge',name?:string,region?:string}):Promise<ImportPreview>`, `applyImport(context:Context,{previewId:string,createAnother?:boolean}):Promise<Result<{snapshot:PublicSnapshot,receipt:ImportReceipt}>>` and `exportProfile(context:Context,{provider:ProviderId,map:string}):Promise<{envelope:TransferEnvelope,report:TransferReport}>`. Controller supplies export metadata from the package, registry and injected clock.
- `ImportPreview = {id:string,context:Context,revision:number,catalogFingerprint:string,digest:string,counts:Counts,coverage:TransferEnvelope['coverage'],priorDestinations:Array<{id:string,name:string}>,canApply:boolean}`. Store bytes/plans privately in main; one-use preview tokens expire after 15 minutes and are invalidated by catalog/context/revision changes. Re-preview rebuilds rather than silently applying old counts.
- Extend service construction with optional `publicationGate:{pause():Promise<()=>void>,notifyCommitted(revision:number):void}`. `pause` prevents new publication/local merge critical sections until its returned release runs; it must not wait for a remote HTTP response. Local mode needs no gate.

- [ ] **Step 1: Write failing planner/controller tests.**

```js
// 'merge preserves destination-only progress and missing means unknown'
assert.deepEqual(afterFound, [42, 43, 99]); // source 42/43; destination 99
assert.equal(after.state.profiles[PROFILE_A].markers['100'].value, false);
// 'repeated import is a no-op and prior new-profile destination is offered'
assert.equal(second.revision, first.revision);
assert.deepEqual(repeatedPreview.priorDestinations.map(p => p.id), [createdId]);
// 'mapped undo overrides original provenance while unmapped IDs pass back'
assert.equal(exported.records.some(r => r.id === originalMappedId && r.state), false);
assert.ok(exported.records.some(r => r.id === unknownOriginalId && r.state));
// 'publication follows the complete durable transaction'
assert.deepEqual(events, ['pause', 'backup', 'persist', 'snapshot', 'release', 'notify']);
```

Test new-profile default versus explicit merge, explicit `createAnother` after a duplicate receipt, existing false → imported true as a fresh local register, false source states causing no clears, unsupported realms/categories retained, deduplicated reverse IDs and no cross-provider pass-through. Fail backup/rename and reopen: both canonical state and attachment are old or both new. Switch A → B → A, edit a marker, refresh catalogs, expire/reuse a token or simulate remote merge during preview: Apply returns `stale-preview`/`stale-context` before writes. The fake publication gate must observe no notification on failure and no imported remote clock/actor.

- [ ] **Step 2: Run** `node --test tests/transfer/planner.test.js tests/transfer/controller.test.js tests/progress/service.test.js`. Expected: FAIL on missing controller/extension behavior.
- [ ] **Step 3: Implement pure import/export planning.** Imported true matches use the foundation's `setFound`; false/missing states never clear. Count exclusions and retain normalized records/provenance. On export prefer original verified IDs, then validated reverse mappings; mapped canonical false/absent state suppresses original true. Only unmapped records pass unchanged to their own provider/map; false records are metadata, never write operations.
- [ ] **Step 4: Implement main-owned previews and one service transaction.** Capture profile/session/revision, recompute compatibility immediately before commit, back up, and create/update profile, registers, attachment and receipt together. Keep the first stored receipt for an existing digest instead of rewriting its counts on every replay; identical records/registers then remain a no-op. Consume preview tokens after successful use; preserve retryability after a disk failure by requiring a refreshed preview. Bound retained previews to one per settings window and validate the eventual serialized size before any write. New imports select their new profile in the same durable transaction, rotating the session after persistence.
- [ ] **Step 5: Implement the publication gate around import/restore.** Pause before backup/commit, emit only after durability, release in `finally`, then notify once if canonical state changed. Reuse the Drive worker's actual gate if it exists; otherwise test the injected contract without claiming live Drive support. Attachments never enter cloud snapshots. Later Drive integration must preserve this gate and the canonical schema.
- [ ] **Step 6: Run** focused tests and both suites. Expected: PASS through failures/restarts and fake connected-profile interlocks.
- [ ] **Step 7: Commit** the owned files: `git commit -m "feat: preview and atomically apply replayable map transfers"`.

### Task 5: Build the shared console runner and inspectable bundles

**Files:** Create `src/transfer/browser/runtime.js`, `ui.js`, `tools/build-transfer-scripts.js`, `tests/transfer/browser-runtime.test.js`, `browser-bundle.test.js`. Extend `tests/transfer/helpers.js` and `package.json:scripts`.

**Interfaces:**
- `BrowserContext = {provider:ProviderId,map:string,catalogFingerprint:string,contextFingerprint:string,accountLabel:string|null,saveLabel:string|null,identityKnown:boolean}`. Context fingerprints use observable nonsecret account/save identity or validated browser-local save identity, not tokens. Labels are displayed, never written to logs.
- `BrowserState = {foundIds:string[],fingerprint:string,catalogIds:string[]}`. `BrowserAdapter` implements `detect():Promise<BrowserContext>`, `read(context:BrowserContext):Promise<BrowserState>`, `exportProgress(context:BrowserContext):Promise<TransferEnvelope>`, `setFound(context:BrowserContext,id:string,signal:AbortSignal):Promise<{status:'persisted'|'uncertain'|'failed',code:string,retryAfterMs?:number}>` and optional `restoreProgress(context:BrowserContext,backup:TransferEnvelope,signal:AbortSignal):Promise<void>`. It also exposes its verified capability/pacing data.
- `BrowserPreview = {context:BrowserContext,stateFingerprint:string,counts:{add:number,unchanged:number,skipped:number},eligibleIds:string[]}`; `BrowserProgress = {completed:number,total:number,id:string|null}`.
- `BrowserUi` implements `chooseFile():Promise<Uint8Array|null>`, `showContext(context:BrowserContext):void`, `showPreview(preview:BrowserPreview):void`, `showProgress(progress:BrowserProgress):void`, `showReceipt(receipt:BrowserReceipt):void`, `showError(code:string):void`, `onApply(callback:()=>void):()=>void`, `onCancel(callback:()=>void):()=>void`, `onBackupAcknowledged(callback:()=>void):()=>void` and `dispose():void`.
- Produce `createBrowserTransfer({adapter:BrowserAdapter,ui:BrowserUi,download:(name:string,bytes:Uint8Array)=>Promise<void>,sleep:(ms:number)=>Promise<void>,now:()=>number}):{exportProgress():Promise<void>,preview(bytes:Uint8Array):Promise<BrowserPreview>,acknowledgeBackup():void,apply(signal:AbortSignal):Promise<BrowserReceipt>,resume(receipt:BrowserReceipt,signal:AbortSignal):Promise<BrowserReceipt>}` and `createTransferUi(document:Document):BrowserUi`. The generated import entry opens the file chooser and calls preview; the export entry calls exportProgress. A resolved download means only that the download was requested; acknowledgement remains mandatory.
- `BrowserReceipt = {format:'genshin-map-overlay.receipt',version:1,provider:ProviderId,map:string,contextFingerprint:string,adapterVersion:string,transferDigest:string,status:'complete'|'partial'|'canceled',confirmed:string[],unchanged:string[],skipped:Array<{id:string,reason:string}>,failed:Array<{id:string,code:string}>,uncertain:string[]}`. Arrays are disjoint and account for every source ID; remaining eligible IDs use a skipped cancellation/context-change reason.
- Builder exports `buildTransferScripts({root:string}):Promise<string[]>` and writes the ten script paths in the file map as provider adapters land. Until an adapter is verified, its script stops with its concrete unavailable/pending reason. Use a static allowlisted CommonJS module table inside an IIFE, generated at build time; no runtime eval, dynamic loader or Node builtins.

- [ ] **Step 1: Write failing browser state-machine and bundle tests.**

```js
// 'backup acknowledgement and an unchanged preview precede any write'
assert.equal(writesBeforeAcknowledgement, 0);
assert.equal(changedContextWrites, 0);
assert.equal(changedStateWrites, 0);
// 'timeout after persisted write is read before retry'
assert.deepEqual(receipt.confirmed, ['42']);
assert.equal(setFoundCallsFor42, 1);
// 'cancellation leaves confirmed progress and accounts for remaining IDs'
assert.equal(receipt.status, 'canceled');
assert.deepEqual(receipt.confirmed, ['42']);
assert.deepEqual(receipt.skipped, [{ id: '43', reason: 'canceled' }]);
// 'generated code is self-contained and deterministic'
assert.equal(firstBuild, secondBuild);
assert.equal(remoteLoaderCalls, 0);
```

Also test wrong file provider/map, logout/save/account switch mid-run, identity unavailable display, unobservable account/save changes disabling writes, site-generation changes, denied access, unknown response bodies, catalog mismatch, 429/Retry-After, transient backoff exhaustion, uncertain readback, lost cloud persistence, duplicate reruns and a receipt from another context. No item is confirmed from an unverified memory mutation. Restores are unavailable when not proved.

- [ ] **Step 2: Run** `node --test tests/transfer/browser-runtime.test.js tests/transfer/browser-bundle.test.js`. Expected: FAIL on missing runtime/builder.
- [ ] **Step 3: Implement preview/file/backup UI.** Show provider/map/save/account labels, explicitly “Account identity unavailable” when absent, scope/coverage and add-only counts. Choose files through an input, validate bytes, download a credential-free destination progress backup, then require its acknowledgement. Immediately before Apply re-detect context/catalog and re-read the relevant state fingerprint; changes invalidate preview. Render all imported text as text nodes. Do not bypass site CSP/browser security if UI injection is blocked.
- [ ] **Step 4: Implement explicit writes, retry/readback and receipts.** Process bounded provider batches with cancellation/context checks between operations. Preserve destination-only states/notes/routes/preferences. Use measured minimum pacing, at most 3 attempts and 30 seconds backoff; if Retry-After exceeds the bound, pause with a resume instruction instead of retrying early. Before retrying an ambiguous write, read fresh state. Complete means every eligible ID is verified; failures/uncertain writes are partial, exclusions remain visible. Resume always checks receipt context and reads current state. Never promise third-party transactional rollback.
- [ ] **Step 5: Implement deterministic static bundling** and `build:transfer-scripts`. Export scripts only read/download. Import scripts include their file UI, schema, runner and provider adapter. Package only allowlisted source modules; never interpolate transfer JSON into executable text. Re-running disposes the previous panel/listeners without starting another concurrent run.
- [ ] **Step 6: Run** the focused tests, `npm run build:transfer-scripts` and both suites. Expected: PASS; generated unavailable-provider scripts fail closed with useful instructions.
- [ ] **Step 7: Commit** owned browser/builder/test files: `git commit -m "feat: add backed-up browser transfer runner and verified receipts"`.

### Task 6: Connect transfer dialogs and the shared settings window

**Files:** Create `src/transfer/ipc.js`, `runtime.js`, `tests/transfer/ipc.test.js` and `settings.test.js`. Modify `src/settings/{preload.js,index.html,settings.js,settings.css}`, `src/main.js:start/loadMarkerData`, `src/overlay/preload.js`, `src/shared/i18n.js` and shared-window navigation only if absent from the prerequisite.

**Interfaces:**
- Produce `registerTransferIpc({ipcMain,controller,getSettingsWindow,dialogs,getScript}):()=>void` and `createTransferRuntime({progress:ProgressService,getCatalog,getSettingsWindow,ipcMain,dialogs}):{controller:TransferController,dispose:()=>void}`.
- Settings preload adds `transferApi.providers():Promise<ProviderCapability[]>`, `previewImport(context:Context,options:{provider:ProviderId,mode:'new'|'merge',name?:string,region?:string}):Promise<TransferResult<ImportPreview|null>>`, `applyImport(context:Context,options:{previewId:string,createAnother?:boolean}):Promise<Result<{snapshot:PublicSnapshot,receipt:ImportReceipt}>>`, `exportProfile(context:Context,options:{provider:ProviderId,map:string}):Promise<Result<TransferReport|null>>`, `saveScript(provider:ProviderId,direction:'export'|'import'):Promise<Result<null>>` and `saveReport(previewId:string):Promise<Result<null>>`. Main owns every picker, file byte bound, output path and stored report/token. IPC channels use these names prefixed `transfer:`; no generic command/evaluate/network channel.

- [ ] **Step 1: Write failing IPC/settings tests.**

```js
// 'only the settings top frame can operate transfer files'
assert.equal(trackerReply.error.code, 'unauthorized-sender');
assert.equal(childFrameReply.error.code, 'unauthorized-sender');
assert.equal(rendererPathCalls, 0);
// 'import defaults to a new profile and every outcome is visible'
assert.equal(initialMode, 'new');
assert.deepEqual(shownCountKeys.sort(), ['matched','alreadyFound','ambiguous','unsupported','unknown','invalid','ignoredNotFound','duplicates'].sort());
assert.equal(profileAfterCanceledPicker, profileBeforePicker);
assert.equal(invalidFileView.invalidCount, 2);
assert.equal(invalidFileView.canApply, false);
```

Test wrong selected provider versus file provider, profile switches during pickers, window destruction, forged/expired preview IDs, unknown provider/script direction, extra keys and labels rendered via textContent. Assert EN/DE key parity for all states and the local-only-attachment limitation in both languages.

- [ ] **Step 2: Run** `node --test tests/transfer/ipc.test.js tests/transfer/settings.test.js`. Expected: FAIL before transfer UI integration.
- [ ] **Step 3: Implement narrow main-owned transfer IPC/runtime.** Validate expected window and main frame, capture/recheck context around dialogs and bound file size before reading/parsing. Project validation errors to `TransferResult.validation` so an invalid file displays its count with Apply disabled. Keep catalogs/plans/reports in main; only safe preview/report metadata crosses IPC. Rebuild catalogs/invalidate previews after `loadMarkerData` changes. Script retrieval reads fixed bundled paths only.
- [ ] **Step 4: Extend the existing focusable settings window.** Add source/destination provider/map selection, script saving/instructions, new-profile default/explicit merge, counts/coverage preview, Apply, export eligibility report and downloadable ambiguous report. Duplicate imports offer the prior profile and a distinct “Create another profile” action. Show planned/unavailable providers with concrete reasons. Explain that Drive carries canonical progress while unmatched pass-through requires a portable backup on another device; show provider restore limitations and add-only semantics. Reuse tray/overlay navigation, never add a second settings window.
- [ ] **Step 5: Run** focused tests, both suites, script build and `node --check` on main/settings/preload files. Expected: PASS. In `npm start` verify focus/keyboard access, canceled dialogs, stale-preview refresh, repeated imports, complete counter/filter/spot updates and EN/DE instructions with test data.
- [ ] **Step 6: Commit** owned IPC/settings/i18n files: `git commit -m "feat: add profile-safe map transfer settings and file dialogs"`.

### Provider task convention

Tasks 7–11 each produce a working import/export pair or an explicit unavailable result requiring a scope discussion. They consume Task 5's `BrowserAdapter` contract, Task 3's mapping contract and their Task 1 evidence. Each produces `createAdapter({window,fetch,capability}):BrowserAdapter` in `adapter.js` and `normalizeProgress(raw:unknown,catalog:unknown):TransferEnvelope` in `normalize.js`; only provider code touches site-specific interfaces. Add `runProviderContract({provider:ProviderId,createAdapter,fixtures}):void` to `tests/transfer/provider-contract.js` in Task 7; it registers shared Node tests for exact fixture found sets, merge idempotency, destination-only survival, scope/context failures, source read-only behavior and sanitized output.

Live manual proof for each pair is browser source export → app preview/apply → app export → destination browser preview/backup/acknowledge/apply → reload/readback, with a destination-only found marker and partial-failure retry. Verify account/cloud persistence where applicable. Record date, adapter/site/catalog versions, map/category/layer coverage, account tier, browser and restoration limits. A browser/client variant remains pending until independently tested.

### Task 7: Deliver AppSample in both directions

**Files:** Create `src/transfer/providers/appsample/{adapter.js,normalize.js,mapping.json}`, `tests/transfer/provider-contract.js` and `tests/transfer/appsample.test.js`. Modify its `capability.json`, four fixtures, both generated AppSample scripts and the capability research record.

**Interfaces:** Consume the provider task convention; produce the `appsample` adapter/normalizer and exact `appsample:gim:2` identity support.

- [ ] **Step 1: Write failing AppSample/contract tests.**

```js
// 'AppSample exact IDs round-trip without clearing destination progress'
assert.deepEqual(reloadedFound, ['42', '43', '99']);
assert.equal(unknownRetained.record.id, '900000001');
assert.equal(wrongMapMatchedCount, 0);
assert.equal(secondRunWrites, 0);
```

Use Task 1's observed raw shape. Verify signed-in versus browser-local behavior is not conflated, not-yet-loaded state cannot export a complete scope, absent-current-catalog IDs survive, and UI-only success cannot count as persistence.

- [ ] **Step 2: Run** `node --test tests/transfer/appsample.test.js`. Expected: FAIL on missing adapter.
- [ ] **Step 3: Implement AppSample detection/normalization/read/set-found/readback** using only the live-verified page methods/save path. No assumed historical page-global name. Export minimal IDs/category/map/level/position data and truthful completeness. Enable progress-only restore only if Task 1 proved it.
- [ ] **Step 4: Run** the focused test, build scripts and both suites. Expected: all offline tests PASS.
- [ ] **Step 5: Perform and record the live pair proof** from the convention using the designated test save, including signed-in reload. Mark only proved variants supported; otherwise record the blocker and request a concrete scope decision without claiming completion.
- [ ] **Step 6: Commit** owned AppSample/contract/generated/evidence files: `git commit -m "feat: transfer AppSample progress in both directions"`.

### Task 8: Deliver international HoYoLAB in both directions

**Files:** Create `src/transfer/providers/hoyolab/{adapter.js,normalize.js,mapping.json}` and `tests/transfer/hoyolab.test.js`. Modify its `capability.json`, fixtures, both generated HoYoLAB scripts and the research record.

**Interfaces:** Consume the provider convention; produce the `hoyolab` adapter and a reviewed international Teyvat mapping pack.

- [ ] **Step 1: Write failing HoYoLAB tests.**

```js
// 'international mappings preserve exactly the reviewed found set'
assert.deepEqual(reloadedFound, [...mappedHoyoIds, destinationOnlyId].sort());
assert.equal(mainlandRequests, 0);
assert.equal(stackedUnknownFloor.status, 'ambiguous');
assert.equal(timeoutAfterCommitWriteCount, 1);
```

Cover category/level mismatches, unreviewed oculus semantics, held-out transform failures, logout, throttling and partial receipts. Never treat equal provider numbers or game-account state as completion evidence.

- [ ] **Step 2: Run** `node --test tests/transfer/hoyolab.test.js`. Expected: FAIL on missing adapter.
- [ ] **Step 3: Implement the verified international adapter and mapping pack.** Use a fixed measured same-site endpoint allowlist and browser session behavior, without exporting cookies/tokens. Keep category/coordinate calibration data separate from the runner; persist/read back through proved authenticated operations.
- [ ] **Step 4: Run** focused tests, rebuild scripts and both suites. Expected: PASS, including cross-provider round-trip/collision cases.
- [ ] **Step 5: Perform and record the live pair proof**, account persistence, paced writes and timeout recovery; support only verified international browser/map variants.
- [ ] **Step 6: Commit** owned HoYoLAB/generated/evidence files: `git commit -m "feat: transfer international HoYoLAB progress in both directions"`.

### Task 9: Deliver MapGenie in both directions

**Files:** Create `src/transfer/providers/mapgenie/{adapter.js,normalize.js,mapping.json}` and `tests/transfer/mapgenie.test.js`. Modify its `capability.json`, fixtures, both generated MapGenie scripts and the research record.

**Interfaces:** Consume the provider convention; produce the `mapgenie` adapter and reviewed Teyvat mapping pack.

- [ ] **Step 1: Write failing MapGenie tests.**

```js
// 'tier restrictions cannot become a successful partial catalog export'
assert.equal(restrictedWriteCalls, 0);
assert.equal(restrictedResult.code, 'account-tier-unavailable');
assert.deepEqual(reloadedFound, [...mappedGenieIds, destinationOnlyId].sort());
assert.equal(mobileVariant.status, 'planned');
```

Cover access denial, limited catalog loads, saved-account changes and preservation of notes/preferences. Only recognized restrictions receive the tier error; unknown responses stop as `site-interface-changed`.

- [ ] **Step 2: Run** `node --test tests/transfer/mapgenie.test.js`. Expected: FAIL on missing adapter.
- [ ] **Step 3: Implement the verified MapGenie adapter/mappings** for proved account tiers and persistence paths. If access remains blocked, retain unavailable status and bring the concrete limitation to the user; do not work around restrictions or substitute a provider.
- [ ] **Step 4: Run** focused tests, rebuild scripts and both suites. Expected: PASS for available and fail-closed restricted cases.
- [ ] **Step 5: Perform and record the live pair proof.** Test website-to-mobile propagation only if it will be advertised, otherwise keep that claim unavailable/pending.
- [ ] **Step 6: Commit** owned MapGenie/generated/evidence files: `git commit -m "feat: add verified MapGenie transfer pair"`.

### Task 10: Deliver Kongying selected-save transfers in both directions

**Files:** Create `src/transfer/providers/kongying/{adapter.js,normalize.js,mapping.json}` and `tests/transfer/kongying.test.js`. Modify its `capability.json`, fixtures, both generated Kongying scripts and the research record.

**Interfaces:** Consume the provider convention; produce the `kongying` adapter for the specific web/native-file variants proved in Task 1. A native file path uses the same normalizer/validator and selected-save backup flow.

- [ ] **Step 1: Write failing Kongying tests.**

```js
// 'selected-save merge preserves unrelated data and excludes respawn timers'
assert.deepEqual(otherSaveAfter, otherSaveBefore);
assert.deepEqual(notesRoutesPreferencesAfter, notesRoutesPreferencesBefore);
assert.equal(permanentIds.includes(timerOnlyId), false);
assert.equal(unverifiedClientWrites, 0);
```

Also test save changes between preview/apply, recognized file-version differences, rejected newer files and same-provider unsupported-realm pass-through.

- [ ] **Step 2: Run** `node --test tests/transfer/kongying.test.js`. Expected: FAIL on missing adapter.
- [ ] **Step 3: Implement version-specific parsers and the verified normal save mechanism.** Reuse native file interfaces only where proved; recognize v3 `marked_layers`/`marked_timelayers` or `Data_KYJG`/`Time_KYJG` only when the current evidence confirms that generation. Preserve unrelated selected-save fields through its normal state/save methods; never overwrite broad browser storage.
- [ ] **Step 4: Run** focused tests, rebuild scripts and both suites. Expected: PASS for selected-save isolation and generation rejection.
- [ ] **Step 5: Perform and record the live pair proof** for each advertised web/file variant. Desktop-client compatibility requires its own proof and remains a separate claim.
- [ ] **Step 6: Commit** owned Kongying/generated/evidence files: `git commit -m "feat: transfer verified Kongying selected-save progress"`.

### Task 11: Deliver BWIKI browser-local transfers in both directions

**Files:** Create `src/transfer/providers/bwiki/{adapter.js,normalize.js,mapping.json}` and `tests/transfer/bwiki.test.js`. Modify its `capability.json`, fixtures, both generated BWIKI scripts and the research record.

**Interfaces:** Consume the provider convention; produce the `bwiki` adapter for the map generation and authoritative browser-local format proved in Task 1.

- [ ] **Step 1: Write failing BWIKI tests.**

```js
// 'verified local-save writes preserve unrelated storage and survive reload'
assert.equal(unrelatedStorageAfter, unrelatedStorageBefore);
assert.deepEqual(reloadedFound, [...mappedBwikiIds, destinationOnlyId].sort());
assert.equal(unknownGenerationWrites, 0);
assert.equal(displayedIdentityText, 'Account identity unavailable');
```

Test local-save replacement during preview, malformed authoritative storage, blocked persistence, reload disagreement and generation-specific legacy migration controls remaining untouched.

- [ ] **Step 2: Run** `node --test tests/transfer/bwiki.test.js`. Expected: FAIL on missing adapter.
- [ ] **Step 3: Implement the verified BWIKI adapter/mappings.** Use only authoritative progress records and tested refresh/persistence behavior; localStorage changes are allowed only if Task 1 proved their authority. Never guess alternative keys or claim cloud sync.
- [ ] **Step 4: Run** focused tests, rebuild scripts and both suites. Expected: PASS for isolated local storage and fail-closed site changes.
- [ ] **Step 5: Perform and record the live pair proof** in the same owning browser profile, including backup/recovery limits and full reload.
- [ ] **Step 6: Commit** owned BWIKI/generated/evidence files: `git commit -m "feat: transfer verified BWIKI browser-local progress"`.

### Task 12: Package, document and verify the complete feature

**Files:** Create `tools/check-transfer-package.js`, `tests/transfer/acceptance.test.js`, `package.test.js`, `docs/map-transfers.md` and `docs/map-transfers.de.md`. Modify `package.json:scripts,build.files`, `.github/workflows/mac.yml:before-packaging`, `README.md`, `README.de.md` and the capability research record. Update generated scripts if the deterministic build changes them.

**Interfaces:**
- Produce CLI `node tools/check-transfer-package.js PATH` for an extracted packaged app directory. Add `"check:transfer-package": "node tools/check-transfer-package.js"`. Require all ten scripts, shared settings assets, provider evidence/mapping files and envelope/attachment modules; compare script hashes with a fresh build.
- Acceptance uses the real repository/service/controller/normalizers/runner with fake website persistence, filesystem fault injection and synthetic catalogs; no parallel test implementation of transfer logic.

- [ ] **Step 1: Write failing package/whole-feature acceptance tests.**

```js
// 'five pairs preserve canonical progress provenance and destination-only IDs'
assert.equal(results.length, 5);
assert.deepEqual(results.map(r => r.extraCompletions), [0, 0, 0, 0, 0]);
assert.equal(results.every(r => r.destinationOnlySurvived), true);
// 'portable restore retains unsupported pass-through but Drive projection does not'
assert.deepEqual(restored.extensions.transfer, before.extensions.transfer);
assert.equal(Object.hasOwn(cloudProjection, 'extensions'), false);
// 'a package cannot advertise missing scripts or unproved variants'
assert.equal(missingBundleCheck.code, 'missing-transfer-script');
assert.equal(unprovedVariantCheck.code, 'invalid-capability');
```

Include real-module migration → import → undo → export → backup/restore → reimport, failures before backup/final rename, repeated console runs and fake connected-profile publication ordering. Fix failures in the owning task rather than weaken acceptance assertions.

- [ ] **Step 2: Run** `node --test tests/transfer/acceptance.test.js tests/transfer/package.test.js`. Expected: FAIL on missing checker/delivery assets; earlier behavior tests should already pass.
- [ ] **Step 3: Implement package checking and delivery scripts.** Current `build.files` already includes `src/**/*`; verify rather than replacing it. In the existing Mac workflow run both test suites and the script build before packaging. Test package exclusions explicitly. The installed archive CLI is `node node_modules/@electron/asar/bin/asar.js extract ARCHIVE DIRECTORY`; extract into a fresh temporary directory and check it. Add no runtime dependency. Keep package/lockfile versions and unrelated scripts unchanged.
- [ ] **Step 4: Write EN/DE instructions and dated support matrix.** Document owning-browser/profile/save selection, Chromium/Firefox console steps only where tested, file exchange, previews, backup acknowledgement, add-only semantics, exclusion reports, partial/uncertain receipts, fresh-state retry, browser-local saves, source restore limitations, Teyvat versus retained realms, portable recovery and Drive attachment limitations. Matrix columns: provider, direction, map/generation, category/layer coverage, account tier, browser/version, adapter version, test date, status and reason. Do not promise universal percentages, automatic game/oculus sync or untested mobile/client propagation.
- [ ] **Step 5: Run automated verification**: `npm run test:progress`, `npm run test:transfer`, `npm run build:transfer-scripts`, `git diff --check` and `npm ls --omit=dev`. Expected: all PASS and a second script build leaves no diff. Existing recognition tests require downloaded tiles/reference data; run `npm run test:match` only when that cache is already available and record unavailable prerequisites.
- [ ] **Step 6: Verify packaged macOS Apple Silicon** with `npm run dist:mac`, then `node node_modules/@electron/asar/bin/asar.js extract "dist/mac-arm64/Genshin Map Overlay.app/Contents/Resources/app.asar" "/private/tmp/gmo-transfer-package-mac"` and `npm run check:transfer-package -- /private/tmp/gmo-transfer-package-mac` (choose a fresh directory if it exists). Exercise profiles/import/export/spot/filter/focus/restart and existing capture/hotkeys with separate test OS-user data, leaving personal saves alone.
- [ ] **Step 7: Verify packaged Windows** with `npm run dist -- --publish never`, then `node node_modules/@electron/asar/bin/asar.js extract "dist/win-unpacked/resources/app.asar" "dist/transfer-check-win"` and `npm run check:transfer-package -- dist/transfer-check-win` in a fresh extraction directory. Repeat local UI/lifecycle tests and Windows hotkey/capture smoke checks in the test OS user.
- [ ] **Step 8: Complete and date live browser acceptance** for every advertised pair using the provider convention, in desktop Chromium and Firefox wherever claimed. Include reload/account persistence, destination-only progress, cancellation and fresh retry; validate the generated envelope's all-found full-catalog size/count against the actual limits. If Drive has landed, test an actual connected profile import/restore plus a second-device canonical sync; verify the attachment is available there only after portable backup import. Otherwise record live Drive integration as pending, with the fake interlock contract proved. Pending device/account/browser checks remain release gates, not passed tests; a failed provider requires a user-visible scope decision.
- [ ] **Step 9: Commit** owned delivery/docs/test files: `git commit -m "feat: package and document verified map save interoperability"`. This plan ends with reviewable local code/artifacts; it does not publish a site, push a release or deploy a backend.

## Self-review and execution handoff

Coverage: feasibility/order/variants → Tasks 1, 7–11; envelope validation/retention/portable backups → Task 2; identity/category/realm/floor/confidence/round-trip safety → Task 3; durable idempotent local import/duplicate destination/undo/export/Drive interlock → Task 4; browser context/backup/pacing/cancel/readback/partial receipts → Task 5; actual provider pairs → Tasks 7–11; trusted IPC/shared focusable EN/DE settings/authoritative UI → Task 6 plus the prerequisite; packaging/support evidence/instructions → Task 12. Each Review Focus condition has assertions in its owning task.

Site methods, endpoint names, native save versions, coordinate coefficients, matching tolerances and provider pacing are measured outputs of explicit feasibility/adapter steps. None is a promised capability or an invented placeholder. Access-dependent work remains a gate if evidence cannot be obtained; five working integrations cannot be claimed from offline fixtures.

Recommended execution: **Subagent-driven**, because the six prerequisite tasks and twelve transfer tasks cross persistence, matching and externally persisted writes, and each boundary benefits from independent review. **Native** remains a lower-cost option when sequential implementation is preferred. Review both linked plans and choose the execution method before implementation.

## Execution status (2026-10-26)

Offline portions of Tasks1–6 are implemented and independently reviewed on local branch `import-export`, reusing the completed local foundation. Temporary-data native settings/file-transfer checks passed with stubbed pickers; live website checks remain pending at the user's explicit request. All five providers remain planned/unavailable and bundled scripts stop before reading/writing a site save. Actual adapter/mapping/persistence work in Tasks7–11 is open; independent documentation/package/core verification continues in Task12. No five-provider completion or release claim follows from synthetic tests.
