# HoYoLAB source import evidence — 2026-10-27

Scope: international HoYoLAB Teyvat saved progress into the overlay. Mainland MiYouShe and website destination writes remain outside this implementation.

## First-party contracts

Inspected normal public HTTPS responses and the current first-party client:

- [Client bundle](https://act.hoyolab.com/ys/app/interactive-map/bundle_cecaae550a4003092d80.js), 128,827 bytes, SHA-256 `a7a74e01799276a76991ecf26e4691046ef4a62ca3f160dee4574459a16f40fe`.
- [Map chunk](https://act.hoyolab.com/ys/app/interactive-map/1_6be3a4156dff00602a2f.js), 547,452 bytes, SHA-256 `4341cae2a8dfe272dee6a847d8f970b9e5986010043fa4f05b28af42e9cdd692`.
- [Public map-2 catalog](https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v3/map/point/list?map_id=2&app_sn=ys_obc&lang=en-us), 88,718 points, 22,114,257 bytes, SHA-256 `8479dd536f29a5db93cf1397bd135d7455870c92e3c1dfe44da899093131d359`.
- [Public category tree](https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v2/map/label/tree?map_id=2&app_sn=ys_obc&lang=en-us), 495,419 bytes, SHA-256 `208dd89c08034532160e12037f14fef2e961544d025506286150f79f7a1d4f79`.

Vue mounts at `#root.__vue__`; its root exposes `$store.state.userInfo`, logged-in `loginStatus === 1`, `uid`, `$route.params.mapId`, and international `$isSea`. The client `getMarkPointList` reads the fixed authenticated GET `/common/map_user/ys_obc/v1/map/point/mark_map_point_list` with map_id 2 and app_sn ys_obc. The returned `data.list` contains marked-point records: **`point_id` identifies the map marker; `id` identifies the saved mark record**. This distinction is covered by regression tests. A successful real authenticated response has not been obtained in this session.

The source script uses ordinary browser credentials on that fixed first-party GET. It never extracts or exports cookies, tokens, account identifiers, author names, mark-record IDs or raw API documents. Authentication/malformed/paginated failures stop export. Account/root/map changes are rechecked after asynchronous work. No progress POST/DELETE is called. Unknown point IDs remain unresolved records in the known Teyvat namespace; absent entries never clear progress.

## Correspondence evidence

The actual installed app's public canonical cache was read without opening personal progress: `markers-2301b0fec4.json` (87,677 total IDs; 81,864 Teyvat), SHA-256 `2301b0fec4f0d8bc3b5c02c325495f93a5c3b6163bcbd788bf3763fa118298c4`. Its marker-name cache SHA-256 is `623453709fdad2bb800bd146da99fbeddc66f105a46fa89b8fe76eb453af17be`. The cache dates from 2026-10-22; current unchanged target rows remain usable and changed/missing ones are excluded by runtime row revalidation. No assumption of matching provider marker IDs is used.

Named permanent classes agree in both public category trees. Coordinates require distinct mainland, Inazuma and volcanic Natlan models; a single global transform fails. `tools/transfer/hoyolab-pairs.js` reproduces the offline calibration and fixed-pair generation. Calibration fits AppSample raw longitude/latitude to HoYoLAB x_pos/y_pos, then packages explicit pairs, not a live spatial model.

| Model | Training / disjoint held-out points | Maximum held-out residual (HoYoLAB units) | Accepted pairs |
|---|---|---|---|
| Mainland | 33 / 32 Anemoculi | 0.073154 | 4,988 |
| Inazuma | 91 / 90 Electroculi | 0.089882 | 734 |
| Natlan volcano | 25 / 24 Pyroculi | 0.074486 | 137 |

Independent classes also agree under the fitted models: mainland includes 131 Geoculi and 80 Crimson Agates; Inazuma includes 79 separately classified Electro Seelie; the volcanic model includes 21 waypoints and 39 time trials. These classes do not enter their corresponding calibration fits. Final candidates require reciprocal unique neighbors, residual ≤0.6 HoYoLAB units, and a runner-up gap ≥2 units against complete same-category source/target candidate sets. Maximum accepted residual was 0.168210. Source point groups/nonzero z_level and canonical raw layer metadata are excluded from pairing. The normalizer preserves an opaque unreviewed-layer qualifier for grouped/nonzero/missing source context, so a later layer change cannot reuse an earlier ground pair; all nearby same-category rows still compete, including excluded floors. Multiple model/target claims are rejected.

The fixed pack has **5,859 pairs** across 23 actually populated permanent source classes. Resources, enemies, fish, unsupported puzzle semantics, ambiguous/stacked locations and changed rows cannot map. Coverage is intentionally partial. The app imports only exact bundled source row facts and revalidates exact current target facts; input mappingEvidence is never an authority. Per-pair provenance remains stable after unrelated catalog additions and removal of another stale pair.

## Verification boundary

Generated source bundles are executed with synthetic source-shaped sessions and downloaded envelopes pass strict validation. Production local import tests cover reviewed pairs, unknown retention, preview/apply, restart, idempotent merge, drift rejection, and app-local reverse conversion. Tests do not establish live HoYoLAB authentication or browser download acceptance. The user can test in their own browser using the same workflow as their successful AppSample import. Full bidirectional capability evidence remains unverified.
