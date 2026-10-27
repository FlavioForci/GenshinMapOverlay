# Remaining provider source imports

**Goal:** Extend the user-confirmed AppSample → overlay flow to HoYoLAB, MapGenie, Kongying and BWIKI, in that order. The current request continues source import, not website destination writes.

**Existing design:** `docs/superpowers/specs/2026-10-24-map-save-interoperability-design.md`.

## Tasks

- [x] Inspect current first-party source independently for each provider; implement read-only source readers/normalizers with source-shaped tests. Keep concrete unavailable reasons where source access or legitimate account binding cannot be established.
- [x] Share bounded envelope creation and deterministic catalog hashing between readers. Retain catalog-unknown IDs only where their source map is known.
- [x] Supply reviewed, conservative marker correspondence to the current AppSample canonical catalog. Equal numeric IDs on different providers do not imply identity. Unmatched/ambiguous marks remain attachments and visible preview counts.
- [x] Wire readers, mapping assets and package verification through fixed paths. Preserve AppSample behavior and all destination write gates.
- [x] Update instructions and evidence, including user-reported AppSample success on 2026-10-27. Run all transfer/progress suites, deterministic builds and full-public-catalog checks; obtain independent review.

## Boundaries

Public-source inspection and synthetic tests are distinct from real signed-in acceptance. No credentials leave the map session. Readers must reject authentication errors, malformed saves and context changes. No access-control workaround, guessed coordinates, respawn progress converted to permanent marks, or silent zero-match success claims.

Implementation is parallel only across provider-owned source files/tests/evidence. The coordinator owns shared helpers, bundler, capability policy, mappings, runtime, UI copy and integration tests. Existing working-tree edits (including pre-existing package-lock.json) are preserved.

## Delivered scope and remaining live checks

- AppSample source success was explicitly reported by the user.
- HoYoLAB, Kongying and BWIKI source readers and partial fixed mappings are enabled; 5,859 / 1,293 / 588 pairs respectively. Their own signed-in/browser-local source checks remain pending user execution. All destination website scripts remain disabled.
- MapGenie current-source access was blocked. It stays unavailable with an explicit source-verification diagnostic; no alternate access route or guessed live contract was used.
- Independent review found and prompted fixes for per-record reverse coordinate spaces and provenance stability after unrelated canonical updates. Layer qualifiers now block reuse after a previously ground source changes layer context.
- Transfer/progress suites and fresh ASAR pack/extract/check cover the shipped modules and fixed assets. Public all-found specimens verify bounded serialization and reachability of every bundled correspondence; they do not represent real saves.

Public all-found sizing (synthetic found sets, 2026-10-27):

| Specimen | Normalized records | Transfer bytes | Reachable bundled pairs |
|---|---:|---:|---:|
| HoYoLAB complete public Teyvat catalog | 88,718 | 14,326,700 | 5,859 |
| Kongying complete public Teyvat catalog | 116,008 | 20,303,122 | 1,293 |
| BWIKI reconstructed four-shard specimen | 36,206 | 5,907,584 | 588 |

Each output strictly parsed and every bundled pair matched the installed canonical snapshot. Kongying's 5,273 distinct compound categories exceed coverage metadata's 4,096-item bound: coverage stays unspecified/incomplete and all records are preserved, including through local pass-through export. No record/byte bounds were relaxed.
