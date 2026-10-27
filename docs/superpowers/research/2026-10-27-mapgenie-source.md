# MapGenie source inspection — 2026-10-27

MapGenie source export remains unavailable. This work adds a strict native
catalog normalizer and a browser entry point that stops with an explicit
`source-verification-required` diagnostic before reading account state,
storage, credentials or progress, making network requests, or downloading a
file. It does not implement a successful progress export or destination writes.

## Access evidence and limits

Normal read-only shell requests to each of these first-party URLs returned
HTTP 403 on 2026-10-27:

- [Teyvat page](https://mapgenie.io/genshin-impact/maps/teyvat)
- [Previously inspected bundle](https://cdn.mapgenie.io/js/map.c8b3a1c6.js)
- [Public map 121 catalog](https://mapgenie.io/api/v1/maps/121/data)

The page request was attempted first; the bundle and public catalog were then
requested separately. Each used normal `curl --fail --location` with TLS
verification. These results do not identify whether the rejection originated
at the provider or the environment's access layer. No 403 response was treated
as empty catalog/progress or retried with changed identity, proxy, headers or
credentials.

A normal in-app-browser navigation to the Teyvat page was also denied by the
browser site-safety policy before observation. Its diagnostic explicitly
prohibited alternate browser surfaces, indirect execution or workarounds to
obtain the blocked content. No further access path was attempted.

Consequently no current deployed JavaScript, full native catalog, signed-in
progress response, account identity, selected profile contract, response
authentication failure shape or empty-success distinction was inspected.
There is no `/tmp/gmo-mapgenie-data.json` or current source snapshot from this
run to use for mapping or whole-catalog measurements.

The [2026-10-24 capability research](2026-10-24-map-transfer-capabilities.md)
records an earlier public catalog of 20,090 locations and declarations of
GET `/api/v1/user/map-data/121`, found state
`window.store.getState().user.foundLocations`, and selected profile state
`window.store.getState().user.activeProfileId`. Those declarations alone do
not establish a safe account/profile-bound read protocol. In particular, an
arbitrary Redux object must not be accepted as proof of authentication or a
complete saved-progress response.

## Catalog contract

`src/transfer/providers/mapgenie/normalize.js` exports
`normalizeCatalog(nativeLocations)` for the **native locations array**, not a
guessed API-response wrapper. Its only data evidence is the three public
locations in `tests/transfer/fixtures/mapgenie/catalog.json`, recorded in the
fixture context as a public response checked on 2026-10-24.

Every row must have these fields:

| Native field | Accepted value | Transfer field |
| --- | --- | --- |
| `id` | Positive safe integer or canonical positive decimal ID string | `id`, string |
| `map_id` | Number `121` | `map: "mapgenie:43:121"` |
| `category_id` | Positive safe integer or canonical positive decimal ID string | `category`, string |
| `longitude` | Finite decimal string within transfer coordinate bounds | `position.x`, number |
| `latitude` | Finite decimal string within transfer coordinate bounds | `position.y`, number |

The result has `level: null`, `state: true`, and
`position.space: "mapgenie:lng-lat"`. Catalog `state: true` is a template for
later explicit found-ID selection; it is **not an observation of progress**.
No category equivalence, floor semantics, projection or correspondence with
AppSample is inferred. Input order is preserved and input rows are unchanged.
The array must be nonempty and within the shared record bound. Duplicate IDs,
wrong-map rows, sparse arrays, invalid IDs, whitespace/nonnumeric coordinates,
numeric coordinate fields and excessive magnitudes reject the entire array
with `catalog-unavailable`; nothing is silently dropped or truncated.

## Reader contract and verification

`reader.js` exports `exportMapGenie(window)` and
`runSourceExport({window, fetch, download, console})`. The latter accepts the
shared browser invocation object but only uses `window.location` and
`console.error` while blocked. The direct export rejects other origins/map
paths with `wrong-site`; the expected Teyvat page rejects with
`source-verification-required`. No `genshin-mapgenie-progress.json` is produced.
Successful export must remain disabled until first-party account/profile and
progress contracts can be inspected through a permitted path.

Tests were written first and observed failing because the new modules were
absent. A sparse-array case was then observed failing against the initial
normalizer and corrected. `node tests/transfer/mapgenie-source.test.js` passes
all five focused tests: fixture normalization, strict rejection, canonical
string IDs/zero coordinates, stopped reader without source I/O, and unrelated
site rejection. No browser/account test or signed-in acceptance passed.

The full `npm run test:transfer` run during concurrent integration passed 13
file suites and failed `capabilities.test.js` (empty CLI diagnostic),
`package.test.js` (missing CLI JSON fields and null packaged result), and
`source-envelope.test.js` (shared source module not yet present). Its log is
`/tmp/gmo-mapgenie-transfer-tests.log`. These shared integration failures were
reported to the parent task and are outside this provider's owned files; a
later full run is required before claiming the repository suite passes.
