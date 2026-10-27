# Project analysis for cross-platform online map and progress

Date: 2026-10-24. Source revision: `3af5eb6` (`main`).

> Scope update: this source inventory was first written while considering Drive-only sync. The user has since clarified that the product must provide the full map in a phone/desktop browser and live shared progress with the Electron overlay, assuming internet access. Drive-specific design conclusions below are historical research, not the current proposal. See [the revised cross-platform design](../specs/2026-10-24-cross-platform-map-design.md).

## Coverage and evidence

Read every first-party text source tracked in this checkout: both READMEs, all files under `src/`, the website, data-building tools, image-recognition tool, package/build configuration, installer script, workflow, and deployment headers. Inspected dependency metadata in `package-lock.json`, tracked-file inventory, working-tree status, and recent history. Binary assets are presentation resources, not application logic. There are no applicable `AGENTS.md` files in this checkout or its ancestor directories.

This is a source analysis, not a runtime verification. No implementation or tests were run. `node` is unavailable on the current shell PATH. No generated map data or third-party `node_modules` sources are tracked in this repository.

User-directed repository change: `origin` now fetches and pushes `git@github.com:mikilimj/GenshinMapOverlay.git`. No network push was made. Existing product links still name the original upstream; release/download links need updating when this fork publishes its own artifacts, without changing source attribution.

## Application structure

| Area | Files | Current responsibility | Sync relevance |
| --- | --- | --- | --- |
| Main process | `src/main.js` | Startup, single-instance lock, two windows, settings, found state, IPC, tray, lifecycle, screen permissions and capture routing | Own sync lifecycle, account identity, profile activation and trusted IPC |
| Settings | `src/config.js` | Local `settings.json`, defaults, numeric normalization, writes only deviations | Split profile filters from device preferences; keep credentials out |
| Found progress | `src/data/found.js` | One `Set` of numeric marker IDs, `{ids:[...]}` file, 500 ms debounce | Migrate safely to versioned, account/profile-scoped durable state |
| Public map data | `src/data/store.js`, `tileset.js`, `categories.json` | Downloads/cache, marker decoding, icons, comments, photos, reference database and tiles | Keep public data cache independent of private progress |
| Overlay | `src/overlay/index.html`, `overlay.css`, `overlay.js`, `preload.js` | Canvas markers, type filters, settings, photos/video card, progress counts and input forwarding | Add sync status/profile selection and apply authoritative scope-aware snapshots |
| Tracker | `src/tracker/index.html`, `tracker.js`, `preload.js` | Hidden renderer, screen frames, reference preparation, map transforms | Screen frames and recognition output never enter cloud state |
| Recognition | `src/tracker/matcher-core.js`, `reference-builder.js` | ORB, LSH, RANSAC, Lucas–Kanade flow and reference serialization | No sync integration required |
| Shared utilities | `src/shared/geo.js`, `hud.js`, `media.js`, `i18n.js` | Projection, HUD masks, media selection and EN/DE strings | New copy belongs in `i18n.js`; numeric type indices are not persistent IDs |
| Hotkey helper | `src/hotkey-helper.js` | Windows elevated helper; loopback TCP with one-time token | Must never initialize OAuth or access progress/credentials |
| Static server | `server/public/`, `server/wrangler.toml` | Bilingual marketing site and Cloudflare Pages public assets | Privacy page/link and fork release links; no private sync backend needed |
| Data publishing | `server/tools/build-data.js`, `spots.js` | Builds hashed public marker/reference/comment/photo bundles from cache | No user progress or credentials may enter bundles |
| Recognition tool | `tools/match-test.js` | Uses real/synthetic screenshots and cached/downloaded reference data | Existing recognition checks do not test auth, storage or merges |
| Packaging | `package.json`, `package-lock.json`, `build/installer.nsh`, `.github/workflows/mac.yml`, assets | Windows NSIS and ad hoc signed Apple Silicon app | Package auth dependencies/config; validate key storage on both platforms |

## Startup and shutdown

1. `main.js` detects `--hotkey-helper` before regular startup. The helper gets a separate `userData` directory and registers only hotkeys.
2. Regular startup takes a single-instance lock, waits for Electron readiness, loads settings/language, creates `DataStore` and `FoundStore`, then creates overlay/tracker/tray.
3. The overlay receives public settings, all found IDs, tracker status and available marker data after `did-finish-load`.
4. The tracker prepares cached/server/downloaded recognition references and screen capture independently.
5. `before-quit` clears tracked timers and calls `found.saveNow()` synchronously. Settings have a separate 400 ms timer which is not explicitly flushed there.

Sync must load durable progress before sending initial state, start in the background after windows are ready, and preserve pending local work without waiting for a final network upload on quit. Account switching and window reloads need a consistent state snapshot.

## Marker identity and public data flow

`DataStore.loadMarkers()` first uses the configured public server manifest, with direct AppSample/LemonAPI sources as the alternative. `decodeMarkers()` reconstructs delta-encoded IDs, keeps map `mid=2` (Teyvat), builds language-dependent type tables, and returns typed arrays. `markers.id` is an `Int32Array`; `markers.type` stores indices into that particular decoded type table.

Persist the source marker ID plus a fixed source/map namespace (`appsample:gim:2`), never the array index, translated type name, coordinates or tileset version. Preserve unknown marker IDs across map-data updates; a missing marker is not a request to erase its progress. Sharing this namespace with AppSample does not provide access to AppSample accounts.

Public downloads use TTL/immutable local caches and some in-memory deduplication. They are not suitable for private data: their cache behavior can hide errors or return stale bytes deliberately. The browser map needs a browser-safe public data path; private progress requires a separate authenticated backend and realtime transport.

## Current found-state path

`overlay.js:toggleFoundMarker()` changes the renderer's local `Set` optimistically, then calls `overlayApi.toggleFound(id)`. Preload sends `overlay:found-toggle`; main checks the sender, toggles its own `FoundStore`, and broadcasts `found:changed`.

Limitations for sync:

- Only found IDs exist. Unmarking deletes an ID, so absence cannot distinguish "never edited" from an intentional undo.
- There is no schema version, account/profile ownership, revision, migration, pending upload record or atomic replacement.
- Constructor errors become an empty set silently; cloud sync must not propagate a silently recovered empty state over good data.
- Main accepts any coercible numeric ID in the found handler. New mutations need explicit validation.
- Replaying a toggle can reverse an already-applied action; use explicit `setFound({profileId,id,found})` intentions.
- An account/profile context is absent from renderer events, so delayed messages could modify the wrong profile after switching.
- `found:all` replaces counts and redraws, but does not refresh the open spot card's found button. A bulk cloud update must update that button too; close the spot on profile changes.
- A simple union would resurrect intentionally unmarked IDs; a whole-file last-write-wins upload would lose independent changes from two devices.

## Settings ownership

`publicSettings()` exposes only overlay preferences. `overlay:settings` allowlists filter IDs, found visibility, capture visibility, opacity and marker size. Tracker settings are sent separately. `config.save()` persists local defaults/differences; several native settings are changed by the tray.

Proposed sync scope: profile name, optional region label, found/open marker states, enabled marker types and hide-found preference. Keep language, opacity, marker size, hotkeys, active state, screen ID, capture visibility, recognition configuration, game path, server URL and autostart local to each device. Profile filters must stop being written back into the global config after migration. The active profile selection is also local, so using another device does not switch this device's profile.

## Renderer and credential boundaries

Both renderers have `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Preloads expose narrow APIs. Main validates the sending `webContents` for current IPC. Overlay CSP permits local scripts and local/blob/data images, without external connections. The tracker alone is allowed screen capture by comparing the requesting frame with the tracker main frame.

Keep credentials, account switching and progress writes behind narrow, validated client boundaries. Renderers receive only the account/profile/status/progress data they need. Do not add remote scripts or broaden the overlay CSP unnecessarily. New IPC should check the intended top-level frame and window, validate payloads and return plain result objects.

The overlay is normally `focusable: false` and toggles focus only for marker search. Profile naming, account setup, import/export and confirmation flows fit a small ordinary settings window opened from the tray; the overlay only needs a compact profile selector and status/action shortcut. New UI must use the existing EN/DE text system.

## Platform and release constraints

- Windows is the primary target; macOS Apple Silicon is beta. Existing tray/capture/helper branches must remain compatible.
- Mac packaging sets `identity: null` and CI applies an ad hoc signature. Electron documents less consistent Keychain identity across unsigned/ad hoc updates; handle decryption failure by reconnecting, preserving cached progress.
- Any persisted credential handling must use the platform's protected storage; never put credentials in backups or public bundles.
- `package.json` and `package-lock.json` root versions disagree (`1.1.0` versus `1.3.1`). Reconcile to the intended package version when changing dependencies; do not invent a release bump.
- README/CI specify Node 20, but the lockfile has Electron `45.0.0` requiring `>=22.12.0` and Wrangler `4.152.0` requiring `>=22.0.0`. Adopt a documented Node floor of `22.12.0` for implementation/build checks.
- Runtime dependency today is only OpenCV.js; a shared online backend SDK must be packaged for Electron, and packaging currently has an explicit `build.files` list.
- Three `data:import-*` scripts reference tools excluded by `.gitignore` and absent from the checkout. They are unrelated to sync and cannot be assumed available during validation.
- There is no general automated storage/sync test suite. Add focused Node built-in tests for the new data-loss/account-isolation risks; do not make routine sync verification download thousands of map tiles.

## Public documentation changes required by sync

Both READMEs currently state that found progress is local only and the app uploads nothing. New copy must explain private online progress and live synchronization. The website needs an accurate privacy notice. Screen captures must continue to stay local; its existing screen-permission text is specifically about captures and should remain truthful.

The static site and READMEs link to `FlavioForci/GenshinMapOverlay` for downloads. The user's repository is now `mikilimj/GenshinMapOverlay`; use that for new project/release links, while retaining AppSample and upstream credit. Do not publish the new privacy page to the old Cloudflare project by accident: hosting ownership/deployment destination requires configuration by the maintainer.

## Primary documentation checked

- [Drive application data](https://developers.google.com/workspace/drive/api/guides/appdata): hidden per-app storage, narrow `drive.appdata` scope, deletion/visibility constraints.
- [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app): system browser, loopback callback, PKCE and public-client credentials.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): platform encryption and Mac signing behavior.
- [Drive generated IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds) and [upload retry behavior](https://developers.google.com/workspace/drive/api/guides/manage-uploads): app-data IDs and safe retry after ambiguous create results.
- [OAuth audience/publishing](https://support.google.com/cloud/answer/15549945?hl=en): Testing limits and seven-day authorization lifetime for Drive scopes.
- [Paimon.moe settings](https://paimon.moe/settings): confirms its use of Drive's application data directory.

The initial Drive design was superseded by the cross-platform map design. No remote account, upload, product code or backend configuration was made during this analysis.
