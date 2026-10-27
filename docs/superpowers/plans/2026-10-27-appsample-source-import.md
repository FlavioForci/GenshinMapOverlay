# AppSample source import implementation plan

**Goal:** Make the DevTools source export script produce an AppSample Teyvat file that the overlay can preview and import.

**Spec:** `docs/superpowers/specs/2026-10-24-map-save-interoperability-design.md`, narrowed by the current request to AppSample → overlay.

**Approach:** Use the current AppSample page's already loaded modules and signed-in cloud reader. Merge the site's legacy local marker IDs exactly as the site does. Download the existing transfer envelope; use the existing preview, exact-ID matcher, and atomic import. Do not extract credentials or load executable code. The alternative of scraping visible markers misses hidden categories; exporting only localStorage misses cloud saves.

**Constraints:** Preserve existing user changes to package-lock.json. Implement only source export; leave website destination writes disabled. Keep pair-level acceptance unverified until actual signed-in browser acceptance. Pin the inspected Next build and app bundle; stop with an actionable error after site changes, cloud read failure, malformed data, or account/catalog changes. Export only IDs resolved to Teyvat and report counts for other maps and unknown IDs. No floors inferred from raw levels.

## Tasks

- [x] Add a source-shaped browser harness and failing tests for cloud/local union, Teyvat filtering, strict validation, context changes, and end-to-end local import.
- [x] Implement pure AppSample normalization and a read-only browser source reader using the inspected module contracts (9302: cloud service; 3580: catalog; 3951: app identity; window._store: visible user identity).
- [x] Activate the reader only in AppSample's source export script. Keep every destination script and the other four sources disabled. Include and verify reader bytes in package checking.
- [x] Update source-script instructions and EN/DE status text; document the source evidence and limits without claiming live account acceptance.
- [x] Run transfer/progress tests, deterministic rebuild, and source-script-to-local-import checks. Review the resulting patch. A real signed-in AppSample browser remains the final manual check, which the user chose to perform in their own browser.

## Review focus

- Never turn a missing/failed cloud read into a successful empty or local-only export.
- Never export progress from an account that changed during an asynchronous read.
- Never interpret an unknown marker ID as belonging to Teyvat.
- Never include user documents, account identifiers, tokens, or unrelated localStorage in the downloaded file.
- A functional source reader does not imply reverse transfer or a fully accepted provider pair.

## Investigation

2026-10-27: Public first-party `_app-1e81edb09414b5db.js` was retrieved with TLS verification. Build `g2A_0C3iZKpNbinJgViG_`. Module 4787 loads `get('users', uid).markerIds` and merges `gim-local-markers.markerIds`; module 9302 implements authenticated Firestore reads in the site's session; module 3580 exports the decoded full catalog as `gz`. The current bundled scripts stop because no adapter exists, not because local import is absent.

Baseline: 11/13 transfer test files passed in the sandbox. The other two use subprocesses, which the sandbox denies (`spawnSync /usr/bin/node EPERM`); rerun outside that restriction before attributing failures to product code.

Verification: 249 transfer and 254 progress tests passed with subprocesses enabled. The generated source script also ran successfully against the retrieved first-party webpack runtime and catalog decoder, with synthetic account data. The current public catalog contains 87,678 rows, 81,865 on Teyvat; a synthetic all-found export is 12,391,297 bytes. Independent review found no critical or important defects. No live-account success is claimed.
