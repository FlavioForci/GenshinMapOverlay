# Map transfer capabilities and acceptance gates

Research began 2026-10-24; offline registry and measurements recorded **2026-10-25**, Europe/Warsaw. This record reuses the dated public-source investigation and mapping investigation. It adds no authenticated requests, private account reads, browser storage reads, transfer writes, or restriction bypasses. No provider is supported. The five original provider families remain targets in the prescribed delivery order.

## Registry and exact scope

`src/transfer/registry.js` lists all five families and returns independent validated copies. Each capability contains exact deployment origins, provider map namespace, inspected source generation, account tier, browser family/version, normalized catalog fingerprint, fixed inspected endpoint/state-path declarations, and separate read/write/restore evidence. The records are metadata; they do not execute these paths.

| Family | Status / reason | Recorded variants | Inspected generation |
| --- | --- | --- | --- |
| AppSample | unavailable / `first-party-progress-interface-unavailable` | current website, account tier unverified | Next build `g2A_0C3iZKpNbinJgViG_` |
| International HoYoLAB | planned / `disposable-account-acceptance-pending` | international website only, account tier unverified | `bundle_cecaae550a4003092d80` and `1_6be3a4156dff00602a2f` |
| MapGenie | planned / `account-tier-acceptance-pending` | website unknown tier, website free, website Pro; all unverified | `map.c8b3a1c6`, game 43 / map 121 |
| Kongying | unavailable / `catalog-and-setter-verification-pending` | v3 local save; separately unverified selected Gitee cloud save | `index.6b600c49` and `IndexPage.11f8966b` |
| BWIKI | unavailable / `catalog-incomplete-and-acceptance-pending` | Map4 IndexedDB; separately unverified localStorage fallback | `Data:Map4`, page revision 689825 |

All variants have unverified progress reads, writes and restores, false live evidence flags, and `pacing: null`. No batch size, minimum interval, account limit or successful persistence rate was measured. Browser family `chromium` identifies the initial intended browser scope; its empty version means **unobserved**, not a tested Chromium release. Firefox, mainland HoYoLAB, mobile and desktop clients gain no acceptance from these records. Unknown catalog fingerprint is empty only for unverified Kongying variants; AppSample's fingerprint describes a dated cache, not freshly verified website compatibility.

The strict validator rejects arbitrary properties, accessor/prototype objects, sparse arrays, unknown origins/maps/state paths/endpoints, malformed dates/fingerprints, duplicate variant IDs, and invalid pacing. A verified observation needs a known browser version, generation, tier and catalog fingerprint. Verified writes require all six acceptance facts plus measured pacing. Support requires an accepted variant with read, write, reload, preservation of an existing destination-only mark, the production import/export pair, and progress-only restore. Evidence is checked independently on each variant; a proved variant cannot fill another variant's missing evidence. These are curated evidence gates, not a way to infer proof from a public source declaration.

## Public source evidence and limitations

**AppSample.** The [public map](https://genshin-impact-map.appsample.com/?lang=EN) loaded Teyvat. Direct requests for useful source chunks and the [upstream compressed catalog](https://game-data.lemonapi.com/gim/markers_all.v5.compressed.json) returned HTTP 403; the current map/progress interface was not obtained. The community `_markAsFound` clue is not a verified API or persistence contract. The later normal browser inspection facility was unavailable. No restriction workaround was attempted. The app's existing public-asset cache supplied a catalog dated **2026-10-22T05:06:42.214Z**, whose full compressed source is 3,058,462 bytes, SHA-256 `2301b0fec4f0d8bc3b5c02c325495f93a5c3b6163bcbd788bf3763fa118298c4`. Its manifest was generated `2026-10-23T00:30:50.821Z`. The catalog has 87,677 distinct IDs across all maps and 81,864 records at `mid: 2`. Delta IDs accumulate over the entire column before filtering Teyvat; categories use stable `o…` keys. Cache freshness is a separate limitation from identity.

**HoYoLAB.** [Map 2 public points](https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v3/map/point/list?map_id=2&app_sn=ys_obc&lang=en-us) returned 88,717 distinct IDs, 21,834,913 bytes, SHA-256 `4600d1e62ddafb865b03e11d561b57e3ab11f74ea28222a2a602e9510f3504c9`. The [deployed main bundle](https://act.hoyolab.com/ys/app/interactive-map/bundle_cecaae550a4003092d80.js) and [chunk](https://act.hoyolab.com/ys/app/interactive-map/1_6be3a4156dff00602a2f.js) declare international progress requests under `https://sg-public-api.hoyolab.com/common/map_user/ys_obc`: GET `/v1/map/point/mark_map_point_list`; POST `/v1/map/point/add_mark_map_point`, `/batch_mark_map_point`, `/new_del_mark_map_point` with that same `/v1/map/point` prefix. Catalog reads use the distinct `sg-public-api-static.hoyolab.com` host. Those are source declarations, not executed account requests. In progress entries, `point_id` identifies the marker; `id` identifies the marked record. Authentication/session wrapper preconditions and successful response shapes remain unobserved. The schema is not validated for mainland service origins.

**MapGenie.** [Public map 121 data](https://mapgenie.io/api/v1/maps/121/data) returned 20,090 locations, 9,494,609 bytes, SHA-256 `79ad31f3b1971800c8c5e177904be857b913a49fd962e532bcc3aa81fce45b3f`. [Current deployed source](https://cdn.mapgenie.io/js/map.c8b3a1c6.js) declares GET `/api/v1/user/map-data/121` and explicit PUT/DELETE `/api/v1/user/locations/{id}` on `https://mapgenie.io`, using the already-active profile where present. Redux found state, feature rendering, and persistent requests are distinct. The convenience callback can optimistically update and then handle a failed save internally; its resolved promise is not durable acknowledgement. No signed-in progress response, account-tier limit or mobile propagation was tested. The logged-out fallback of 50 marks is not an authenticated free-tier limit.

**Kongying.** The [v3 website](https://v3.yuanshen.site/) and [publisher source revision](https://github.com/kongying-tavern/map_front_v3/tree/0e80dd090329cb4964360ef42d2ed6016cf7cc15) show a permanent numeric-ID `marked_layers` array, separate `marked_timelayers` respawn state, and a selected Gitee gist save path. `https://cloud.yuanshen.site/api/marker/get/list_byinfo` and `/api/marker/get/list_byid` require the website's visitor session; no token/authentication call or live catalog read was made. Fixed Gitee GET `/api/v5/gists` and PATCH `/api/v5/gists/{id}` declarations are recorded only for the separate unverified cloud variant. Selected save identity must stay inside the site's session. `load_savedata` replaces progress and is unsuitable for merge. Safe explicit set-found, UI/count refresh, full catalog scope, pagination and conflict-aware cloud acknowledgement remain unverified.

**BWIKI.** [Revision 689825](https://wiki.biligame.com/ys/index.php?oldid=689825) declares `Data:Map4` and six catalog shards. Shards 1/2 were parsed with restricted data-only extraction; shards 4/5 returned HTTP 567; shards 3/6 were not accepted by that restricted parser. No executable fallback was used. Two parsed shards have 23,000 rows, only 22,850 distinct IDs, mixed absent/4 coordinate versions and layers G/A/B. Catalog duplicate conflicts are not resolved by choosing the first row. Current progress uses IndexedDB `wikiYSMap4Data`, version 1, store `pointsOnchoose`, key `id`, records `{id,type,time}`; localStorage fallback is `wikiMap_ys_Data:Map4_Data`, shaped `{data:{[markType]:{[id]:timestamp}}}`. These are source-shaped expectations, not observed private records. Component binding, authoritative storage selection, completed transactions and UI/reload behavior remain untested. The normal wiki cloud operation writes a user wiki page; no cloud variant is advertised or user page read/written.

The partial measurement uses [shard 1](https://wiki.biligame.com/ys/Data:Map4/point.json), 2,095,184 bytes, SHA-256 `20aa23ae568baad83f0a8bf396fa27badf8fd317575c040906de74ce093b7763`, and [shard 2](https://wiki.biligame.com/ys/Data:Map4/point2.json), 1,929,887 bytes, SHA-256 `dd97bfd62cff1e2d8c79ab31e4ee1c372303f4e6ad6e99d7e853025b73a24ce6`.

## Catalog measurements

`tools/transfer/catalog-report.js` accepts strict normalized `TransferRecord[]` inputs and explicit developer CLI paths. It never follows file-supplied paths/URLs or reads account storage. It measures the exact compact UTF-8 JSON encoding of the normalized progress **array**. A separate envelope measurement below includes synthetic producer/time/catalog/coverage overhead. All found states in these measurements are **synthetic**; no account save was observed. “Small” means the first two catalog rows marked true synthetically.

| Snapshot scope | Rows / distinct IDs | All-found array bytes | Small array bytes (2 rows) | Synthetic envelope bytes | Categories / non-null level values |
| --- | ---: | ---: | ---: | ---: | ---: |
| AppSample cached Teyvat | 81,864 / 81,864 | 12,058,442 | 292 | 12,063,672 | 695 / 5 |
| HoYoLAB public map 2 | 88,717 / 88,717 | 14,086,240 | 325 | 14,090,819 | 706 / 0 |
| MapGenie public map 121 | 20,090 / 20,090 | 3,340,177 | 333 | 3,341,678 | 154 / 0 |
| BWIKI shards 1/2 only | 23,000 / 22,850 | 4,066,592 | 354 | 4,067,738 | 123 / 13 |
| Kongying | unknown | unknown | unknown | unknown | unknown |

BWIKI is a measured **partial lower bound**, and its duplicate-bearing array is a sizing specimen, not an accepted transfer envelope. No full BWIKI or Kongying bound is known. The other three measurements cover their entire saved dated snapshot within the declared map; they do not establish current provider completeness, valid floor mappings or transferable category coverage.

| Snapshot | Maximum ID code points | Maximum schema-string code points | Maximum absolute native coordinate |
| --- | ---: | ---: | ---: |
| AppSample | 6 | 17 | 0.90338 |
| HoYoLAB | 6 | 19 | 16119.499932592273 |
| MapGenie | 6 | 16 | 1.3623661972313 |
| BWIKI partial | 11 | 36 | 13779 |

Observed normalized arrays and synthetic envelopes fit the proposed 64 MiB / 250,000-record transfer bound, 128-code-point identity strings, 4,096 coverage entries and `1e12` coordinate magnitude. This does not validate bounds for missing catalogs, newer snapshots, all attachments/profiles combined, additional mapping evidence, receipts or fully populated backups. No profile/file limit changes are part of this task, and no truncation is permitted.

Catalog fingerprints below are **normalized metadata hashes**, distinct from raw response hashes. The algorithm hashes UTF-8 JSON `[provider,map,rows]`, where rows are `[id,map,category,level,[x,y,space]|null]`, sorted by their compact JSON representation; duplicate rows remain present. Found state, untrusted mapping claims, input property order and row order do not change identity.

| Snapshot | Normalized catalog SHA-256 |
| --- | --- |
| AppSample cached Teyvat | `e0a6b038c223b3a33a51393aac12afdfe9256edaf2f1343d8afb4ce699386e4c` |
| HoYoLAB map 2 | `d4dab38636800d2fa6115887309bd0d8f13dc1ef3b23066135c205ad68ce9e2c` |
| MapGenie map 121 | `49cd93ea6ab242ddcc8f88c66c90908cf8e3b1932cae29a2f5732fe8c9bcdc05` |
| BWIKI shards 1/2 | `cff6390377fdb63b2e99b3546455e2f2889ced9bc3ba70974d58b9e7eaeba763` |

Normalization for sizing retains AppSample `level` as a raw string, category `o…` and raw lng/lat in space `appsample:lng-lat`; this field is **not a validated floor**. HoYoLAB category is `label_id`, native x/y space is `hoyolab:x_pos-y_pos`, and normalized level is null because neither `z_level` nor `point_group` alone has established transfer-floor semantics. Raw `point_group` is retained in the small source fixture for later semantic work. MapGenie category is `category_id`, string coordinates convert to numbers, space is `mapgenie:lng-lat`, level is null. BWIKI retains raw layer as a string where present, otherwise null; native coordinate space includes raw version `4` or `unspecified`. No projection or cross-provider coordinate transform is applied.

The sixteen independently named HoYoLAB–MapGenie domain landmarks and the eight held-out results (RMS 2.083097, maximum 3.259225 MapGenie z13 pixels) remain research-only. They establish no AppSample transform, transfer radius, dense collectible identity, shared category ID or floor correspondence. Contradictory AppSample comment names prevent treating those comments as an automatic canonical landmark table. No mapping coefficients, nearest-neighbor assignment or production mapping pack is shipped here.

Reproduction used existing temporary public snapshots; the normalizer and normalized arrays remain temporary. The CLI was run on all-found and small arrays for each of the four measurable snapshots, for example:

```sh
node tools/transfer/catalog-report.js --provider hoyolab --map hoyolab:ys_obc:2 --catalog /private/tmp/transfer-task1/hoyolab-catalog.json --progress /private/tmp/transfer-task1/hoyolab-all-found.json --out /private/tmp/transfer-task1/hoyolab-all-report.json
```

Only aggregate values and small sanitized fixtures are retained in source control. Raw author/content/account fields are absent from fixtures. AppSample, HoYoLAB and MapGenie `progress.json` are null/unobserved; Kongying and BWIKI progress fixtures are explicitly synthetic source-shaped examples. The deterministic browser harness is a test double, with visibly synthetic context/evidence and no browser, credentials or network access; it is never support evidence.

## Pending acceptance gates — all five providers

No designated disposable save/account was provided. Each provider still requires its own dated **source export → app preview/apply → app export → browser add-only apply → reload/readback → progress-only restore** using the production pair, preserving an existing destination-only mark and confirming repeat idempotency. Record browser version, exact generation/catalog, tested tier/save scope, success/failure readback, cancellation/partial results, measured pacing and restore limitations without account identifiers. No manual gate passed in this task.

| Provider | Prerequisite before the shared live gate |
| --- | --- |
| AppSample | Obtain permitted current first-party progress read, explicit set-found, account binding and durable persistence evidence. Reconcile the dated cached catalog with the current website. |
| HoYoLAB | Designated international test account; observed marked-list/add response shapes and normal session preconditions; validated layer/category semantics and canonical correspondence. Mainland stays separate. |
| MapGenie | Designated test account/profile and separate free/Pro evidence; observed persistence failures, fresh user-map readback, actual limits and stable selected-profile checks. Mobile stays unverified. |
| Kongying | Full catalog through the normal permitted visitor session; verified instance/setter/UI count path; designated disposable local save. Independently test selected Gitee cloud save conflict handling/pagination if that variant is offered; preserve timed respawn state. |
| BWIKI | Complete safely parsed catalog, duplicate-ID and coordinate-version policy; verified instance/storage binding; designated disposable IndexedDB save and separately tested localStorage fallback. Wiki cloud-save privacy/semantics need separate design and acceptance. |

The registry/research task's independent offline deliverables are present. Task 1's live feasibility steps remain pending, so neither Task 1's full acceptance nor the five-provider transfer feature is complete. Provider adapters, production script pairs, mapping review, application integration and packaged-client acceptance belong to later work and cannot be inferred from these tests.
