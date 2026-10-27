# Map save interoperability research

Date: 2026-10-24. Repository revision examined: `33a0b13`.

## Research checklist

- [x] Inspect the current save, marker identity, coordinate and IPC code.
- [x] Read the existing Google Drive/profile proposal and identify shared boundaries.
- [x] Research five established services with exploration-progress tracking.
- [x] Distinguish provider features, experimental integrations and unverified capabilities.
- [x] Ask which transfer mechanism the user prefers where native file import is absent.
- [x] Record the selected approach and outstanding feasibility work.

No application code or external account data was changed during this research. No third-party transfer script was executed.

## Selection and popularity evidence

Recommended shortlist: AppSample, official HoYoLAB Teyvat Interactive Map, MapGenie, Kongying Tavern/Yuanshen, and Bilibili BWIKI. These are five established candidates, not a verified descending ranking by active users. Comparable current traffic or active-user figures for all five were not available in the sources examined. The evidence is strongest for prioritizing the user's two named services, followed by MapGenie; the two Chinese community maps broaden coverage.

| Candidate | Evidence of relevance | Transfer evidence and limits |
| --- | --- | --- |
| [AppSample](https://genshin-impact-map.appsample.com/?lang=EN) | Its own map supports found markers and account-based cloud saves. This app already uses its marker data. | The map describes legacy browser/cloud backup controls. These are not evidence of a general-purpose modern JSON import interface. A community transfer implementation calls a page function to set found markers; this needs current-site verification. |
| [Official HoYoLAB map](https://act.hoyolab.com/ys/app/interactive-map/index.html) | HoYoverse's [official tools announcement](https://www.hoyolab.com/article/27626979) identifies the map and its region/pin updates. | No documented public third-party save import/export contract was found. A community implementation reads marked-point IDs and writes found states in a logged-in browser. Treat this as an experimental route, not a supported vendor API. |
| [MapGenie](https://mapgenie.io/genshin-impact/maps/teyvat) | Its [publisher's Google Play listing](https://play.google.com/store/apps/details?id=io.mapgenie.genshinmap&hl=en-US) reports 1M+ downloads and explicitly describes found-marker tracking and website progress sync. Android downloads are an adoption proxy, not active website users. | Native file transfer, current data access, write behavior, coverage and account-tier restrictions remain unverified. Website inspection was blocked by robots and browser site-safety policy; no workaround was attempted. |
| [Kongying Tavern / Yuanshen](https://yuanshen.site/docs/) | Its own documentation describes web/client maps, cloud backups, multiple saves, layers and resource respawn tracking. Its [verified GitHub organization](https://github.com/kongying-tavern) owns `yuanshen.site`. | The [v3 web source](https://github.com/kongying-tavern/map_front_v3/blob/master/src/components/save_dialogs.vue) reads `marked_layers` and `marked_timelayers`, and serializes `Data_KYJG` / `Time_KYJG` in Gitee saves. The [client recovery guide](https://yuanshen.site/docs/en/manual/client/save-restore) describes recovery from cached save contents. Web v3, older web releases and the desktop client must not be assumed to share one format. |
| [Bilibili BWIKI map](https://wiki.biligame.com/ys/%E5%9C%B0%E5%9B%BE) | The map is part of Bilibili's Genshin wiki. Its [map instructions](https://wiki.biligame.com/ys/%E8%BF%9C%E5%8F%A4%E5%9C%A3%E5%B1%B1%E5%9C%B0%E5%9B%BE) describe marked-point saves and warn they can be lost after browser/device changes or cookie clearing. | This establishes browser-dependent progress, but does not establish an exact storage key, file schema or safe cloud-write method. The legacy map exposes old-map migration controls. The adapter needs live verification for each supported map generation. |

HoYoLAB web/mobile are one provider family; Kongying Tavern and Yuanshen are one provider family. Do not count aliases as extra integrations.

## Existing app evidence

- `src/data/found.js` keeps one `Set` of numeric marker IDs and saves `{ids:[...]}` to `found.json`. It has no bulk import/export API, profiles, provenance, transaction journal or atomic persistence.
- `src/data/store.js` downloads AppSample's column-based compressed data and preserves its marker IDs. `decodeMarkers` only retains `mid === 2` (Teyvat), converts coordinates with `src/shared/geo.js`, and keeps a level value. Marker array indices and decoded type indices are not stable identities.
- `src/main.js` creates `FoundStore`, handles single-marker toggles, and broadcasts individual changes. The overlay is sandboxed with a narrow preload. Bulk transactions and a complete-state refresh need explicit integration.
- The proposed [Google Drive design](../specs/2026-10-24-google-drive-sync-design.md) introduces profiles, durable progress transactions, explicit true/false states and portable backups. It is still a proposal, not implemented behavior. Reuse that storage boundary rather than creating a second independent save engine.

## Experimental AppSample/HoYoLAB evidence

The author-owned [genshin-map-transfer repository](https://github.com/SimphiweGithub/genshin-map-transfer) demonstrates the intended browser-console workflow. Inspected, but did not execute:

- [`hoyo_export.js`](https://github.com/SimphiweGithub/genshin-map-transfer/blob/main/hoyo_export.js), blob `a1c4fb7b30cf34a493f32df67a506d697c170fa2`: reads marked-point IDs with the browser's existing session, then resolves selected categories to positions.
- [`appsample_import.js`](https://github.com/SimphiweGithub/genshin-map-transfer/blob/main/appsample_import.js), blob `b8558407a0cc13d268e7a3b6e1160c594273c70e`: transforms coordinates, finds nearby category candidates and calls a page-level found-state function.

These are feasibility clues only. They use hard-coded versions/transforms and limited category lists. Their README gives contradictory match-rate claims, so no match percentage is adopted. Its claim about automatic oculus synchronization is also not adopted. A different [transfer tool author's description](https://gametools.yznts.cc/genshin/map-transfer/) reports a different matching approach and asks for login secrets; that credential-pasting design is not selected.

No public shared marker-ID namespace across the five providers was established. Matching by position alone is insufficient: floor, realm, category, puzzle/reward relationships and duplicated locations matter.

## User decision

Asked about setup when a website lacks native save transfer. User answered: “best option is probably some script in the devtools in the browser”.

Use inspectable, self-contained console scripts that run in the destination/source map tab, using its existing signed-in session. Download/upload data files between the browser and app. Do not ask users to copy cookies, passwords or refresh tokens into the desktop app or a transfer server.

## Remaining feasibility work

For every provider and direction, prove current data extraction, exact save scope, stable IDs/catalog access, coordinate interpretation, category semantics, found-state writes, persistence after reload and backup/recovery. Record browser, site version, map, account requirements and test date. An integration is usable only after both directions pass; a downloadable app JSON file alone does not prove export into a third-party site.

Prioritize AppSample, then HoYoLAB, then MapGenie, followed by Kongying and BWIKI. Do not promise five working adapters before these investigations. Do not silently substitute another site if one cannot safely support the required reverse transfer.
