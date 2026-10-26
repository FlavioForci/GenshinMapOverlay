# Cross-platform map and online progress design

Date: 2026-10-24. Status: proposed; awaiting user approval.

## User goal

Provide one Genshin interactive map that works in the existing Electron overlay and in a normal responsive browser on desktop or phone. Users can consult the map without opening the game, and changes to their exploration progress appear on their other devices while online. Each Google account can keep multiple named Genshin profiles (for example, different game accounts or servers).

The user clarified that regular internet access is assumed. Do not design offline-first behavior, offline write queues, merge/conflict machinery for disconnected devices, or local file synchronization. A temporary network failure should report that saving failed; it does not require an offline product mode.

The full source inventory and existing app architecture are in [the project analysis](../research/2026-10-24-project-analysis.md). The earlier Google Drive-only direction is superseded: Drive is not the shared live backend.

## Proposed product behavior

- A hosted public map is usable without signing in for browsing, search, filters and marker details. Signing in is required to save private progress.
- Users create/select/rename multiple named Genshin profiles under one app account. A profile can carry an optional region/server label. Profile selection can differ per device.
- The desktop overlay and responsive web map load the same marker catalogue and use the same account/profile progress. Mark/unmark and synced filter changes show on the other open client through realtime updates.
- If the network or save is unavailable, show a clear status/error and let the user retry. Do not claim an unsaved edit has synced. No offline persistence or background replay is in scope.
- Existing `found.json` and synced marker filters are migrated to a profile only after explicit account sign-in and user confirmation. Never attach local progress to a different account silently.
- Language, opacity, marker size, hotkeys, screen/capture selection, game path, recognition settings and other device preferences remain local. Screenshot capture remains local.
- This syncs this app's progress only. It does not read/write AppSample or Paimon.moe user accounts, and does not change game state.

## Shared backend proposal

Use Firebase Authentication plus Cloud Firestore as a single shared online service. Email/password authentication provides a common identity flow in browser and Electron; Google sign-in can be considered as an optional UX addition. Firestore snapshot listeners deliver live changes to clients. Require authentication for user progress, and enforce ownership in Firestore Security Rules using the authenticated UID. Public Firebase client configuration is not a secret; authorization belongs in rules.

This is a proposal, not a user-selected vendor. Alternatives:

| Option | Fit | Trade-off |
| --- | --- | --- |
| Firebase Auth + Firestore (proposed) | Shared web/Electron SDK, realtime document listeners, rules scoped to user | Vendor-specific schema and billing/quotas to monitor |
| Supabase Auth + Postgres Realtime | SQL model and row-level security | More relational schema/RLS setup; realtime subscription design |
| Cloudflare Workers + D1 | Close to the existing Pages deployment | Requires building/operating auth, API and realtime notification behavior |

No Google Drive sync in the first version. Drive backup/export can be evaluated separately after the live map works.

## Data model and subscriptions

Keep the public marker dataset in the existing versioned static data publishing flow; do not copy the world catalogue into user storage. Persistent marker identity is `{namespace: "appsample:gim:2", markerId}`. Never store translated category indices or coordinates as identity.

Proposed private documents:

```text
users/{uid}/profiles/{profileId}
  name, region, enabledTypes, hideFound, updatedAt
users/{uid}/profiles/{profileId}/markers/{namespace_markerId}
  found, updatedAt
```

Only save explicit marker state. Marking found writes `found: true`; unmarking deletes that marker document (or writes false if implementation details require stable documents). With online writes, no tombstones, actor clocks, CRDTs or merge algorithm are needed. The active profile subscribes to its metadata and marker documents; switching profile unsubscribes from the old profile and loads the new one. Do not subscribe every user to global marker data through Firestore.

## Client integration

- **Web:** Expand the existing static `server/public/` site with a responsive interactive map route. Reuse the project's marker data format, map tiles, icons, category names and coordinate logic. Add account UI, profile selector, filters and found toggles. Guest browsing does not require a backend account.
- **Electron:** Keep OAuth/auth state and progress writes behind a narrow, validated main/preload boundary consistent with existing context isolation. The overlay receives only display-safe account/profile/progress snapshots and explicit set-found intentions. Add a normal settings/account window or tray flow for login/profile management; the non-focusable overlay should not host a full account form.
- **Shared behavior:** Both clients use the same Firestore paths and progress semantics. Apply listener changes to counters, marker appearance, and an open spot card. Reject invalid IDs/profile IDs and writes after an account/profile switch.
- The current Node-only `DataStore`/`decodeMarkers` path uses `fs`/`path`; factor reusable decoding or provide a browser-safe static catalogue module instead of duplicating the map dataset.
- Keep tracker screen frames and local device settings out of the cloud. Package Firebase dependencies/config through the explicit Electron build file list.

## Security, migration and operations

- Rules allow each signed-in UID to read/write only its own user subtree; unauthenticated clients can read no private progress. Validate document shape, ID bounds and allowed fields in rules and client code.
- Account deletion/profile deletion behavior must be explicit in UI. Do not expose profile documents publicly or add public sharing in v1.
- On login, offer to import local `found.json` and marker filters into a newly created profile. Preserve local backup until the user confirms successful upload. Existing progress in another signed-in account must never be silently overwritten.
- Maintain separate Firebase development and production projects, configure email/password provider, deploy reviewed Firestore rules, and document the privacy/data retention behavior. Individual users should not need to provision their own Firebase project.
- Update both READMEs, privacy notice and product links to explain that private progress is stored online and live-synced. Fix existing local-only/no-upload claims. New repository/release links should use `mikilimj/GenshinMapOverlay`; keep upstream/AppSample attribution.
- Keep app data and public marker bundles separate; never put user progress or credentials in Cloudflare Pages build artifacts.

## Success criteria

1. A guest can open the hosted map on a phone and browse/search/filter without launching Genshin or installing the desktop app.
2. A signed-in user can create two named profiles and their progress remains separated.
3. Marking/unmarking a marker in the browser updates the overlay for the same profile, and vice versa, while both are online.
4. A user's data cannot be read or changed by another account; rules are emulator-tested.
5. Existing local progress is imported only after confirmation and remains recoverable if the upload fails.
6. A failed online write produces an understandable error and does not falsely show a synced state.
7. Device-only settings and tracker captures remain local.

## Review focus before implementation plan

Confirm the intended guest map behavior, account provider, whether email/password is acceptable as the default (the backend choice remains a proposal), and that explicit online-only save behavior is acceptable. Then write the implementation plan with file-level steps, security rules, migration, tests and browser/Electron acceptance checks.

## Official technical references

- [Firestore realtime listeners](https://firebase.google.com/docs/firestore/query-data/listen)
- [Firebase email/password authentication](https://firebase.google.com/docs/auth/web/password-auth)
- [Firestore security rules](https://firebase.google.com/docs/firestore/security/rules-conditions)
