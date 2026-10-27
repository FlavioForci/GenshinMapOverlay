# BWIKI Map4 source reader evidence — 2026-10-27

The BWIKI reader exports the active browser's explicitly marked Map4 points as `genshin-bwiki-progress.json`. It reads existing page data and the selected local save. No wiki user page, account identifier, timestamp, author, description, comment, image, credential, or cloud save enters the transfer. This is source implementation and public-source evidence, not a live private-save acceptance claim. Website destination imports remain separate.

## Inspected first-party sources

The normal [map page](https://wiki.biligame.com/ys/大地图) returned revision **690410**, replacing the historical revision 689825 used in the earlier investigation. The reader pins this inspected revision and `Data:Map4` configuration. The source declares the exact six ordinary visitor catalog pages: [point.json](https://wiki.biligame.com/ys/Data:Map4/point.json), [point2.json](https://wiki.biligame.com/ys/Data:Map4/point2.json), [point3.json](https://wiki.biligame.com/ys/Data:Map4/point3.json), [point4.json](https://wiki.biligame.com/ys/Data:Map4/point4.json), [point5.json](https://wiki.biligame.com/ys/Data:Map4/point5.json), and [point6.json](https://wiki.biligame.com/ys/Data:Map4/point6.json). All six ordinary pages returned successfully. An initial `?action=raw&ctype=text/javascript` request returned HTTP 403; it was not retried or bypassed. The ordinary visitor pages are the actual URLs used by the inspected map's loader.

Public artifacts retained in temporary storage:

- `/tmp/gmo-bwiki-page.html`: map HTML and inline first-party implementation.
- `/tmp/gmo-bwiki-vue.js`: [first-party Vue runtime](https://wiki.biligame.com/tools/MediaWiki:Vue3-global.js?action=raw&ctype=text/javascript), inspected as inert text. It assigns the mounted container's `_vnode` and `__vue_app__._instance`, validating the existing component lookup.
- `/tmp/gmo-bwiki-point1.html` through `/tmp/gmo-bwiki-point6.html`: public catalog pages; corresponding `.txt` files contain extracted `#mapPointData` text, and `.json` files contain safely decoded data.
- `/tmp/gmo-bwiki-catalog.json`: grouped combined public specimen, useful for offline mapping. Its category overwrite order is shard number order; it is not asserted to equal every browser's asynchronous load result.
- `/tmp/gmo-bwiki-normalized.json`: 57,375 safe normalized records from that grouped specimen; `/tmp/gmo-bwiki-conflicts.json`: 198 excluded IDs.
- `/tmp/gmo-bwiki-categoryData.json`: `{data:[...]}` with 565 category descriptors. `markType` is the ID, `markTypeName` the Chinese specific category name, `type` its broad grouping, `collectible` a string flag. `/tmp/gmo-bwiki-mapAreaData.json` contains 11 named area entries and native polygon metadata.

SHA-256 of the map HTML: `b0d956019c8572c149e995c2a23f1e2ecffb279090dd538eae7dc39b2c267c80`. SHA-256 of the grouped public specimen: `fba0a3e7c8da2bbc71188aabe7dca89023bd60351821aaa93f97d60b7142e1c3`. SHA-256 of its normalized JSON: `868358dee8476b06c064d3c6293d30e4c9316b2eb61e66ae6f0c413143d49fc1`. These are raw file hashes, not the transfer helper's scoped catalog fingerprint.

Temporary extraction used Python `HTMLParser` for text and Acorn AST parsing for object/array/primitive literals and negative numeric literals only. Getters, calls, spreads, executable expressions and poisoned keys were rejected. The site's unresolved `:Data:…/json` placeholders were replaced with empty arrays as in its loader. Repeated object keys were decoded with the JavaScript object's last-property semantics. No downloaded source was evaluated. The production reader uses neither this parser nor remote requests: it snapshots the already loaded `window.pointsData`.

## Catalog identity and coordinates

The map loads all six catalog responses before mounting Vue. Each response extends the global `pointsData` using `$.extend`; duplicate category keys overwrite earlier responses in completion order. The instance's computed `pointsDatas` filters by area/layer, so it is unsuitable as the complete catalog. Reading the loaded global preserves the user's actual page catalog and avoids replaying the site's executable loader.

`normalizeCatalog(native)` accepts the loaded grouped contract `{[markType]: row[]}`. A flat `row[]` is also accepted for data already flattened externally, but cannot detect stale outer-category disagreement. Offline mapping should use the grouped contract. Rows require an ID, positive numeric category `markType`, finite `point.lng` and `point.lat`, optional version `4` and optional string `layer`. Numeric coordinates may be strings, including the padded strings present in 19 public rows. Blank/nonfinite coordinates and unknown coordinate versions stop export.

The combined public specimen contains 629 categories, 57,741 rows and 57,573 distinct IDs. Duplicate rows with identical identity metadata collapse. Any ID with conflicting category, coordinates, version or raw layer is excluded entirely from mapping metadata. Another 32 rows disagree with their outer category; their IDs are similarly excluded from all occurrences. Together these policies exclude 198 IDs and leave 57,375 records. Such saved marks are retained as known-Map4 IDs with null category, floor and position through the shared source helper; other valid progress is still exported. The console reports the catalog conflict count and unknown-progress count.

Normalized position is `x = Number(point.lng)`, `y = Number(point.lat)`, in space `bwiki:lng-lat:v4` for version 4 or `bwiki:lng-lat:legacy` for absent version. `map` is `bwiki:ys:Data:Map4`; `category` is the decimal `markType`; `level` is null for G/absent source layers and the opaque qualifier `bwiki:unreviewed-layer` for other explicit layers; `state` is true. The qualifier is not a canonical floor translation. It prevents a formerly ground row from reusing a reviewed pair after its source layer changes. Raw layer participates in duplicate conflict detection but is not asserted to be an overlay floor. Extra source fields are discarded. No projection is applied by this normalizer.

For later mapping work, the inspected first-party coordinate conversion is explicit: version 4 is returned unchanged; legacy WGS84 coordinates are projected with `+proj=merc +a=6378206 +b=6356584.314245179 +lat_ts=0.0 +lon_0=0.0 +x_0=0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs`, scaled by `0.0004883406312203475`, with x rounded and projected y negated and rounded. The actual map defaults to `L.CRS.Simple` with `L.Transformation(0.0078125, 0, 0.0078125, 0)`; `mapData` has no CRS override. It declares maxBounds ±15,360, zoom 4–8 and center `[-7429,-6194]`. The separately declared `baiduCRS` has origin `[0,0]` and resolutions `2^(18-i)` but is not the default selected CRS. These are native-source facts, not evidence of a canonical cross-provider transform or image origin.

## Progress and authoritative save selection

The existing mounted Vue instance exposes `indexedDBState`, `storageName.data` and `onchoose`. `indexedDBState === true` selects existing IndexedDB database `wikiYSMap4Data`, version 1, store `pointsOnchoose`, keyPath `id`, with records `{id,type,time}`. False selects localStorage key `wikiMap_ys_Data:Map4_Data`, shaped `{data:{[markType]:{[id]:timestamp}}}`. The reader does not merge alternate stores or older-map keys. Missing database enumeration support, a missing selected database/store, denied access or an unexpected version fails closed. It lists existing databases before opening without a version argument; an upgrade caused by a disappearance race is immediately aborted. Only a `readonly` transaction is used and its completion is awaited. The site's own `database()` helper is never called because it uses readwrite transactions and contains initialization/migration writes.

`signMarker` inserts a millisecond timestamp into `onchoose` for the Map4 Mark action and deletes it for Cancel. Its persistence path writes/deletes the same IDs. Category visibility uses `showMarkersBox` and selected-type state separately; those selections are not exported. Only positive integer timestamps in the inspected mark structure are accepted. Boolean hide/skip state is not interpreted as found. BWIKI calls these actions “Mark” and “Cancel”; the reader exports that explicit progress convention and does not claim to know whether a user personally collected a marked object.

The persisted snapshot must equal the live `onchoose` timestamps before export. The reader checks the active instance/backend, complete catalog metadata and progress across asynchronous work, performs a second completed persistence read, and checks again before requesting the download. Pending saving, unloaded progress, changed catalog or a switched backend stops export. The shared builder creates the deterministic normalized fingerprint and explicit found-only envelope; absence never means not-found.

## Verification and remaining gates

`node tests/transfer/bwiki-source.test.js` passes **20** offline tests, including both selected storage backends, no alternate-save merge, existing readonly database access, unexpected-upgrade abort, changed-source rejection, timestamp semantics, empty saves, unknown/conflicting ID preservation, stale categories and padded coordinates. Browser storage/DOM APIs are synthetic test doubles; no test reads a private browser save or writes a provider save. The direct test command exposes individual assertions on this runtime. The broader `npm run test:transfer` was also attempted; the capabilities/package file failures involve restricted subprocess execution and were reported to the parent for its final permitted validation. They are not claimed green here.

A real browser-local export, overlay preview/apply/restart acceptance, designated disposable-save website writes, reload/readback and restoration remain unperformed. No account tier, browser version, wiki cloud-save privacy behavior, destination persistence or full provider-pair support is established by this implementation.

## Reconstructed partial snapshot and fixed-pair investigation

The earlier temporary artifacts were no longer present in the resumed environment. A fresh ordinary visitor fetch on 2026-10-27 again returned map revision **690410**. Public pages `point.json`, `point2.json`, `point5.json`, and `point6.json` returned successfully; `point3.json` and `point4.json` returned HTTP **567**, including one subsequent ordinary request. No alternate access mechanism was used for those missing pages. The four available shards were decoded as inert Acorn object/array/literal ASTs with the same placeholder replacement and poisoned-key rejection described above. This reconstructed partial specimen has **36,206** normalized records after **150** conflicting IDs were excluded. It does not replace the earlier full six-shard result or establish the live browser's catalog fingerprint.

Every category used for the candidates below is fully represented as a category array in the successfully retrieved `point5.json`. The four ordinary chest arrays also occur in `point.json` and compare byte-for-byte equal after decoding. Missing shards still prevent a claim of complete catalog/conflict coverage; the live reader's own catalog/conflict checks and exact row binding remain necessary.

These reconstructed inputs are in ignored `work/transfer-research/`: `bwiki-page.html`, `bwiki-point{1,2,5,6}.html`, their extracted `mapPointData` text/JSON, `bwiki-catalog.json`, `bwiki-normalized.json`, `bwiki-conflicts.json`, `bwiki-categoryData.json`, and `bwiki-mapAreaData.json`. Relevant SHA-256 values are:

| Artifact | SHA-256 |
| --- | --- |
| Re-fetched map HTML | `69b33420cd634a6ead9078fb41d490ccbfb6d106ae8dc775e527ae72f03ae932` |
| Partial grouped catalog | `1dc5bcb7f94e3dae463b750d59971819704e2ee8a84112f29883ca60fec3bddf` |
| Partial normalized catalog | `c94f20ab98b50705acb353552737051d2c428e7d348cfd23fe6e8b2074f89e8a` |

Fresh requests to AppSample's public catalog primary URL, its bundle-declared backup URL and versioned names URL returned HTTP **403**, with the primary response identifying Cloudflare error **1010**. The ordinary first-party app bundle was available, but no access restriction was bypassed. Instead, the installed overlay's existing public-data cache provided the canonical input, read without modifying it: `~/.config/Genshin Map Overlay/cache/server/markers/markers-2301b0fec4.json` and `names-623453709f.json`, dated 2026-10-25. Their full hashes are `2301b0fec4f0d8bc3b5c02c325495f93a5c3b6163bcbd788bf3763fa118298c4` and `623453709fdad2bb800bd146da99fbeddc66f105a46fa89b8fe76eb453af17be`. Copies are `appsample-catalog.json` and `appsample-names.json` in the research directory. The real `src/data/store.js` decoder and `canonicalCatalog` produced `appsample-canonical.json` with **81,864** Teyvat markers. This is a two-day-old public-data cache, not a fresh live-catalog assertion; fixed pairs must bind each exact canonical row, so subsequent row drift rejects the affected pair.

`tools/transfer/bwiki-pairs.js` is an offline candidate/review aid. It reads developer-selected catalog files and writes a review artifact; it reads no user progress, loads no executable source, writes no provider save and supplies no runtime spatial fallback. The first-party legacy projection is applied only inside this research tool. Every candidate retains the normalizer's exact original legacy/v4 coordinates and coordinate-space label; no projected coordinate is substituted into source identity metadata. Explicit source layers other than default ground `G` are excluded. The inspected map defines `G` at index zero and derives its `defaultLayer` from that index. Missing/empty layers use that default; no source or AppSample floor is asserted, and all canonical/source levels remain null.

Semantics were checked against BWIKI `markTypeName`/`collectible` and cached AppSample Chinese/English category names. Selected oculi, Plumes of Purifying Light and Shrines of Depths are permanent collectibles. The actual decoded canonical snapshot consolidates **all regional Shrines of Depths into `o8`** (69 markers); translated names still contain unused older region-specific keys. Assigning `o9`, `o212`, `o411`, `o509`, or `o703` from those names would therefore have produced incorrect canonical categories. The tool searches actual `o8` rows, using each region's independently calibrated location to distinguish them.

Separate regional affine fits use only alternating, lexically sorted ground/unspecified oculi records as training points; the remaining oculi and entirely different collectible categories are held out. Initial nearest-neighbor proposals use the observed mainland scale/offset, never ID equality; training proposals beyond 20 canonical pixels are excluded. Six fitting passes use only the training half. Independent-category points never adjust the fit. A region is admitted only if oculi holdout p95 is at most eight canonical pixels, each independent category has at least five points and every independent-category residual is at most eight pixels. These are empirical cross-provider fits, not an assertion that a shared global transform exists.

| Region | Oculi training / held out | Held-out oculi p95 / max | Independent category evidence (all ground/unspecified) | Candidates |
| --- | --- | --- | --- | --- |
| Sumeru | 127 / 127 Dendroculi | 6.645 / 12.299 px | 10 shrines, max 6.321 px; 28 Plumes, max 4.254 px | 265 |
| Fontaine | 70 / 70 Hydroculi | 4.523 / 12.032 px | 6 shrines, max 3.181 px | 148 |
| Nod-Krai | 87 / 86 Lunoculi | 5.156 / 7.262 px | 7 shrines, max 3.866 px | 175 |

Individual candidate acceptance is much stricter than regional validation: residual **≤2 canonical pixels**, second-neighbor distance minus best-neighbor distance **≥12 pixels in both directions**, reciprocal nearest neighbors within the same semantic category, and unique source/canonical IDs. All canonical rows of that category are target competitors globally. All raw source occurrences of that category are source competitors globally, including explicit non-ground layers, rows outside the extension domain and conflicting/stale-container IDs that cannot themselves become candidates. Only repeated occurrences with identical ID/category/coordinates collapse. A source point accepted by multiple regional models, or any source/canonical ID collision, is excluded entirely. The final artifact has zero model/ID collisions.

The same three validated models were extended to four basic permanent chest categories, using the exact Chinese/English chest names: `60→o46` Luxurious, `63→o45` Precious, `62→o17` Common and `265→o269` Remarkable. Every chest source position must be inside the native-coordinate convex hull of that region's actual ground oculi calibration **and** held-out points, preventing extrapolation outside the measured region. All competitors still participate regardless of hull membership or source layer. Chest points never fit or adjust the model. Source `61→o44` Exquisite was examined but excluded entirely: row `222891r7230` has coordinates `[-7029,3373]` with no version 4 flag, hence the declared legacy WGS84 projection is impossible. Guessing its version or dropping this unknown-position competitor would weaken ambiguity checks. Puzzles, reward categories and Seelie courts are not extended.

The final **588** candidates have maximum residual **1.997** pixels, minimum target-neighbor margin **12.571** pixels and minimum source-neighbor margin **12.441** pixels. The strict bidirectional checks retain **402** oculi/Plumes/shrines and add **186** basic chests:

| Source → actual canonical category | Category | Sumeru | Fontaine | Nod-Krai | Total |
| --- | --- | --- | --- | --- | --- |
| `277→o403` | Dendroculus | 153 | 0 | 0 | 153 |
| `341→o470` | Plume | 22 | 0 | 0 | 22 |
| `278→o8` | Sumeru shrine | 7 | 0 | 0 | 7 |
| `354→o508` | Hydroculus | 0 | 94 | 0 | 94 |
| `355→o8` | Fontaine shrine | 0 | 4 | 0 | 4 |
| `2001→o694` | Lunoculus | 0 | 0 | 118 | 118 |
| `2002→o8` | Borderland shrine | 0 | 0 | 4 | 4 |
| `60→o46` | Luxurious Chest | 7 | 7 | 1 | 15 |
| `63→o45` | Precious Chest | 9 | 10 | 5 | 24 |
| `62→o17` | Common Chest | 48 | 17 | 34 | 99 |
| `265→o269` | Remarkable Chest | 19 | 16 | 13 | 48 |

Each artifact row contains the exact source normalized record, exact canonical fact, regional provenance, training/held-out/extension role, residual and both separation margins. This is evidence for a conservative reviewed fixed subset; it is not exhaustive coverage or visual in-game confirmation of every individual object.

The reusable command is:

```sh
node tools/transfer/bwiki-pairs.js \
  --source work/transfer-research/bwiki-catalog.json \
  --canonical work/transfer-research/appsample-canonical.json \
  --out work/transfer-research/bwiki-pair-candidates.json
```

That command produced **588** candidates. Before the stricter source-competitor and chest-extension step, the JavaScript tool independently reproduced the NumPy investigation's 406 oculi/Plumes/shrine regional/category candidates; the final bidirectional margin removed four. The final candidate artifact SHA-256 is `bdadb9fc9bbfe1e0d42b5ab88d62bcdd256f2adffe10bcf87e5d4fa2e8860111`. The artifact records full regional coefficients, every training source/canonical proposal, holdout summaries, extension hulls and thresholds to permit further review. Repeated generation compared byte-for-byte equal. Additional direct offline checks confirmed that adding a same-position non-ground source competitor removes the affected ground match, moving a canonical chest row invalidates its old pair, and introducing a conflicting source occurrence removes that source's pair. These guard checks use synthetic modifications of the public catalog, not player saves. It must be consumed as individually reviewed, exact-row-bound pairs by shared packaging code; the research coefficients must not be deployed as a general import transform.

Mondstadt, older Liyue and Inazuma were excluded because independent/oculi heldouts were less consistent (roughly 10–16 px p95). Inazuma additionally needs a different x offset, invalidating a universal mainland transform. Natlan's mixed legacy/v4 set contained approximately 49 grossly displaced Pyroculus proposals under the mainland fit; the entire region is excluded. Crimson Agates and Cryoculi lack adequate independent category evidence in this selected investigation and are excluded. Missing shards, excluded/conflicting IDs, all non-ground layers, all other categories and all candidates failing the strict individual gates remain unmapped. A live private BWIKI export and overlay preview/apply/restart acceptance remain separate unperformed gates.
