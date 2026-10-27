# Import and export exploration saves across map services

Date: 2026-10-24. Status: builder-checked proposal; awaiting design approval.

## Intent and decisions

Let people bring exploration progress from other Genshin interactive maps into Genshin Map Overlay, continue tracking here, and transfer progress back to the same services. Target five provider families: AppSample, official HoYoLAB Teyvat Interactive Map, MapGenie, Kongying Tavern/Yuanshen and Bilibili BWIKI.

The user requested approximately four or five widely used services, explicitly including AppSample and HoYoLAB, and selected scripts pasted into the browser's DevTools as the preferred bridge where native file transfer is unavailable. The [research record](../research/2026-10-24-map-save-interoperability.md) contains primary sources, source-code observations and capability gaps. The shortlist is not a verified traffic ranking.

This is a substantial feature with shared transfer infrastructure and separate provider adapters. All five remain targets. Each provider ships with tested transfers in both directions; feasibility is established before it is advertised as supported.

## Goals and boundaries

- Import recorded found/completed marker states and export the overlay's recorded states back to each supported provider.
- Make transfers explicit, repeatable and independent of Google sign-in. Work with local-only profiles and the proposed Google Drive profiles.
- Preserve existing progress by default, preview all changes, back up before writing, and report every excluded or uncertain record.
- Keep source credentials in the user's normal browser. No transfer backend, account-password forms, cookie copying or installed extension is required.
- Preserve provider identities and unsupported records so an app import does not silently discard progress that cannot currently be displayed here.
- Use the existing Electron/CommonJS/vanilla-JavaScript architecture and EN/DE translations.

Engineering proposals for the first release: one-time, user-initiated transfers; completed-marker progress; merge-only writes into existing saves. Continuous cross-site synchronization, exact replacement/clearing of destination saves, custom pins, notes, routes, comments, game-state discovery and farming respawn schedules are deferred. A recorded website checklist is the source of truth for transfer; the feature does not infer unopened chests from a game account.

First-release support is scoped to the app's currently displayed Teyvat map, including validated marker levels within that map. Separate realms such as Enkanomiya and the Chasm underground have distinct namespaces. Retain their imported records as unsupported-for-display data, report this explicitly, and allow unchanged records back to their original provider. Rendering and editing additional realms is a separate feature.

Failures include falsely reporting full compatibility, marking nearby but different objects as found, clearing unrelated destination progress, claiming cloud success after only changing browser memory, or silently mixing accounts/profiles.

## Approaches

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Native save files only | Simple and easy to maintain, but sites without a supported importer cannot receive progress | Considered; insufficient as the sole mechanism |
| Self-contained DevTools scripts plus portable files | Runs in the user's existing browser session, supports sites without native transfer, requires a manual console step and site-specific maintenance | Selected by the user |
| Installed browser extension or desktop-managed website login | Could reduce repeated setup, but adds permissions, distribution and browser/session integration | Considered; deferred |

Prefer a site's native file interface inside an adapter when it has been verified. The selected console bridge supplies the missing read/write path elsewhere. Scripts are bundled, inspectable code with no remote script loader or remotely evaluated code.

## Provider scope and delivery order

| Provider | Planned import into app | Planned export back | Current confidence |
| --- | --- | --- | --- |
| AppSample | Console exporter reads current found states and map/catalog identity; direct ID matching for known AppSample markers | Console importer uses verified explicit found-state operations and the site's normal persistence path | Highest identity confidence because this app uses AppSample IDs; current read/write interface still needs validation |
| HoYoLAB | Console exporter reads marked points and resolves IDs, categories, map and layer metadata | Console importer uses the site's authenticated marked-point operations, with paced requests and readback | Community code demonstrates a possible route; no vendor-supported third-party contract established |
| MapGenie | Console exporter reads account progress and corresponding marker metadata | Console importer applies explicit found states through a verified persistence path | Marking and website/app sync are publisher-confirmed; transfer access, account limits and coverage unverified |
| Kongying Tavern / Yuanshen | Export selected save's progress; recognize specifically tested web/client file versions | Importer merges the selected save through its normal state and save mechanism, preserving unrelated data | Published v3 source exposes browser marked IDs and save serialization; desktop format cannot be assumed identical |
| BWIKI | Export browser-local progress for a specifically identified map generation | Importer updates only the verified progress records and refreshes the map through tested behavior | Browser-dependent saves are documented; exact storage format and safe write path unverified |

Delivery order: AppSample, HoYoLAB, MapGenie, Kongying, BWIKI. Finish each import/export pair before moving its status to supported. Website and mobile/client support are separate claims: e.g. MapGenie's account sync may carry website changes to its app, but acceptance must verify that outcome before advertising mobile transfer. HoYoLAB international and mainland endpoints are separate variants; the initial HoYoLAB target is the international service requested here. Do not count service aliases or regional endpoints toward the five-provider limit.

## Transfer flow

Import into the app:

1. Select source provider and destination overlay profile in the transfer settings. New imported profile is the safest default; merging into an existing profile is an explicit alternative.
2. Open the source map in the browser/profile that owns the progress, sign in where required, choose its intended map save, and paste the bundled export script into DevTools.
3. The script checks the origin, recognized site interface, selected save and loaded state. It reads only needed progress/catalog information and downloads a versioned JSON transfer file. It does not modify the source site.
4. Open the file in the app. Validate it in full, resolve mappings and show matched, already found, ambiguous, unsupported, unknown and invalid counts, plus source realm/category coverage.
5. Apply the accepted records as one durable profile transaction after a local backup. Send a complete authoritative progress snapshot to the overlay so counts, filters and the open spot card agree.

Export from the app:

1. Select overlay profile and destination provider. Build a provider-specific transfer file and report what can and cannot be represented. Include source-native records retained from earlier imports where appropriate.
2. Open the target map, sign in and select the intended save, then paste its bundled import script into DevTools. The script provides an in-page file chooser and preview; the user never edits JSON into executable code.
3. Read the current destination state, check context and catalog compatibility, and compute an add-only difference. Preserve every unrelated destination marker, note, route and preference.
4. Download a credential-free backup of the destination progress before enabling Apply. Because browsers cannot reliably prove a download was saved, require the user to acknowledge saving the backup before the first write.
5. Apply explicit set-found operations in bounded batches. Show progress and allow cancellation between operations. Persist through the site's verified mechanism and read back the result.
6. Download a receipt with confirmed, unchanged, skipped, failed and uncertain IDs. A partial write is reported as partial, never as a completed transfer. Re-run safely from current destination state.

The script must show provider, map and selected destination save/account label when the site makes it available. If account identity is unavailable, say so rather than inventing it. Immediately before Apply, recheck context and the preview's relevant-state revision/fingerprint; changes require a refreshed preview. Desktop profile selection is also captured by ID/session generation, so switching profiles cannot redirect a pending import.

## Portable data and identity

Use one versioned transfer envelope for application/browser interchange. Include:

- Format and version, producer/app or script version, export timestamp and provider adapter version.
- Provider, map/realm namespace, catalog fingerprint/version and available layer/category coverage. State whether the export is complete for that declared scope or only partial.
- Records with stable provider marker ID as a string, provider category, map and level when known, explicit recorded state and the minimum position metadata needed for matching.
- Optional already-validated AppSample identity/mapping evidence, plus provenance for retained external records.

The app's progress identity stays `appsample:gim:2` plus stable marker ID for current Teyvat progress, matching the Google Drive proposal. Never use current marker-array offsets, localized labels or decoded type-array indices as identity. Numeric IDs from different services are unrelated even when their values happen to match.

Missing entries mean unknown, not explicitly uncollected. Most source exports contain only found markers; importing them must not generate false states for everything absent. Local false/undo registers remain meaningful in the progress model, but first-release site exports only add confirmed found states. Therefore exporting is a merge, not an exact mirror of all checked/unchecked values.

Unknown but valid source IDs and unsupported realms/categories are retained in a transfer attachment associated with the destination profile. Keep only normalized progress/provenance metadata, not arbitrary browser storage, HTML, authentication fields or the entire raw source file. App edits affect mapped canonical markers; unmapped source records pass back unchanged only to the same provider/map. They must never generate guessed states for another provider.

Transfer attachments are local-only in the first release and are included in the app's portable backup format through a versioned extension. Drive synchronizes the proposed canonical profile progress; it does not synchronize these attachments in the initial design. Consequently another device may export canonical found states but lacks unmapped-source pass-through until that backup is imported there. State this limitation in the UI and docs. Changing that boundary later requires a deliberate Drive schema/protocol revision.

Validate sizes, record counts, ID lengths, strings, finite coordinates, states, schema versions and scope before mutation. Concrete resource limits are a builder choice, documented and tested against a full current catalog. Reject an invalid envelope atomically; valid records with no mapping are retained/reported. JSON is data only. Never execute source text, accept credentials from a transfer file, fetch arbitrary file-supplied URLs or follow file-supplied filesystem paths.

## Marker matching and export symmetry

Order of matching:

1. Exact AppSample IDs within the right map namespace, or a previously validated cross-provider ID correspondence with current catalog compatibility.
2. A maintained, versioned correspondence table derived from reviewed catalog data.
3. Conservative spatial matching after an independently validated provider/map coordinate transform, constrained by compatible category, realm and available level information.

Use calibration anchors and held-out checks across regions. The app currently uses Web-Mercator-derived map pixels; other sites' coordinates cannot be treated as the same space. Version transforms by provider, realm and catalog generation. Check residuals and reject incompatible catalogs instead of applying a stale transform. The builder chooses measured tolerances and an efficient spatial index after examining real data; there is no universal distance threshold or claimed match rate in this design.

A spatial candidate must be unique within a conservative radius with a clear margin over alternatives, and pass reverse-consistency and collision checks. Unknown floors in dense/stacked locations are ambiguous. Do not resolve those by picking the nearest pin. First-release behavior is to retain and report ambiguous records, with a downloadable report; no manual match editor is included. A later mapping-editor feature can add reviewed user corrections and their reverse-export semantics.

Puzzle, seelie, challenge and reward-chest pins can describe different parts of one encounter. Preserve these distinctions. One-to-many or many-to-one relationships require a reviewed semantic rule; otherwise leave them unmapped. Resource respawn state is not permanent completion. Oculi are ordinary categories subject to verified semantics; do not assume automatic game synchronization.

Build mappings for both directions and record their confidence. For a provider supporting import, export back must actually reach its supported save scope. An app-only JSON download is not sufficient. Same-provider exact IDs and retained original IDs are preferred on export; mapped app edits override original found state only under the selected merge policy. New app progress uses validated reverse mappings. Deduplicate destination IDs and never expand an ambiguous mapping into several completed objects.

## Storage and application integration

Reuse the profile/progress transaction boundary proposed in [Google Drive sync design](2026-10-24-google-drive-sync-design.md). That feature has not been implemented. A prerequisite is its local subset: migration from `found.json`, named local profiles, explicit set operations, atomic persistence, backups and complete-state notifications. Website transfer does not depend on OAuth, a Google Cloud project or the Drive worker.

Current `FoundStore.toggle` is unsuitable for replayable bulk transfers. Apply desired true states, not toggle commands. Serialize imports with marker edits and profile changes; capture a current revision, rebuild a stale preview and commit once. Re-importing the same file into the same selected profile must not toggle or duplicate progress. If import creates a new profile, an identical transfer receipt should offer that prior destination for merging; creation of another profile remains explicit.

On a Drive-connected profile, imported canonical changes are fresh local edits with local logical clocks, never trusted remote timestamps/actors. Queue Drive publication only after the whole local transaction is durable. Pause/interlock the sync controller across local restore/import so it cannot publish an intermediate state. A transfer attachment and canonical state must commit/recover together. Failed validation or persistence leaves the original profile intact.

Expected components, with final filenames left to the builder:

- `src/transfer/`: envelope validation, provider registry, mapping, planning and transaction controller.
- Provider-specific parsers/transforms and bundled browser script templates, kept apart from the core matcher.
- A focusable local transfer/settings window, shared with the proposed profile UI if available; it is reachable from the tray and overlay. Detailed layout and CSS are builder decisions.
- Narrow main-process IPC for file dialogs, preview, apply, script retrieval and receipts. Validate the expected window/frame and profile/session revision. Renderers receive no authentication material or arbitrary filesystem/network access.
- Existing `src/main.js`, `src/overlay/preload.js`, progress notifications and `src/shared/i18n.js` receive small integration changes. Map recognition and capture behavior remain separate.

## Browser adapter contract and failures

An adapter separately implements detection, read, normalize, preview, explicit set-found, persistence/readback and progress-backup restore where verified. Require the correct origin and recognized map generation. If the normal site interface has changed, stop with actionable instructions and retain the export file; do not fall back to guessing storage keys or editing broad application storage.

Prefer the site's own state/save methods when they can be invoked safely and their persistence can be verified. A localStorage-only change is acceptable only where that is the verified authoritative save and UI/cloud behavior is understood. Never overwrite whole Firebase, IndexedDB, cookies or unrelated localStorage collections. Do not extract refresh tokens to operate outside the map's session.

For session-authenticated endpoints, use same-site browser session behavior already available to that map, with a fixed endpoint allowlist. No credential-bearing localhost bridge is needed. Do not disable browser security, bypass access restrictions or treat an anti-bot check as something to work around. Abort on logout, profile/save changes, denied access, unknown response format or incompatible catalog.

Use conservative provider-specific pacing, `Retry-After` where supplied and bounded backoff for transient failures. Read destination states before retrying ambiguous timeouts. Count an item as confirmed only after a successful verified persistence result or readback. A changed session stops the run rather than writing to a newly selected account.

Cancellation leaves already-confirmed operations applied and records remaining work. A receipt is bound to provider/map/save context, but resumes only after reading fresh state. Do not store session secrets in receipts or logs. A downloaded backup is not a promise of transactional rollback on a third-party service; document any provider restore limitation. The app's local import can be atomic; a website's multi-request application generally cannot.

## Feasibility and delivery stages

1. **Prove the adapters.** For each candidate, inspect the live map and perform a small controlled read/write/reload/restore test on a disposable save or suitable test account. Establish current catalog access, account requirements, layer semantics, rate limits and restrictions. No writes to a user's real save are part of planning. Record dated capability results. Investigate AppSample and HoYoLAB first.
2. **Local progress and transfer foundation.** Deliver the local profile/transaction subset, migrate legacy progress, define the envelope, add previews/backups/receipts and implement exact AppSample identity matching. Coordinate with the Drive feature to avoid two competing migrations or state stores.
3. **AppSample in both directions.** Complete actual browser extraction and destination writes, including signed-in persistence and reload verification. Validate the current dataset's exact-ID scope.
4. **HoYoLAB in both directions.** Add reviewed type/coordinate mappings, confidence reporting, retained unmatched data and reliable partial-write handling. Use this pair to validate cross-provider architecture.
5. **Remaining providers.** Add MapGenie, Kongying and BWIKI one pair at a time, reusing the infrastructure. Unsupported variants remain visible as planned/unavailable with the concrete reason. If a candidate fails feasibility, bring the proposed scope change back to the user instead of quietly declaring the feature complete with fewer services.
6. **Package and document.** Ship bundled scripts and instructions for desktop Chromium browsers and Firefox where verified. Test packaged Windows/macOS clients, profile/Drive interaction and source-site reloads. Publish a dated support matrix by provider, direction, map, account tier, browser and adapter version.

These are delivery boundaries, not an approved implementation task list. After approval, the implementation plan should specify exact modules, fixtures, commands and the provider feasibility order.

## Acceptance and verification

Use sanitized progress and small catalog fixtures; never commit cookies, tokens, actual account identifiers or private saves. Automated coverage must verify:

- Legacy progress survives migration, imports are atomic, interrupted writes recover and stale profile previews cannot apply to another profile.
- Duplicate files and repeated site runs are idempotent; existing destination-only progress survives; missing source IDs never clear markers.
- Exact AppSample export/import preserves the known ID set, and absent-current-catalog IDs remain recoverable.
- Category, realm and floor constraints prevent false matches; dense clusters, duplicate pins, puzzle/reward differences and one-to-many collisions remain unresolved without a reviewed rule.
- Matched cross-provider round trips preserve the mapped found set without additional completions; unmatched/unsupported records are accounted for and source-native pass-through survives a portable backup/restore.
- Malformed/newer/oversized input is rejected before any mutation. Transfers contain no credentials, local paths, raw browser state or executable data.
- Logout, site changes, throttling, timeouts after successful writes, cancellation and partial failures produce accurate receipts and safe fresh-state retries.
- Connected-profile imports become durable local transactions before Drive upload; true/false register behavior and existing sync conflict rules are preserved.

For every advertised provider, manual acceptance must prove browser source export → app preview/apply → app export → browser destination apply → reload and readback, including an existing destination-only found marker. Verify account/cloud persistence where the provider uses it, and any advertised website-to-mobile/client propagation. Core mapping tests can run offline; live provider checks are explicit acceptance work and are dated. Measure category/realm coverage from a full current catalog rather than promising universal transfer percentages.

## Calls to review

Confirmed: roughly five providers, AppSample and HoYoLAB included, transfer in both directions, DevTools scripts preferred.

Proposals: the five-provider shortlist/order; merge-only completed-marker transfers initially; new-profile import default with explicit merge alternative; Teyvat editing scope with retained unsupported records; local-only provenance attachments included in portable backups; a shared local profile/transaction foundation with the Drive proposal; provider availability contingent on successful tests in both directions; ambiguous matches reported and retained without a manual match editor in the first release.

Builder discretion: internal module/file names, settings layout/CSS, resource limits, measured matching thresholds within conservative rules, spatial-index implementation and provider pacing based on measured/documented behavior.

Builder check: an independent reviewer identified the manual-resolution scope ambiguity. The author settled it as a first-release deferral, reflected above; no further user-only questions were identified by that check.
