'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransfer } = require('../../src/transfer/envelope');

// Synthetic progress and small, hand-authored public-response-shaped catalog.
const native = () => ({
  config: { tiles: { '提瓦特-base0': { code: 'twt672' }, 'A:MD:MENGDE': { extend: '提瓦特-base0' }, 'A:DQ:YUANXIAGONG': { code: 'yxg' } } },
  areas: [{ id: 5, parentId: -1, code: 'C:MD', isFinal: false }, { id: 6, parentId: 5, code: 'A:MD:MENGDE', isFinal: true }, { id: 21, parentId: 5, code: 'A:DQ:YUANXIAGONG', isFinal: true }],
  areaIds: [6],
  markers: [{ id: 42, position: '2641.5,-2977', itemList: [{ itemId: 78, count: 1, iconId: 76 }], extra: '{"underground":{"is_underground":true}}' },
    { id: 43, position: '-0,4', itemList: [{ itemId: 9, count: 0 }, { itemId: 3, count: 1 }] }],
});
const normalizer = () => require('../../src/transfer/providers/kongying/normalize');
const reader = () => require('../../src/transfer/providers/kongying/reader');

test('Kongying normalizer keeps native coordinates, compound categories and no inferred floor', () => {
  assert.deepEqual(normalizer().normalizeCatalog(native()), [
    { id: '42', map: 'kongying:v3:teyvat', category: '78', level: null, state: true, position: { x: -2977, y: 2641.5, space: 'kongying:leaflet-lng-lat' } },
    { id: '43', map: 'kongying:v3:teyvat', category: '3+9', level: null, state: true, position: { x: 4, y: 0, space: 'kongying:leaflet-lng-lat' } },
  ]);
});

test('Kongying refuses foreign-map scope, malformed coordinates and conflicting duplicate IDs', () => {
  for (const mutate of [x => { x.areaIds = [21]; }, x => { x.markers[0].position = '1,2,3'; }, x => { x.markers[0].position = ',2'; }, x => { x.markers.push({ ...x.markers[0], position: '1,2' }); }, x => { x.markers[0].itemList = []; }, x => { x.config.tiles['A:MD:MENGDE'].extend = 'missing'; }]) {
    const value = native(); mutate(value);
    assert.throws(() => normalizer().normalizeCatalog(value), { code: 'catalog-unavailable' });
  }
});

test('Kongying deduplicates repeated item associations observed in the public catalog', () => {
  const value = native(); value.markers[0].itemList.push({ itemId: 78, count: 1, iconId: 76 });
  assert.equal(normalizer().normalizeCatalog(value)[0].category, '78');
});

function site() {
  const values = new Map([['marked_layers', '[42,43,70,99,42]'], ['marked_timelayers', '{"500":1234}'], ['_yuanshenmap_saveid', 'synthetic-save'], ['_yuanshenmap_save_time', '123']]);
  const source = native();
  const calls = [], downloads = [], logs = [], errors = [];
  let cookie = '_yuanshen_map_usertoken=synthetic-visitor';
  let beforeResponse = () => {};
  const window = {
    location: { origin: 'https://v3.yuanshen.site', pathname: '/', href: 'https://v3.yuanshen.site/' },
    document: { scripts: [{ src: 'https://v3.yuanshen.site/assets/index.6b600c49.js' }], querySelector: selector => selector === '#map' ? {} : null, get cookie() { return cookie; } },
    performance: { getEntriesByType: () => [{ name: 'https://v3.yuanshen.site/assets/IndexPage.11f8966b.js' }] },
    localStorage: { getItem: key => values.get(key) ?? null, setItem() { throw new Error('source must not write'); } },
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    let value;
    if (url === 'https://assets.yuanshen.site/webapp.json') {
      assert.equal(options.method, 'GET'); assert.equal(options.headers?.Authorization, undefined); value = source.config;
    } else {
      assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer synthetic-visitor');
      assert.equal(options.redirect, 'error');
      const data = JSON.parse(options.body);
      if (url === 'https://cloud.yuanshen.site/api/area/get/list') {
        assert.deepEqual(data, { isTraverse: true, parentId: -1 }); value = { errorStatus: 200, data: source.areas };
      } else if (url === 'https://cloud.yuanshen.site/api/marker/get/list_byinfo') {
        assert.deepEqual(data.typeIdList, []); assert.deepEqual(data.itemIdList, []); assert.equal(data.getBeta, 0);
        if (JSON.stringify(data.areaIdList) === '[6]') value = { errorStatus: 200, data: source.markers };
        else if (JSON.stringify(data.areaIdList) === '[21]') value = { errorStatus: 200, data: [{ id: 70 }] };
        else assert.fail('unexpected map scope');
      } else assert.fail('unexpected route');
    }
    await beforeResponse(url, value);
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { window, fetch, source, values, calls, downloads, logs, errors, setCookie: value => { cookie = value; }, setBeforeResponse: value => { beforeResponse = value; },
    download: async (name, bytes) => downloads.push({ name, bytes }), console: { log: value => logs.push(value), error: value => errors.push(value) } };
}

test('Kongying exports browser-local permanent progress, excludes timed/other-map/unknown IDs and keeps credentials private', async () => {
  const s = site(); const before = [...s.values];
  assert.equal(await reader().runSourceExport(s), true);
  assert.equal(s.downloads.length, 1); assert.equal(s.downloads[0].name, 'genshin-kongying-progress.json');
  const envelope = parseTransfer(s.downloads[0].bytes);
  assert.equal(envelope.provider, 'kongying'); assert.equal(envelope.map, 'kongying:v3:teyvat');
  assert.deepEqual(envelope.records.map(row => row.id), ['42', '43']);
  assert.equal(envelope.coverage.complete, false);
  assert.equal(s.calls.length, 4); assert.deepEqual([...s.values], before);
  const output = JSON.stringify([envelope, s.logs, s.errors]);
  assert.ok(!output.includes('synthetic-visitor')); assert.ok(!output.includes('synthetic-save'));
  assert.match(s.logs.join(' '), /1.*timed/i); assert.match(s.logs.join(' '), /1.*other maps/i); assert.match(s.logs.join(' '), /1.*unknown/i);
});

test('Kongying rejects wrong deployment, missing visitor session and malformed local save before network reads', async () => {
  for (const mutate of [s => { s.window.location.origin = 'https://example.org'; }, s => { s.window.document.scripts[0].src = 'https://v3.yuanshen.site/assets/index.new.js'; }, s => { s.setCookie(''); }, s => { s.values.set('marked_layers', '{"42":true}'); }, s => { s.values.set('marked_layers', '["42"]'); }, s => { s.values.set('marked_timelayers', '[]'); }]) {
    const s = site(); mutate(s); assert.equal(await reader().runSourceExport(s), false); assert.equal(s.calls.length, 0); assert.equal(s.downloads.length, 0); assert.equal(s.errors.length, 1);
  }
});

test('Kongying aborts if progress, save identity or visitor context changes while catalog is read', async () => {
  for (const mutate of [s => s.values.set('marked_layers', '[43]'), s => s.values.set('_yuanshenmap_saveid', 'other'), s => s.values.set('marked_timelayers', '{}'), s => s.setCookie('_yuanshen_map_usertoken=other')]) {
    const s = site(); s.setBeforeResponse(() => { mutate(s); });
    assert.equal(await reader().runSourceExport(s), false); assert.equal(s.downloads.length, 0); assert.match(s.errors[0], /changed/i);
  }
});

test('Kongying does not turn failed, paginated or partial catalogs into empty progress', async () => {
  for (const mutate of [(_url, value) => { if (value.errorStatus) value.errorStatus = 500; }, (_url, value) => { if (value.data && Array.isArray(value.data) && value.data[0]?.position) value.data = { record: value.data }; }, (_url, value) => { if (value.data && Array.isArray(value.data) && value.data[0]?.position) value.data = []; }]) {
    const s = site(); s.setBeforeResponse(mutate);
    assert.equal(await reader().runSourceExport(s), false); assert.equal(s.downloads.length, 0);
  }
  const s = site(); s.fetch = async () => { throw new Error('private diagnostic must not leak'); };
  assert.equal(await reader().runSourceExport(s), false); assert.equal(s.downloads.length, 0); assert.ok(!s.errors.join().includes('private diagnostic'));
});
