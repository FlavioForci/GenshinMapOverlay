'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { parseTransfer } = require('../../src/transfer/envelope');
const { makeDocument } = require('./helpers');
const ROOT = path.resolve(__dirname, '../..');

// These are synthetic source-shaped page/session contracts, not live-browser
// acceptance. Execute the actual generated DevTools files, including their
// dependency table, fetch plumbing and browser download entry point.
function persistence(values = new Map()) {
  const reads = [], writes = [];
  const reject = operation => { writes.push(operation); throw Error('source persistence must stay read-only'); };
  return { values, reads, writes, storage: {
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem() { reject('setItem'); }, removeItem() { reject('removeItem'); }, clear() { reject('clear'); },
  }, reject };
}
function baseWindow(origin, pathname = '/') {
  return { location: { origin, pathname, href: origin + pathname }, document: makeDocument() };
}
async function execute(provider, site, direction = 'export') {
  const files = [], downloads = [], blobs = new Map(), errors = [], logs = [], revoked = [];
  const document = site.window.document;
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'a') node.click = () => downloads.push({ name: node.download, blob: blobs.get(node.href) });
    return node;
  };
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = 'blob:synthetic-' + blobs.size; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = { window: site.window, document, fetch: site.fetch, crypto: globalThis.crypto,
    Blob, TextEncoder, TextDecoder, Uint8Array, AbortSignal, URL: BrowserURL,
    console: { error: value => errors.push(String(value)), log: value => logs.push(String(value)), warn: value => logs.push(String(value)) },
    setTimeout(callback, ms) { if (ms === 1000) { callback(); return 0; } return setTimeout(callback, ms); }, clearTimeout,
  };
  const code = await fs.readFile(path.join(ROOT, 'src/transfer/scripts', provider + '-' + direction + '.js'), 'utf8');
  await vm.runInNewContext(code, context, { timeout: 1000 });
  for (const item of downloads) {
    assert.ok(item.blob instanceof Blob); assert.equal(item.blob.type, 'application/json');
    files.push({ name: item.name, bytes: new Uint8Array(await item.blob.arrayBuffer()) });
  }
  assert.equal(document.body.children.length, 0, 'temporary download anchor must be removed');
  assert.equal(revoked.length, downloads.length, 'download object URLs must be revoked');
  return { files, errors, logs };
}
function exported(result, provider, map) {
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'genshin-' + provider + '-progress.json');
  const file = parseTransfer(result.files[0].bytes);
  assert.equal(file.provider, provider); assert.equal(file.map, map);
  assert.equal(file.coverage.complete, false); assert.match(file.catalog.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(file.records.every(row => row.state === true), 'absence must never create a not-found record');
  const output = new TextDecoder().decode(result.files[0].bytes) + JSON.stringify([result.logs, result.errors]);
  assert.doesNotMatch(output, /synthetic-account|synthetic-visitor|synthetic-save|private-author|private-content|private-token|rawDocuments|author_name|Authorization|loginStatus|1700000000/);
  return file;
}
function hoyolabSite() {
  const window = baseWindow('https://act.hoyolab.com', '/ys/app/interactive-map/index.html');
  const state = { $isSea: true, $route: { params: { mapId: '2' } }, $store: { state: { userInfo: { uid: 'synthetic-account', loginStatus: 1 } } } };
  window.document.scripts = [{ src: 'https://act.hoyolab.com/ys/app/interactive-map/bundle_cecaae550a4003092d80.js' }];
  window.document.getElementById = id => id === 'root' ? { __vue__: state } : null;
  const storage = persistence(); window.localStorage = storage.storage;
  const calls = [], replies = [
    { retcode: 0, data: { list: [{ id: 90001, point_id: 42, label_id: 5 }, { id: 90002, point_id: 43, label_id: 6 }], rawDocuments: 'private-content' } },
    { retcode: 0, data: { point_list: [{ id: 42, label_id: 5, x_pos: 10, y_pos: 20, z_level: 0, point_group: null, author_name: 'private-author', token: 'private-token' }] } },
  ];
  const fetch = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    const expected = calls.length === 1
      ? 'https://sg-public-api.hoyolab.com/common/map_user/ys_obc/v1/map/point/mark_map_point_list?map_id=2&app_sn=ys_obc&lang=en-us'
      : 'https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v3/map/point/list?map_id=2&app_sn=ys_obc&lang=en-us';
    assert.equal(url, expected); assert.equal(options.credentials, calls.length === 1 ? 'include' : 'omit');
    return { ok: true, text: async () => JSON.stringify(replies.shift()) };
  };
  return { window, state, storage, calls, replies, fetch };
}
function kongyingSite() {
  const window = baseWindow('https://v3.yuanshen.site');
  window.document.scripts = [{ src: 'https://v3.yuanshen.site/assets/index.6b600c49.js' }];
  window.document.querySelector = selector => selector === '#map' ? {} : null;
  window.performance = { getEntriesByType: type => type === 'resource' ? [{ name: 'https://v3.yuanshen.site/assets/IndexPage.11f8966b.js' }] : [] };
  const storage = persistence(new Map([['marked_layers', '[42,43,70,99,42]'], ['marked_timelayers', '{"500":1700000000000}'], ['_yuanshenmap_saveid', 'synthetic-save'], ['_yuanshenmap_save_time', '1700000000000']]));
  window.localStorage = storage.storage;
  let cookie = '_yuanshen_map_usertoken=synthetic-visitor';
  Object.defineProperty(window.document, 'cookie', { get: () => cookie, set: () => storage.reject('cookie') });
  const config = { tiles: { '提瓦特-base0': { code: 'twt672' }, 'A:MD:MENGDE': { extend: '提瓦特-base0' }, 'A:DQ:YUANXIAGONG': { code: 'yxg' } } };
  const areas = [{ id: 5, parentId: -1, code: 'C:MD', isFinal: false }, { id: 6, parentId: 5, code: 'A:MD:MENGDE', isFinal: true }, { id: 21, parentId: 5, code: 'A:DQ:YUANXIAGONG', isFinal: true }];
  const markers = [{ id: 42, position: '2641.5,-2977', itemList: [{ itemId: 78, count: 1, iconId: 76 }], author_name: 'private-author', content: 'private-content' }, { id: 43, position: '-0,4', itemList: [{ itemId: 9, count: 0 }, { itemId: 3, count: 1 }] }];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    let value;
    if (url === 'https://assets.yuanshen.site/webapp.json') {
      assert.equal(options.method, 'GET'); assert.equal(options.headers?.Authorization, undefined); value = config;
    } else {
      // These fixed POST routes only query catalogs; no save/update endpoint is allowed.
      assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer synthetic-visitor');
      const body = JSON.parse(options.body);
      if (url === 'https://cloud.yuanshen.site/api/area/get/list') {
        assert.deepEqual(body, { isTraverse: true, parentId: -1 }); value = { errorStatus: 200, data: areas };
      } else {
        assert.equal(url, 'https://cloud.yuanshen.site/api/marker/get/list_byinfo');
        assert.deepEqual(body, { typeIdList: [], areaIdList: calls.length === 3 ? [6] : [21], itemIdList: [], getBeta: 0 });
        value = { errorStatus: 200, data: calls.length === 3 ? markers : [{ id: 70 }] };
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { window, storage, calls, fetch, changeVisitor: () => { cookie = '_yuanshen_map_usertoken=other'; } };
}
function bwikiSite(useIDB = true) {
  const window = baseWindow('https://wiki.biligame.com', '/ys/大地图');
  const chosen = { 2: { known: 1700000000000, conflict: 1700000000001, absent: 1700000000002 }, 9: { v4: 1700000000003 } };
  const values = new Map([['wikiMap_ys_Data:Map4_Data', JSON.stringify({ data: useIDB ? { 2: { stale: 1700000000000 } } : chosen })]]);
  const storage = persistence(values); window.localStorage = storage.storage;
  const instance = { indexedDBState: useIDB, storageName: { data: 'wikiMap_ys_Data:Map4_Data' }, onchoose: chosen, daDian: { show: false }, showMarkersBox: { 2: { visibleButNotFound: {} } } };
  const row = (id, extra = {}) => ({ id, markType: 2, point: { lng: '1.25', lat: '-2.5' }, uid: 'private-author', content: 'private-content', ...extra });
  window.mw = { config: { get: key => ({ wgGameName: 'ys', wgRevisionId: 690410 })[key] } };
  window.mapData = { dataPrefix: 'Data:Map4', dataList: ['point.json', 'point2.json', 'point3.json', 'point4.json', 'point5.json', 'point6.json'] };
  window.mapPackage = { wikiData: { _wgGameName: 'ys' } };
  window.pointsData = { 2: [row('known'), row('conflict'), row('conflict', { point: { lng: 99, lat: 5 } })], 9: [row('v4', { markType: 9, version: 4, layer: 'B1' })] };
  window.document.querySelector = selector => selector === '#app' ? { _vnode: { component: { proxy: instance } } } : null;
  const transactions = []; let opens = 0, closes = 0;
  let persisted = Object.entries(chosen).flatMap(([type, ids]) => Object.entries(ids).map(([id, time]) => ({ id, type, time })));
  window.indexedDB = {
    databases: async () => [{ name: 'wikiYSMap4Data', version: 1 }],
    open(name, version) {
      assert.equal(name, 'wikiYSMap4Data'); assert.equal(version, undefined); opens++;
      const request = {};
      queueMicrotask(() => {
        request.result = { version: 1, objectStoreNames: { contains: name => name === 'pointsOnchoose' }, close() { closes++; },
          transaction(names, mode) {
            assert.deepEqual(Array.from(names), ['pointsOnchoose']); assert.equal(mode, 'readonly'); transactions.push(mode);
            const transaction = { objectStore(name) {
              assert.equal(name, 'pointsOnchoose');
              return { keyPath: 'id', put: () => storage.reject('put'), add: () => storage.reject('add'), delete: () => storage.reject('delete'), clear: () => storage.reject('clearStore'),
                getAll() {
                  const read = {};
                  queueMicrotask(() => { read.result = persisted.map(row => ({ ...row })); read.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
                  return read;
                },
              };
            } };
            return transaction;
          },
          createObjectStore: () => storage.reject('createObjectStore'), deleteObjectStore: () => storage.reject('deleteObjectStore'),
        };
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase: () => storage.reject('deleteDatabase'),
  };
  const calls = [];
  return { window, storage, instance, transactions, stats: () => ({ opens, closes }), setPersisted: value => { persisted = value; }, calls,
    fetch: (...args) => { calls.push(args); throw Error('BWIKI must use the loaded catalog and active persistence only'); } };
}

test('generated HoYoLAB source reads signed-in marks with cookie GET, strips identities and retains unknown point IDs', async () => {
  const site = hoyolabSite(); const before = JSON.stringify(site.state);
  const file = exported(await execute('hoyolab', site), 'hoyolab', 'hoyolab:ys_obc:2');
  assert.deepEqual(file.records.map(row => [row.id, row.category]), [['42', '5'], ['43', null]]);
  assert.deepEqual(file.records[0].position, { x: 10, y: 20, space: 'hoyolab:x_pos-y_pos' });
  assert.equal(site.calls.length, 2); assert.deepEqual(site.storage.writes, []); assert.deepEqual(site.storage.reads, []);
  assert.equal(JSON.stringify(site.state), before);
});

test('generated HoYoLAB source refuses signed-out and incomplete progress without falling back to local state', async () => {
  for (const signedOut of [true, false]) {
    const site = hoyolabSite();
    if (signedOut) site.state.$store.state.userInfo.loginStatus = 0;
    else site.replies[0].data.has_more = true;
    const result = await execute('hoyolab', site);
    assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), signedOut ? /sign-in-required/ : /incomplete-progress/);
    assert.equal(site.calls.length, signedOut ? 0 : 1); assert.deepEqual(site.storage.writes, []);
  }
});

test('generated Kongying source exports only the current browser-local permanent Teyvat save using read-only catalog routes', async () => {
  const site = kongyingSite(); const before = [...site.storage.values];
  const result = await execute('kongying', site); const file = exported(result, 'kongying', 'kongying:v3:teyvat');
  assert.deepEqual(file.records.map(row => [row.id, row.category]), [['42', '78'], ['43', '3+9']]);
  assert.deepEqual(file.records[0].position, { x: -2977, y: 2641.5, space: 'kongying:leaflet-lng-lat' });
  assert.equal(site.calls.length, 4); assert.deepEqual([...site.storage.values], before); assert.deepEqual(site.storage.writes, []);
  assert.match(result.logs.join('\n'), /1 timed.*1 found markers on other maps.*1 unknown/);
  assert.match(result.logs.join('\n'), /currently loaded browser-local save/);
});

test('generated Kongying source aborts if its visitor session changes during a catalog query', async () => {
  const site = kongyingSite(); const read = site.fetch;
  site.fetch = async (...args) => { const reply = await read(...args); site.changeVisitor(); return reply; };
  const result = await execute('kongying', site);
  assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), /changed/); assert.equal(site.calls.length, 1);
  assert.deepEqual(site.storage.writes, []);
});

for (const useIDB of [true, false]) test('generated BWIKI source uses only active ' + (useIDB ? 'readonly IndexedDB' : 'local fallback') + ' and strips private catalog content', async () => {
  const site = bwikiSite(useIDB); const before = [...site.storage.values];
  const result = await execute('bwiki', site); const file = exported(result, 'bwiki', 'bwiki:ys:Data:Map4');
  assert.deepEqual(file.records.map(row => [row.id, row.category, row.position?.space ?? null]), [
    ['absent', null, null], ['conflict', null, null], ['known', '2', 'bwiki:lng-lat:legacy'], ['v4', '9', 'bwiki:lng-lat:v4'],
  ]);
  assert.doesNotMatch(JSON.stringify(file), /stale|visibleButNotFound/);
  assert.deepEqual(site.calls, []); assert.deepEqual(site.storage.writes, []); assert.deepEqual([...site.storage.values], before);
  assert.deepEqual(site.transactions, useIDB ? ['readonly', 'readonly'] : []);
  assert.deepEqual(site.stats(), useIDB ? { opens: 2, closes: 2 } : { opens: 0, closes: 0 });
  if (useIDB) assert.deepEqual(site.storage.reads, [], 'a stale alternate local save must not be read or merged');
  else assert.deepEqual(site.storage.reads, ['wikiMap_ys_Data:Map4_Data', 'wikiMap_ys_Data:Map4_Data']);
  assert.match(result.logs.join('\n'), /1 conflicting/);
});

test('generated BWIKI source refuses unsaved in-memory progress instead of merging a stale persisted save', async () => {
  const site = bwikiSite(); site.setPersisted([]);
  const result = await execute('bwiki', site);
  assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), /progress-changed/);
  assert.deepEqual(site.storage.writes, []); assert.deepEqual(site.calls, []); assert.deepEqual(site.stats(), { opens: 1, closes: 1 });
});

for (const [provider, createSite] of [['hoyolab', hoyolabSite], ['kongying', kongyingSite], ['bwiki', bwikiSite]]) {
  test('generated ' + provider + ' destination import remains unavailable and performs no source or destination reads/writes', async () => {
    const site = createSite(); const result = await execute(provider, site, 'import');
    assert.equal(result.files.length, 0); assert.equal(result.errors.length, 1); assert.match(result.errors[0], new RegExp(provider + ' import unavailable'));
    assert.deepEqual(site.calls, []); assert.deepEqual(site.storage.reads, []); assert.deepEqual(site.storage.writes, []);
    if (site.stats) assert.deepEqual(site.stats(), { opens: 0, closes: 0 });
  });
}
