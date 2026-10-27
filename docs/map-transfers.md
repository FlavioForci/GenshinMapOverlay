# Map progress imports and website integration status

Delivery status: **2026-10-27**.

Source scripts are implemented for **AppSample, HoYoLAB, Kongying and BWIKI**. The user confirmed a successful real AppSample import. The other three have automated source-shaped browser tests and verified local import/persistence checks; their live-browser tests remain pending. All destination website import scripts remain disabled. MapGenie's current source access was blocked, so its exporter remains unavailable.

**Cross-provider coverage is partial:** 5,859 HoYoLAB pairs, 1,293 Kongying pairs and 588 BWIKI pairs. Only reviewed pairs become overlay marks. Other valid observations remain local attachments for recovery; a successful download does not mean full profile conversion.

## Import another provider

1. In **Profiles & transfers**, select the provider and **Save source export script…**. Open the saved JavaScript file as text.
2. Open the matching website below in the browser profile that owns the save. Let the map and saved progress finish loading.
3. Paste the **entire script** into that tab's DevTools **Console** and run it. Save `genshin-PROVIDER-progress.json` and read the console summary.
4. Select the same provider in the overlay, choose **New profile (default)** or merge, then **Choose JSON and preview…**. Review matched/unmatched counts before **Apply to profile**. Keep the original JSON and a portable backup.

| Source | Website/save | Reviewed coverage |
|---|---|---|
| HoYoLAB | [International map](https://act.hoyolab.com/ys/app/interactive-map/), signed in, Teyvat map 2 | 5,859 pairs in selected permanent classes, including oculi, standard chests, waypoints and trials; grouped/ambiguous rows excluded |
| Kongying | [v3 map](https://v3.yuanshen.site/), current browser-local save | 638 Electro/Dendro/Hydro/Pyro oculi and 655 standard chests in validated areas |
| BWIKI | [Map tool](https://wiki.biligame.com/ys/大地图), mounted Data:Map4 browser-local save | 588 Sumeru/Fontaine/Nod-Krai pairs: oculi, plumes, shrines and 186 chests; Exquisite chests excluded |
| MapGenie | Current source access blocked | Unavailable |

HoYoLAB reads the authenticated marked-point list using `point_id`, never the mark record's own ID. Authentication/API failures stop export. Kongying exports permanent `marked_layers`; timed respawn entries, other realms and globally unknown IDs are reported and excluded. Load a Gitee save normally into Kongying first; the script reads that loaded local save and does not access Gitee. BWIKI reads the active authoritative backend: an existing IndexedDB database in read-only mode or the map's selected localStorage fallback. It does not merge a stale alternate save, export visibility filters, create databases or read wiki cloud saves. HoYoLAB/BWIKI unknown IDs remain unresolved records because their map scope is known.

Source scripts check the inspected deployment and stop after a version/context change. They never invoke progress setters. Each imported source row must match its bundled category, level and coordinate facts exactly, and its current canonical target must still match the reviewed facts. Unrelated catalog additions do not invalidate unchanged pairs. These fixed correspondences do not enable general proximity or floor matching.

## Import AppSample progress

1. In **Profiles & transfers**, select **AppSample** under the source provider and choose **Save source export script…**. Alternatively, open `src/transfer/scripts/appsample-export.js` from this checkout in a text editor.
2. Open [AppSample](https://genshin-impact-map.appsample.com/) in the browser/profile that owns your progress. Sign in and let the map finish loading.
3. Copy the **entire contents** of the saved `.js` file into that map tab's DevTools **Console** and run it. No editing or account-token copying is needed.
4. Save the requested download, **genshin-appsample-progress.json**. Read the console summary: it reports found Teyvat markers, found markers on other maps, and IDs missing from the current catalog. Other-map and unknown IDs are excluded. An unexpectedly empty export deserves checking the selected AppSample account before import.
5. Back in the overlay, select **AppSample**, keep **New profile (default)** or explicitly choose merge, then **Choose JSON and preview…**. Select the downloaded JSON, review the match counts, and choose **Apply to profile**.

This source script reads saved progress only. It never calls AppSample's marker setters. It uses AppSample's existing authenticated reader without exporting tokens, account IDs or user-document fields. A failed cloud read never silently falls back to local-only progress. Account, catalog or legacy-progress changes during export stop the download. It targets the inspected Next build `g2A_0C3iZKpNbinJgViG_` and app bundle `_app-1e81edb09414b5db.js`; a different deployment requires a reviewed update. Missing/not-found entries never clear overlay marks. AppSample marks do not imply automatic discovery of progress from the game.

## Use local files

1. Open **Profiles & transfers** from the tray or overlay panel. Check the active local profile. Create separate profiles for separate journeys; profile names and regions are labels, not game-account bindings.
2. Keep **Export all profiles…** as your portable recovery copy before a transfer. A transfer file (`genshin-map-overlay.transfer`, version 1) contains one provider/map's normalized observations. A portable backup (`genshin-map-overlay.backup`) contains profiles and preferences. Implemented source scripts produce the transfer format directly. Arbitrary raw website exports and browser-storage dumps are not interchangeable with either format.
3. In **Import a local transfer file**, select the provider that matches the file, then **New profile (default)** or explicitly **Merge into the active profile (add only)**. Choose JSON and preview. A new profile avoids combining separate journeys. Invalid input cannot be applied. Canceling the chooser changes nothing.
4. Review matched/eligible, already found, ambiguous, unsupported, unknown, invalid, ignored not-found and duplicate counts. Check declared categories, levels and incomplete coverage; these describe the file, not guaranteed site coverage. Save the ambiguity/outcome report before applying if needed. Only current, authorized matches become canonical local found marks. Unresolved valid source records remain local attachments for recovery/pass-through.
5. Apply to the selected profile. Import archives the prior local state before one durable commit of canonical progress and attachments. Previewing/reporting/exporting alone changes no progress. Profile edits, selection changes (including switching away and back), catalog changes, a replacement preview or a 15-minute expiry require a fresh preview. Closing/reopening settings also revokes the pending preview.
6. A repeated file can reuse its prior imported profile; explicitly choose **Create another profile** to create a second one. Repeating a merge is idempotent. False or missing source observations never clear an existing found mark. Local undo remains meaningful: undoing an imported matched marker suppresses its original found state on export. A later explicit import containing that found observation can add it again.
7. In **Export a local transfer file**, select destination provider/map and export the active profile. Review the eligibility/exclusion report. AppSample's exact namespace uses current Teyvat IDs. Bundled cross-provider packs convert only reviewed pairs; other observations may pass through only to their original provider/map. These app-local exports do not enable website writes. Do not interpret an empty or retained-only export as a full conversion.

The canonical map is `appsample:gim:2`, the app's displayed Teyvat map. Other realm/map records are retained separately in attachments; they do not mark objects on Teyvat. Categories must have compatible semantics: puzzle/reward pairs, respawn observations and similarly positioned objects cannot be equated by proximity. Raw AppSample levels are not validated floors. Only fixed reviewed category/marker pairs are accepted; no general layer or floor correspondence is inferred. There is no manual match editor or universal transfer percentage, automatic game/oculus sync, or tested mobile/client propagation.

Files over the declared bounds are rejected rather than truncated: transfer 64 MiB / 250,000 records; local envelope 128 MiB; attachment-bearing portable backup 96 MiB (v1 backup 4 MiB). Counts apply across retained data where required. Full current-catalog/all-found sizing remains a provider release gate; earlier public snapshot measurements are not current acceptance.

## Recovery, portable backups and Drive

**Export all profiles…** preserves effective canonical progress, preferences and any transfer attachment in portable backup v2. It replaces local profile IDs with portable indices; importing creates fresh local profiles and activates the first. Older v1 backups remain readable but cannot carry attachments. Unknown/unmapped observations, unsupported categories and other realms need this portable backup to travel to another device. Keep the original source file too. Portable backups preserve effective progress; they are not a register history or a website storage restore.

**Retry local files** reads the actual current durable state after a storage problem. **Restore last good backup** explicitly replaces local state with the validated previous save; originals are preserved for recovery. An import failure before its backup/final rename leaves progress unchanged. An uncertain failure after replacement may already have installed the whole transaction: inspect current state and preview again, never reuse a stale token. If quitting cannot finish saving, fix storage access and retry quitting.

There is **no Google sign-in, OAuth or live Drive sync in this delivery**. The future Drive boundary is canonical progress only; local transfer attachments will not automatically be available on a second device. Import a portable v2 backup there to carry attachments. Offline tests prove the existing canonical-state schema excludes extensions and a fake publication interlock pauses around import/restore and notifies only after the local commit. They do not prove a Drive serializer, connected account or second-device synchronization; those remain pending.

## Website workflow and browser limits

No Chromium or Firefox version has passed the full signed-in provider acceptance workflow yet. The user confirmed AppSample source import in their own browser without recording its version. The three newer source workflows await live-browser tests. Scripts contain inspectable bundled code with no remote loader; MapGenie source and all five destination scripts stop with a pending reason. Respect site and browser security restrictions.

After a provider receives dated acceptance, its instructions must identify the exact owning browser **and browser profile**, website login, selected website save/profile, account tier, origin, map and generation. Browser-local Kongying/BWIKI progress belongs to that browser/profile/storage, not automatically to an account or another device. Kongying's selected Gitee save and BWIKI's localStorage fallback need separate verification; BWIKI wiki-page cloud saves are outside the offered scope.

The planned accepted flow is source export → app file preview/apply → destination file export → destination preview → download a fresh destination progress backup → explicitly acknowledge that backup → apply additions → reload/read persisted state. A requested download alone is not proof that a browser saved the file. Existing destination-only found marks must survive; absent/false entries must never clear them. Source website progress-only restore has not been verified for any variant, and the shared browser runner exposes no user restore command today. An app portable backup cannot restore a site's private storage.

For a future accepted runner, retain any partial/canceled receipt. Confirmed means read back from authoritative persistence; uncertain means a write may have happened without confirmation. Failed/skipped records are reported separately. Stop on identity, login, save, catalog or generation changes. Resume requires a fresh destination read, current context, the matching file/receipt and backup acknowledgement; it does not blindly repeat writes or trust earlier confirmations. Honor rate limits/cooldowns. These behaviors currently have synthetic offline coverage only.

## Provider evidence

The capability registry remains unverified for full provider pairs. Source implementation does not establish website writes, restore, destination-only preservation or a tested browser/account tier. Historical reason codes describe those full-pair gates. Current source availability and partial coverage are documented above.

- [AppSample source evidence](superpowers/research/2026-10-27-appsample-source.md), including the user's successful import.
- [HoYoLAB source evidence](superpowers/research/2026-10-27-hoyolab-source.md).
- [Kongying source evidence](superpowers/research/2026-10-27-kongying-source.md), including compound chest semantics.
- [BWIKI source evidence](superpowers/research/2026-10-27-bwiki-source.md), including regional exclusions.
- [MapGenie blocker](superpowers/research/2026-10-27-mapgenie-source.md).

The [earlier capability research](superpowers/research/2026-10-24-map-transfer-capabilities.md) is historical. No full bidirectional acceptance is claimed.

## Package verification for maintainers

Run `npm run test:progress`, `npm run test:transfer` and `npm run build:transfer-scripts`; a second build must leave script bytes unchanged. `appsample-source.test.js` executes the actual generated source script against synthetic values in the inspected AppSample module shape, then imports its downloaded bytes using the real local repository/service/controller. This is not a real signed-in browser test. The older whole-pipeline fixtures use synthetic normalized envelopes and fake durable sites; they are not five provider integrations.

After packaging, use a fresh extraction directory:

```sh
node node_modules/@electron/asar/bin/asar.js extract "dist/mac-arm64/Genshin Map Overlay.app/Contents/Resources/app.asar" /private/tmp/gmo-transfer-check-fresh
npm run check:transfer-package -- /private/tmp/gmo-transfer-check-fresh
```

On Windows, extract `dist/win-unpacked/resources/app.asar` to a fresh directory and pass that directory to the same checker. Run the checker from the reviewed source checkout used to build the package. It validates fixed JSON/assets against reviewed bytes and rebuilds the ten scripts in temporary storage. It never executes packaged JavaScript, npm scripts or a packaged main entry. Planned/unavailable records need concrete reasons; advertised support additionally requires reviewed adapter/normalizer and cross-provider mapping assets. Exact AppSample identity needs no invented mapping pack. The checker is a delivery consistency check, not a signature or live support proof.

Actual macOS/Windows package behavior, OS pickers/focus, restart/quit, overlay/spot/filter/F9/profile refresh, capture/hotkeys and in-game behavior remain separate manual gates. Earlier isolated native settings/panel smokes covered synthetic UI/IPC/local-file flows, with native pickers stubbed; they do not pass those gates. Verify using separate temporary test-user data, never personal saves. Offline suites do not establish live account/browser/device acceptance or a release; AppSample source success was separately reported by the user.
