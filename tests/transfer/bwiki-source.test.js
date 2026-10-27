'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransfer } = require('../../src/transfer/envelope');
const { normalizeCatalog, snapshotCatalog } = require('../../src/transfer/providers/bwiki/normalize');
const { runSourceExport } = require('../../src/transfer/providers/bwiki/reader');

// Synthetic saves using the source-shaped Map4 contracts inspected 2026-10-27.
const row = (id, category = 2, extra = {}) => ({ id, markType: category, point: { lng: '1.25', lat: '-2.5' }, ...extra });
function site(useIDB = true) {
  const catalog = { 2: [row('known'), row('conflict'), row('conflict', 2, { point: { lng: 99, lat: 5 } })], 9: [row('v4', 9, { version: 4, layer: 'B1' })] };
  const values = new Map([['wikiMap_ys_Data:Map4_Data', JSON.stringify({ data: { 2: { stale: 1700000000000 } } })]]);
  const chosen = { 2: { known: 1700000000000, conflict: 1700000000001, absent: 1700000000002 }, 9: { v4: 1700000000003 } };
  if (!useIDB) values.set('wikiMap_ys_Data:Map4_Data', JSON.stringify({ data: chosen }));
  const instance = { indexedDBState: useIDB, storageName: { data: 'wikiMap_ys_Data:Map4_Data' }, onchoose: chosen, daDian: { show: false } };
  let records = Object.entries(chosen).flatMap(([type, ids]) => Object.entries(ids).map(([id, time]) => ({ id, type, time })));
  let existing = true, upgrade = false, abort = false, readHook = () => {}, closes = 0, opens = 0;
  const window = {
    location: { origin: 'https://wiki.biligame.com', pathname: '/ys/大地图' },
    mw: { config: { get: key => ({ wgGameName: 'ys', wgRevisionId: 690410 })[key] } },
    mapData: { dataPrefix: 'Data:Map4', dataList: ['point.json', 'point2.json', 'point3.json', 'point4.json', 'point5.json', 'point6.json'] },
    mapPackage: { wikiData: { _wgGameName: 'ys' } }, pointsData: catalog,
    document: { querySelector: key => key === '#app' ? { _vnode: { component: { proxy: instance } } } : null },
    localStorage: { getItem: key => values.get(key) ?? null, setItem() { throw Error('must not write storage'); } },
    indexedDB: {
      databases: async () => existing ? [{ name: 'wikiYSMap4Data', version: 1 }] : [],
      open(name, version) {
        opens++; assert.equal(name, 'wikiYSMap4Data'); assert.equal(version, undefined);
        const req = {};
        queueMicrotask(() => {
          if (upgrade) { req.transaction = { abort() { abort = true; } }; req.onupgradeneeded?.({ target: req }); req.onerror?.(); return; }
          req.result = {
            version: 1, objectStoreNames: { contains: name => name === 'pointsOnchoose' }, close() { closes++; },
            transaction(names, mode) {
              assert.deepEqual(names, ['pointsOnchoose']); assert.equal(mode, 'readonly');
              const tx = { objectStore: () => ({ keyPath: 'id', getAll() { const read = {}; queueMicrotask(() => { read.result = records.map(r => ({ ...r })); read.onsuccess?.(); readHook(); queueMicrotask(() => tx.oncomplete?.()); }); return read; } }) };
              return tx;
            },
          };
          req.onsuccess?.();
        });
        return req;
      },
      deleteDatabase() { throw Error('must not delete storage'); },
    },
  };
  return { window, instance, catalog, values, setRecords: value => { records = value; }, setExisting: value => { existing = value; }, setUpgrade: value => { upgrade = value; }, setReadHook: value => { readHook = value; }, stats: () => ({ opens, closes, abort }) };
}
async function execute(s) {
  const errors = [], logs = [], downloads = [];
  await runSourceExport({ window: s.window, fetch: () => { throw Error('use existing catalog only'); }, download: async (name, bytes) => downloads.push({ name, file: parseTransfer(bytes) }), console: { error: x => errors.push(x), log: x => logs.push(x), warn: x => logs.push(x) } });
  return { errors, logs, downloads };
}

test('BWIKI normalization retains native coordinate versions, strips private content and excludes all conflicting IDs', () => {
  const raw = { 2: [row('same'), row('same'), row('bad'), row('bad', 2, { layer: 'B1' })], 9: [row('v4', 9, { version: 4, layer: 'B2', uid: 'private-author', content: 'private-content' })] };
  const snapshot = snapshotCatalog(raw);
  assert.deepEqual(snapshot.conflicts, ['bad']);
  assert.deepEqual(snapshot.records, [
    { id: 'same', map: 'bwiki:ys:Data:Map4', category: '2', level: null, state: true, position: { x: 1.25, y: -2.5, space: 'bwiki:lng-lat:legacy' } },
    { id: 'v4', map: 'bwiki:ys:Data:Map4', category: '9', level: 'bwiki:unreviewed-layer', state: true, position: { x: 1.25, y: -2.5, space: 'bwiki:lng-lat:v4' } },
  ]);
  assert.deepEqual(normalizeCatalog(Object.values(raw).flat()), snapshot.records);
});

test('BWIKI binds non-ground layer context without inventing a canonical floor', () => {
  const [ground] = normalizeCatalog([row('x', 2, { layer: 'G' })]);
  const [underground] = normalizeCatalog([row('x', 2, { layer: 'B1' })]);
  assert.equal(ground.level, null); assert.equal(underground.level, 'bwiki:unreviewed-layer');
  assert.deepEqual(ground.position, underground.position);
});

test('BWIKI reads only the selected existing IndexedDB in readonly mode and retains conflicting/unknown marks without metadata', async () => {
  const s = site(); const r = await execute(s);
  assert.deepEqual(r.errors, []); assert.equal(r.downloads.length, 1);
  assert.equal(r.downloads[0].name, 'genshin-bwiki-progress.json');
  const file = r.downloads[0].file;
  assert.equal(file.provider, 'bwiki'); assert.equal(file.map, 'bwiki:ys:Data:Map4');
  assert.deepEqual(file.records.map(r => [r.id, r.category, r.position?.space ?? null, r.state]), [
    ['absent', null, null, true], ['conflict', null, null, true], ['known', '2', 'bwiki:lng-lat:legacy', true], ['v4', '9', 'bwiki:lng-lat:v4', true],
  ]);
  assert.equal(file.coverage.complete, false); assert.match(file.catalog.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(file), /stale|1700000000/);
  assert.match(r.logs.join('\n'), /1.*conflict/i); assert.match(r.logs.join('\n'), /2.*unknown/i);
  assert.equal(s.stats().closes, s.stats().opens);
});

test('BWIKI uses the active fallback only, without opening IndexedDB or merging stale alternate saves', async () => {
  const s = site(false); const r = await execute(s);
  assert.deepEqual(r.errors, []); assert.equal(r.downloads.length, 1); assert.equal(s.stats().opens, 0);
  assert.equal(r.downloads[0].file.records.length, 4);
});

for (const [name, change, code] of [
  ['wrong origin', s => { s.window.location.origin = 'https://example.invalid'; }, 'wrong-site'],
  ['different map', s => { s.window.mapData.dataPrefix = 'Data:Map5'; }, 'site-version-changed'],
  ['missing shard declaration', s => { s.window.mapData.dataList.pop(); }, 'site-version-changed'],
  ['missing map instance', s => { s.window.document.querySelector = () => null; }, 'site-not-ready'],
  ['empty catalog', s => { s.window.pointsData = {}; }, 'catalog-unavailable'],
  ['invalid coordinate', s => { s.catalog[9][0].point.lng = 'NaN'; }, 'catalog-unavailable'],
  ['unsupported coordinate version', s => { s.catalog[9][0].version = 5; }, 'catalog-unavailable'],
  ['missing selected database', s => s.setExisting(false), 'save-unavailable'],
  ['database enumeration unavailable', s => { delete s.window.indexedDB.databases; }, 'save-unavailable'],
  ['pending persisted changes', s => s.setRecords([]), 'progress-changed'],
  ['false hidden state instead of timestamp', s => { s.instance.onchoose[2].known = false; }, 'invalid-progress'],
  ['unloaded fallback save', s => { s.instance.indexedDBState = false; }, 'progress-changed'],
]) test('BWIKI does not download for ' + name, async () => {
  const s = site(); change(s); const r = await execute(s);
  assert.equal(r.downloads.length, 0); assert.match(r.errors.join('\n'), new RegExp(code));
});

test('BWIKI aborts an unexpected upgrade rather than creating stores', async () => {
  const s = site(); s.setUpgrade(true); const r = await execute(s);
  assert.equal(r.downloads.length, 0); assert.equal(s.stats().abort, true); assert.match(r.errors.join('\n'), /save-unavailable/);
});

test('BWIKI detects source changes while reading and fails before download', async () => {
  for (const mutate of [s => { s.instance.onchoose[2].known++; }, s => { s.instance.indexedDBState = false; }, s => { s.catalog[9][0].point.lng = 8; }]) {
    const s = site(); s.setReadHook(() => mutate(s)); const r = await execute(s);
    assert.equal(r.downloads.length, 0); assert.match(r.errors.join('\n'), /changed/);
  }
});

test('BWIKI does not export visibility selections and accepts an empty persisted save', async () => {
  const s = site(false); s.instance.onchoose = {}; s.instance.showMarkersBox = { 2: { visible: {} } }; s.values.set('wikiMap_ys_Data:Map4_Data', '{"data":{}}');
  const r = await execute(s); assert.deepEqual(r.errors, []); assert.equal(r.downloads[0].file.records.length, 0);
});

test('BWIKI excludes a stale category row without blocking valid catalog/progress', () => {
  const snapshot = snapshotCatalog({ 2: [row('good'), row('stale-category', 9)], 9: [row('stale-category', 9)] });
  assert.deepEqual(snapshot.records.map(row => row.id), ['good']);
  assert.deepEqual(snapshot.conflicts, ['stale-category']);
});

test('BWIKI accepts padded numeric coordinate strings from live source rows without accepting blank coordinates', () => {
  assert.equal(normalizeCatalog([row('padded', 2, { point: { lng: ' -39.873476', lat: '-33.673991 ' } })])[0].position.x, -39.873476);
  assert.throws(() => normalizeCatalog([row('blank', 2, { point: { lng: ' ', lat: 0 } })]), /catalog-unavailable/);
});
