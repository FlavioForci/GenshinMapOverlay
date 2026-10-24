# Google Drive progress sync design

Date: 2026-10-24. Status: proposed; awaiting user design approval.

## Intent and confirmed decisions

Allow each overlay user to connect their own Google account and carry exploration progress across Windows and macOS devices. Work offline, preserve existing local progress, and support several named Genshin account/server profiles within one Google account.

The user selected hidden Drive app storage with export/import backups, and confirmed multiple named Genshin profiles per Google account. The user also directed all future repository pushes to `git@github.com:mikilimj/GenshinMapOverlay.git`; `origin` has been updated locally.

Read [the full project analysis](../research/2026-10-24-project-analysis.md) for the existing architecture, file inventory and release constraints.

## Scope and success criteria

- Optional Google connection; a fresh installation works without signing in.
- Create, rename and select Genshin profiles; an optional region label helps distinguish accounts. Profile selection is local to the device. Profile deletion/archival is deferred for the first version.
- Sync found/open marker states, profile labels/regions, enabled marker types and hide-found preference. Keep all other app settings local, including language, opacity, marker size, game path, hotkeys, screen/capture settings and data-server configuration.
- A right-click or spot-card action remains immediate in the overlay. Confirm it locally before treating the write as durable; a failed local write restores authoritative UI state and reports an error.
- Changes to different markers made offline on two devices are both retained. A deliberate undo must not be resurrected by merging an older found state.
- Google account switching never uploads one account's cache into another account. Local-only progress enters a Google account only through an explicit copy/import choice.
- Export/import supports recovery without Google access. Never include tokens, device identifiers, logs, screenshots, caches or local paths in backups.
- Use CommonJS and the existing Electron/vanilla-JavaScript architecture. Node for build/test tooling must be `>=22.12.0`. Windows and macOS Apple Silicon are supported targets.

This feature syncs the overlay's own save data. It does not read or write AppSample account progress, Paimon.moe saves or game state. Future import adapters can target the new progress model independently.

## Approaches

| Approach | Benefits | Costs | Decision |
| --- | --- | --- | --- |
| Hidden Google Drive `appDataFolder` | Narrow app-specific access, user-owned storage, no application backend | Polling, OAuth publishing, backups must use app UI | Selected by user |
| Visible Drive save file | User can inspect/copy files in Drive | File-picking UX, renames/deletes/moves, broader file-management concerns | Considered, not selected |
| Application backend | Central transactions and push notifications | Hosted account/database service and ongoing operations | Earlier alternative; outside the selected Drive scope |

Within hidden storage, publish immutable snapshots from each installation rather than having all devices overwrite a single shared JSON file. This is an engineering proposal: it makes concurrency and ambiguous upload retries safe without relying on undocumented conditional-write behavior.

## Ownership and local persistence

Use three explicit concepts: Google account (storage owner), Genshin profile (separate progress), and installation writer (source of edits). Identify a Google account by its verified issuer/subject, not its mutable email address. Email is display information only. Profile and writer IDs are random UUIDs.

Store application-managed files below Electron's `userData`:

```text
progress/
  installation.json                 # writer UUID; local only
  local/state.json                  # local-only profiles
  accounts/<account-key>/state.json # cached CRDT state + durable sync metadata
  credentials.enc                   # active Google credentials, safeStorage encrypted
  backups/                          # bounded pre-migration/pre-import local backups
```

`account-key` is a filesystem-safe hash of the verified issuer and subject. Account-scoped state includes its clock, selected profile, known remote file IDs, pending immutable upload, dirty revision and last-success status. Local-only state has the same profile/progress shape but no Drive binding. Credentials are separate from that state.

One controller serializes local transactions for the current account. Write a temporary file in the same directory, sync/close it, and rename over the destination; retain the last good backup. Never turn malformed state into an empty cloud save. Surface a recovery state and keep original bytes. Bound file size/profile/record counts and validate all schemas before mutation. Preserve valid progress IDs absent from today's downloaded dataset.

Every mutation is an explicit desired value addressed to an account-session generation and profile ID. Stale renderer requests are rejected with the current snapshot. Cloud responses and pending retries carry the same account-session generation; responses from a replaced connection cannot mutate the active session.

## State and merge rules

Logical dataset namespace: `appsample:gim:2`. Store the stable numeric marker ID within it; never persist decoded array/type indices or coordinates as identity.

Each editable value is a register with `{value, clock, actor}`. `clock` is a positive safe integer, `actor` is the writer UUID. Before a local edit, advance the persisted installation/account clock above every observed register clock. Compare registers by `(clock, actor)` with a fixed lexical actor order, keeping the greater one. Merge is commutative, associative and idempotent. Imported backup values are restamped as new local edits, rather than trusting imported clocks/actors.

Marker registers store explicit booleans, including `false` for undo. Never remove false registers in v1. Profile name, region and each synced preference have independent registers; the enabled-types array is one sorted, unique register value. Concurrent profile creation uses different UUIDs, so both profiles survive.

For the same marker edited independently while offline, a deterministic register winner is selected; the implementation does not claim to know the actual wall-clock order of disconnected actions. An edit made after seeing the merged result always wins over that result. This policy avoids dependence on incorrect device clocks.

The effective list of found IDs is derived from true registers in the active profile. Selecting a different profile replaces the renderer's complete profile state, counters and filters together and closes its existing spot card. Applying remote changes to the same profile refreshes the spot button too.

## Drive file protocol

Use Drive API v3 with `spaces=appDataFolder`; create JSON files with `parents:["appDataFolder"]`. Tag files with an app/protocol identifier and writer/generation metadata, and validate content rather than trusting file names or tags.

Each published immutable document contains a versioned envelope, writer ID, increasing writer generation and the full merged register state for all profiles under that Google account. The active profile, credentials, Google email and local paths are excluded. Keep this schema independent of the local persistence envelope.

For each publication:

1. Persist the immutable document body, content hash and generation in the local pending slot. Only one pending publication exists per account; later edits stay dirty for the next publication.
2. Obtain a generated Drive file ID using `files.generateIds(space=appDataFolder)` and durably associate it with the pending document before uploading.
3. Create that exact document with that ID. On timeout/restart, retry the same ID/body. On `409`, read back and validate the existing file/hash before acknowledging success.
4. Persist the acknowledgement, preserving any newer local dirty revision. Only then may another immutable generation be prepared.
5. Retain the newest two acknowledged valid snapshots authored by this writer. Delete older files from this writer only after the successor is durably acknowledged. Never delete another writer's snapshots or files with unknown versions. Cleanup failure does not invalidate a successful sync.

Pull by listing every page of matching files. Cache immutable file contents by ID/hash and merge newly discovered valid snapshots. Merge all valid discovered files, including older generations; register comparison makes duplicates harmless. A file disappearing during cleanup is retried by relisting, never interpreted as an undo. A newcomer reconstructs account state from the remaining writers' snapshots.

This bounds routine remote files by active/retired installations rather than marker-click count. First-version discovery can use paginated `files.list`; a Drive changes cursor is optional optimization only if measurements justify it. Do not introduce webhooks or a backend.

Malformed recognized documents stop publication and show a recoverable error rather than risking a bad merge; an unsupported newer protocol requires an app update. An empty Drive store for an account that previously synced requires an explicit "Restore cached progress to Drive" action before republishing. A new account with no remote state can create profiles normally.

## Sync lifecycle and errors

Main owns one sync worker. Load local state before initial renderer messages. Start background pull after startup; pull on reconnect/resume and before a manual sync. Coalesce local changes for 2 seconds and poll remote changes every 60 seconds while connected; suspend polling during OS sleep. Run at most one sync cycle at a time. Retry network errors, `429`, rate-limit `403` and server failures with jittered exponential backoff capped at 5 minutes. Manual sync may request an immediate retry; avoid duplicate cycles.

Network failures retain pending documents and dirty changes. Refresh an expired access token once before treating an authorization failure as reconnect-required. Revocation, denied scope, account-policy rejection, Drive quota exhaustion, bad local data and newer remote protocol get distinct actionable states. No background sign-in prompts. Tokens, auth codes, callback query strings and sensitive response bodies are redacted from logs.

Disconnect cancels the worker, clears persisted credentials and keeps the currently bound cached profiles usable offline. Offline edits remain bound to that account; reconnecting a different Google account activates its own store. Switching accounts invalidates callbacks/workers before activating the new account. Switching to local-only profiles is explicit. Account selection/profile changes flush local transactions; quit flushes local state and stops timers/requests without waiting for Drive.

## Google connection and credential handling

Use Google's Desktop OAuth authorization-code flow in the system browser, with PKCE S256, random state, a one-time loopback callback bound to `127.0.0.1` on a random port, a 5-minute timeout and cleanup on every exit path. Accept the expected path/method and exactly one matching callback. Request `openid`, `email` and `https://www.googleapis.com/auth/drive.appdata`. Verify the returned ID token with Google's supported auth library, including issuer, audience and expiry, before choosing local account storage. Request offline access and preserve an existing refresh token when a later response omits it.

Add `google-auth-library` as a production dependency; use its OAuth/token validation APIs and a narrow Drive REST adapter. Do not use Application Default Credentials or a service account for end users. The maintainer configures a Google Cloud project, enables Drive API, and creates Desktop OAuth client configuration. Distributed client configuration identifies this public desktop app; it cannot serve as a confidential secret. End users only click Connect and authorize their own account.

Use Electron `safeStorage` after app readiness to encrypt refresh tokens and the account binding. Use its asynchronous availability/encrypt/decrypt APIs; the synchronous APIs are deprecated in the project's Electron 45. Handle temporary unavailability and key rotation without discarding progress or replacing good credentials. Access tokens normally stay in memory. When secure persistence is unavailable, offer session-only connection or reconnect later; never save plaintext tokens. Decryption failure leaves progress intact and asks for reconnection. Mac ad hoc builds may prompt again after updates; stable signing is desirable but purchasing a certificate is not a prerequisite for planning or initial implementation.

Use one production app identity consistently across supported builds so they access the same application-data store. Development/testing uses a separate Cloud project. Confirm cross-build access with two real clients/devices during acceptance; different test/production projects intentionally have separate stores. Production OAuth configuration and a published privacy URL are maintainer-owned release prerequisites, not a reason to require users to create Cloud projects. Google's Testing mode has tester limits and short-lived Drive grants.

## UX and IPC integration

Add a normal small settings window from a tray "Cloud sync & profiles" item and an overlay shortcut. It handles Connect, account identity, profile create/rename/region, Sync now, Disconnect, local-only selection, import/export, local-progress copy and Drive recovery. Use local assets/scripts, a dedicated sandboxed preload, and existing EN/DE translations. Show last successful sync and states such as local only, pending, syncing, offline, reconnect required and error separately from tracker status.

The overlay receives a compact current-profile selector/status. This is an incremental extension of the existing UI; detailed styling remains the implementer's decision. Do not require users to enter technical IDs or OAuth configuration.

Replace renderer toggle requests with explicit set requests. New IPC checks the expected window and top-level frame, uses an allowlist of operations, bounds strings/arrays/file payloads, and exposes safe result/error objects. File pickers run in main; renderer-supplied filesystem paths are not accepted. Neither overlay nor tracker receives credentials or arbitrary HTTP capabilities.

## Migration and backup behavior

On first launch, atomically back up the existing `found.json` and relevant legacy profile-filter settings. Convert unique valid IDs into true registers in a local-only "Local progress" profile, carrying over `enabledTypes` and `hideFound`. Mark migration complete only after the new state is durable; rerunning after interruption must not duplicate it. Leave legacy bytes available for recovery. Malformed source data enters recovery instead of silently creating an empty replacement.

On first Google connection, show cloud profiles and offer to copy local progress into a new cloud profile; this creates a new UUID and restamps copied values. Existing cached/cloud state is never replaced automatically. Declining leaves local profiles available.

Export portable versioned JSON for one or all profiles with names, region, effective true found IDs and synced preferences. Import validates the complete file and size before any change, creates new profile UUIDs, and restamps all imported values locally; reject unsupported versions atomically. First-version import does not overwrite an existing profile. A pre-import local backup supports recovery.

## Delivery boundaries and verification

Expected modules: a pure progress schema/merge module, account/profile storage, token vault, desktop OAuth client, Drive snapshot adapter, sync controller and thin main-process/UI integration. Keep `main.js` orchestration thin rather than adding the whole feature there. Replace the tiny `FoundStore` only when the new persistence path is integrated; map data/recognition modules remain separate.

Plan meaningful Node built-in tests for merge algebra, explicit false states, restart/migration recovery, invalid/corrupt/newer documents, ambiguous uploads, pagination, retry classification, account switching during requests and stale renderer messages. Use injected HTTP/clock/storage dependencies. Add manual two-device acceptance with actual separate Google accounts and several Genshin profiles. Validate packaged Windows and Mac apps, credential persistence/reconnect, profile UI focus, counters/spot cards and existing tracker behavior. No live Google account is required for ordinary automated tests.

Update both READMEs and website privacy copy for optional progress uploads. Add a privacy page to the static site and document production OAuth setup. Reconcile lockfile root version with `package.json`, update the existing Mac workflow/documented Node floor to `>=22.12.0`, and verify the packaged auth dependency/config. Use `mikilimj/GenshinMapOverlay` for future repository/release links and pushes while preserving source credit. Publishing Google configuration, a website or a release is a later explicit deployment step.

## Builder discretion and proposals to approve

Confirmed by user: Drive hidden storage, export/import backups, multiple Genshin profiles, new GitHub origin.

Engineering proposals for approval: sync profile filters with progress; keep presentation/device settings local; logical-clock conflict policy; immutable per-writer snapshots with safe cleanup; create/rename/select profiles in v1 with deletion deferred; small normal settings window; explicit local-to-cloud copy and import-to-new-profile behavior. The builder chooses exact CSS, helper names, current compatible auth-library version, small internal file decomposition and test harness fixtures within these constraints.

## Primary references

- [Google Drive application data](https://developers.google.com/workspace/drive/api/guides/appdata)
- [Desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Auth Library](https://docs.cloud.google.com/nodejs/docs/reference/google-auth-library/latest)
- [Google OpenID Connect identity validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [Generated Drive IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds) and [safe create retries](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Electron credential storage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Google OAuth publishing behavior](https://support.google.com/cloud/answer/15549945?hl=en)
