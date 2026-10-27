# Kongying browser-local source evidence, 2026-10-27

The supported source is the currently loaded browser-local save on [Kongying v3](https://v3.yuanshen.site/). This research performed public catalog reads only. It did not read a real user's progress, write a website save, access Gitee, or establish destination-write acceptance. The reader and normalizer are separate modules; the correspondence generator does not enable them by itself.

## Observed first-party contracts

The reviewed deployed assets are `index.6b600c49.js` and `IndexPage.11f8966b.js`. Index asset function `zm` establishes the ordinary guest token with a fixed public client credential and `refresh_token=all&grant_type=client_credentials`; `Hm` stores it in `_yuanshen_map_usertoken`. The page's `Ca` wrapper uses that exact cookie as a Bearer header on `https://cloud.yuanshen.site/api` routes. Credentials are kept in memory for the public requests and are absent from the saved snapshots and mapping output.

Public catalog requests reproduced the page contracts:

- GET [webapp configuration](https://assets.yuanshen.site/webapp.json).
- POST `/area/get/list`, `{isTraverse:true,parentId:-1}`.
- POST `/marker/get/list_byinfo`, `{typeIdList:[],areaIdList:<resolved Teyvat leaf areas>,itemIdList:[],getBeta:0}`.
- POST `/item/get/list`, `{typeIdList:[],areaIdList:[area],current:0,size:9999,sort:["sortIndex-"]}` for each final area.

The Teyvat read returned **116,008 marker rows**. Item reads across all final areas returned **4,968 item metadata rows**. Realm identity comes from exact configuration tile inheritance and the requested leaf areas. Marker rows themselves do not contain their area. Foreign map coordinates must not be interpreted as Teyvat merely because they resemble them.

`marked_layers` is permanent progress; `marked_timelayers` is timed respawn state and is excluded. The reader verifies the loaded deployment, token, local-save raw strings and current URL before/after catalog work. Other-map and unknown IDs are excluded and counted. This was verified with synthetic reader tests, not an actual user's browser save.

## Input identity

Snapshots are under ignored `work/transfer-research/`; the candidate artifact is there as `kongying-pair-candidates.json` and at `/tmp/gmo-kongying-pair-candidates.json` in the research session. They contain public catalogs only.

| Input | SHA-256 |
| --- | --- |
| `kongying-native.json` | `f61ffeac3d34c67fe16002c15a398cb0f3545b1d68121ecfa47023a89c1ba083` |
| `kongying-items.json` | `b55216b293348fe401b425fdb978523fffea80d6c4162c1750cbde3c59be8405` |
| `kongying-types.json` | `29bc8436554309142670957293e7e676ed53643b0cc36d97d471dbc2040ad8d0` |
| `appsample-catalog.json` | `2301b0fec4f0d8bc3b5c02c325495f93a5c3b6163bcbd788bf3763fa118298c4` |
| `appsample-names.json` | `623453709fdad2bb800bd146da99fbeddc66f105a46fa89b8fe76eb453af17be` |
| Kongying index asset | `dbebe40881656475cbae77dc8c608b1e58dcdfa5545c0da98d45cef09f026320` |
| Kongying page asset | `26de60d1445403db82470807ffa41a504b3f68dac9dd8ba8e86a92a1bc2cbc77` |

The canonical snapshot is the installed overlay's existing read-only cache (`markers-2301b0fec4.json`), with its embedded source time **2026-10-22T05:06:42.214Z**. Current direct AppSample catalog fetches returned HTTP 403 during the parallel research. Consequently this is correspondence evidence against that exact cached catalog, not a claim that the live AppSample catalog was freshly downloaded. Runtime integration must verify exact source and canonical row facts before accepting each bundled pair.

## Conservative semantic scope

Oculus calibration recognizes only these explicit item names: `散失的风神瞳`→`o5`, `散失的岩神瞳`→`o6`, `散失的雷神瞳`→`o194`, `散失的草神瞳`→`o403`, `散失的水神瞳`→`o508`, `散失的火神瞳`→`o626`.

A normalized category is the sorted distinct compound of **all** item IDs. For an oculus correspondence, every component must resolve to the same explicit oculus class and same native area. A compound containing a chest, resource, unknown item, or different class is excluded from oculus mapping, including cases where the first item alone would have looked usable. Chest correspondence uses the separately evidenced, explicit property rule below. No numeric source ID establishes canonical identity.

Coordinates are native Leaflet longitude/latitude: `position="lat,lng"` becomes source `{x:lng,y:lat}`. The fitted canonical affine input is `[source.y,source.x,1]`. Canonical facts are decoded from delta IDs, `mid === 2`, and `src/shared/geo.js` Web Mercator pixels at zoom 13. Canonical floors are `null` under the overlay's transfer catalog contract. Unknown floor distinctions are not invented.

## Calibration and independent checks

`tools/transfer/kongying-pairs.js` is an offline, dependency-free generator. Each item area/class gets its own affine model. Bootstrap scale is 0.375; bootstrap offsets are `[1051048,1048885]` for mainland areas and `[1049949,1048885]` for Inazuma areas 12/13/14. These are only initial searches: each area must independently pass the checks below. Inazuma's approximately 1,100-pixel x-offset difference and the failed Resort calibration demonstrate why a single worldwide transform is unsafe.

Training uses source `id % 5 < 3`; independent held-out observations use `id % 5 >= 3`. Training bootstrap candidates must be within 20 pixels, second target at least 12 pixels away, and nearest/second gap at least 8 pixels. Four fit/refinement rounds retain training residuals ≤4 pixels. A scope needs at least eight retained training anchors and eight held-out matches, held-out p90 ≤6 pixels, and ≥80% of all held-out observations matched within 8 pixels. Fitted primary scales must be within 0.002 of 0.375 and cross-axis coefficients below 0.002 in magnitude. Held-out points never enter the fit.

An individual emitted pair additionally requires:

- Residual ≤2.5 canonical pixels.
- Reciprocal nearest identity in both directions; second neighbor distance ≥12 pixels, gap ≥8 pixels, and second/first distance ratio ≥4 in each direction.
- No second source observation containing this oculus class within 12 pixels after native scale conversion, including other areas and mixed categories. This conservatively removes possible coincident/nearby floor ambiguity.
- Unique source and canonical destination IDs. Destination collisions are removed together.

| Area / class | Training anchors | Held-out count | Held-out p90 px | Accepted |
| --- | ---: | ---: | ---: | ---: |
| 12 / Electroculus | 48 | 30 | 3.504 | 56 |
| 13 / Electroculus | 29 | 19 | 3.125 | 44 |
| 14 / Electroculus | 17 | 12 | 2.928 | 23 |
| 19 / Dendroculus | 62 | 42 | 3.780 | 70 |
| 22 / Dendroculus | 32 | 21 | 3.675 | 40 |
| 23 / Dendroculus | 25 | 11 | 1.555 | 34 |
| 28 / Hydroculus | 43 | 38 | 2.726 | 69 |
| 29 / Hydroculus | 33 | 29 | 2.143 | 59 |
| 30 / Hydroculus | 33 | 32 | 2.349 | 61 |
| 45 / Pyroculus | 56 | 50 | 2.243 | 99 |
| 46 / Pyroculus | 29 | 24 | 2.389 | 49 |
| 47 / Pyroculus | 16 | 22 | 3.081 | 34 |

The oculus subset is **638 pairs**: 123 Electroculus, 144 Dendroculus, 189 Hydroculus and 182 Pyroculus. Largest emitted residual is **2.496557462356451 px**. Areas/classes rejected as whole scopes: Anemoculus area 6 (held-out p90 7.496), Geoculus area 2 (9.471), Dendroculus area 21 (7.654), Hydroculus area 31 (insufficient anchors/holdout), and Pyroculus area 49 (bootstrap mismatch/no anchors). Other maps, puzzles, shrines, resources, unidentified associations, and unsupported oculi remain unmapped. Basic chests have the additional narrowly supported subset described below.

The training/holdout split measures geometric generalization within the observed catalogs. It is not a manual per-marker gameplay audit, and the bootstrap does not use source/target ID equality. Detailed input hashes, fitted coefficients, training pairs, independent held-out pairs and residuals are included in the candidate artifact for review.

## Chest compound semantics and independent projection

The [deployed first-party page asset](https://v3.yuanshen.site/assets/IndexPage.11f8966b.js) explicitly renders the chest filter as `宝箱品质` (quality) with value **10**, or `宝箱形式` (form) with value **11**. It routes both through the same marker catalog and marker records. Public item metadata agrees: basic chest quality items have `typeIdList:[10]`; `直接开启` (open directly) and `击败魔物` (defeat monsters) have `typeIdList:[11]`. Type-list metadata identifies the parent category id9 as `宝箱` (chests); the deployed UI is the direct evidence for the meanings of its 10/11 children.

The page's `popup_callback` reads `n[0].target.options.data.id`, toggles **one marker ID** in `marked_layers`, then loops through the marker's `itemList` to update every associated item's counter. The quality and mechanism are attributes of the same completion record, rather than separately persisted chest and mechanism IDs. This supports mapping a compound quality+simple mechanism to its explicit chest class, while retaining the complete compound as the source identity.

The generator permits only these five quality names and exact canonical types: `华丽的宝箱`→`o46`, `珍贵的宝箱`→`o45`, `精致的宝箱`→`o44`, `普通的宝箱`→`o17`, `奇馈宝箱`→`o269`. It requires exactly one distinct chest class; every other association must be exactly `直接开启` or `击败魔物`, with exactly `[11]` metadata. Every quality association must have exactly `[10]`. Every association must belong to the same area and have `defaultRefreshTime === 0`; the marker must have `refreshTime === 0`, and every association count must equal 1. Unknown properties, independent collectibles, multiple quality classes, seelie, challenges, dig sites, puzzles, generic chest-related labels and cross-area combinations are excluded.

The public snapshot contains **7,229** rows with one of the five basic chest names; all have permanent refresh metadata. **Zero** rows contain only a chest quality: every chest has other associations. The explicit quality+simple-mechanism rule admits **2,722** candidate compounds globally before area/calibration/geometric gates. Chest observations are never used to fit transforms. Only the 12 areas with independently validated oculus models are eligible. Residual, reciprocal uniqueness, second-distance, margin, ratio and unknown-floor exclusion thresholds remain exactly 2.5/12/8/4 as above. Reciprocal source searches include **all** chest-bearing observations of that canonical class in that area, including ineligible compounds, so an unknown/puzzle marker can veto a supposedly unique correspondence.

The independent chest audit deliberately reports wide residual distributions for the broader set of all chest-bearing markers. For example, area12 median/p90 are 15.223/136.589 pixels, area19 25.365/93.466, and area45 2.243/64.511. A chest reward's rank alone cannot establish the canonical category or location, particularly for mechanisms and puzzles. Those broad distributions do not justify any relaxed threshold or global chest mapping. The emitted subset consists only of individually tight, distinct matches under the explicit semantic policy.

The final result is **1,293 pairs**, comprising the 638 oculi above and **655 chests**:

| Canonical chest class | Accepted |
| --- | ---: |
| Luxurious `o46` | 16 |
| Precious `o45` | 26 |
| Exquisite `o44` | 239 |
| Common `o17` | 292 |
| Remarkable `o269` | 82 |

Of the emitted chests, 171 are direct-open and 484 are defeat-monsters compounds. The per-area counts are 12:80, 13:50, 14:14, 19:100, 22:49, 23:46, 28:66, 29:43, 30:31, 45:121, 46:47, 47:8. No other areas are introduced by this extension.

Auditable examples: source `10278` has compound `297+298` (Luxurious quality type10 + direct-open form type11, area12) and matches canonical `15165/o46`, residual 2.0519844551 pixels. Source `10410` has compound `304+305` (defeat-monsters form type11 + Exquisite quality type10, area12) and matches canonical `15430/o44`, residual 0.0866901468 pixels. Thus sorting or taking the first source item would produce the wrong semantics for at least one of these examples; the generator examines every association.

## Reproduction and verification

```sh
node tools/transfer/kongying-pairs.js \
  work/transfer-research/kongying-native.json \
  work/transfer-research/kongying-items.json \
  work/transfer-research/appsample-catalog.json \
  /tmp/gmo-kongying-pair-candidates.json
```

Output shape is `{version,limits,labels,sourceCount,pairs,diagnostics,chestAudit,inputs}`. Each `pairs` entry is `{source:<exact normalized source record>,target:{id,category,level:null,x,y},reason,residual}`. The output is research input for the parent integration, not an import file or an unreviewed mapping supplied by a user.

Verified locally: generator syntax; deterministic repeat output; all 1,293 pairs have unique source/destination IDs, exact canonical target facts, residual bounds, null floor contract, and accepted per-area diagnostics; chest associations satisfy every explicit metadata/property/count/permanence rule; training and held-out source IDs are disjoint; rejected scopes emit zero pairs. `node --test tests/transfer/kongying-source.test.js` completed successfully in this environment, though the runner reports the file as one suite entry; do not describe this invocation as a separately enumerated seven-test run.

The compact current marker array is approximately **64,781,759 bytes**, close to the reader's 64 MiB (67,108,864-byte) safe limit. The current compact response fits; growth or additional response whitespace may cause a deliberate safe export refusal. No limit was weakened during this work.
