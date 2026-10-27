# AppSample source reader evidence, 2026-10-27

Scope requested in this chat: import progress **from AppSample into the overlay** using a DevTools paste script. Reverse transfer remains pending.

## Inspected first-party sources

- [Live AppSample page](https://genshin-impact-map.appsample.com/?lang=EN), Next build `g2A_0C3iZKpNbinJgViG_`.
- [App bundle](https://genshin-impact-map.appsample.com/_next/static/chunks/pages/_app-1e81edb09414b5db.js), 763,122 bytes, SHA-256 `bdbc98de879db0ae4d7c278f7931dca3972c08d6ca82da6b0fa7452e1192390e`.
- [Webpack runtime](https://genshin-impact-map.appsample.com/_next/static/chunks/webpack-5f99cd6c96255acc.js), existing `webpackChunk_N_E.push` runtime callback contract.

These were retrieved with normal TLS verification. No credentials, personal progress or user document was downloaded during source inspection.

Module **4787** loads `service.get('users', uid)`, takes `markerIds` (or an empty list for a missing document/field), and merges `localStorage['gim-local-markers'].markerIds`. Module **9302** exposes the initialized service as `Z`; `app` is `gim`, `auth.currentUser.uid` and the service's `uid` identify the active user, and `get` uses the site's authenticated Firestore reader. Module **7426** exposes Redux as `window._store`; `getState().user.user.uid` identifies the user displayed by the map. Module **3580** exposes the complete decoded catalog as `gz`, grouped by numeric map ID and category. Rows expose `id`, `mid`, `type`, `lng`, `lat`; raw `level` controls features and is not a validated floor.

The site's `_markAsFound` wrapper catches write errors and returns no durable acknowledgement. This implementation does not invoke it or enable destination writes.

## Implemented contract

`reader.js` checks exact origin, build and app-bundle filename before accessing the inspected module IDs. Its empty webpack chunk registers no factories or remote code. It reads only the active user's marker list through the already loaded site service and the one legacy progress key, rechecks account/catalog/local progress after asynchronous work, and emits only the normalized found Teyvat records. Other maps and catalog-unknown IDs are counted and excluded. It never reads token fields or exports the raw user document. Downloaded files contain no account IDs/names or authentication fields.

This is intentionally a **source-only implementation**. Pair-level capability evidence remains unverified and destination imports remain disabled. A separate static source-reader allowlist in the script builder enables only this direction; it does not weaken the shared browser writer's acceptance checks. Package verification includes and compares both new source files before rebuilding the bundles.

## Verification boundary

Automated source tests execute the actual generated bundle with synthetic user values shaped after the inspected first-party contracts. They cover cloud/local deduplication, Teyvat scope, missing/new accounts, malformed progress/catalogs, account changes, catalog/local-progress changes, and byte-level secret exclusion. The generated file passes through real preview/apply/repository persistence, restart and idempotent merge.

The complete transfer suite passed **249 tests**, and the progress suite passed **254 tests**, including fresh ASAR pack/extract/package verification. A separate smoke ran the generated script against the retrieved first-party webpack runtime and actual module 3580 catalog decoder, with only account/progress values supplied synthetically; it produced the expected two Teyvat records and excluded the other-map mark. This verifies the real loader/decoder contracts, not live authentication.

The current [public compressed catalog](https://game-data.lemonapi.com/gim/markers_all.v5.compressed.json?ver=7de6c213e1ea6f73df7221cc177aeef9298add2e), fetched on 2026-10-27, is **3,058,547 bytes** and contains **87,678** IDs. Running the site's decoder and the source normalizer produced **81,865** Teyvat records and excluded **5,813** other-map records for a synthetic all-found input. The resulting transfer is **12,391,297 bytes**, below the 64 MiB bound. No actual player's progress was used. The source projection's catalog fingerprint was `32109a59332f9fb66c67e1e845d9edda96ffb3b7d8a794a43cda2b2314da1056`.

The user subsequently ran the script in their own signed-in browser and explicitly confirmed that their AppSample profile imported successfully into the overlay. This is user-reported source acceptance for that save; the browser version and account tier were not recorded. Destination persistence, restore and full bidirectional provider-pair acceptance remain unverified.
