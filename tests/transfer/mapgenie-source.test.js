'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/mapgenie/catalog.json');

// Public catalog fixture from 2026-10-24. It contains no private progress.
// The reader deliberately has no fabricated authenticated response fixture.
const loadNormalizer = () => require('../../src/transfer/providers/mapgenie/normalize');
const loadReader = () => require('../../src/transfer/providers/mapgenie/reader');

test('MapGenie catalog preserves public location identity and longitude/latitude axes', () => {
  const { normalizeCatalog } = loadNormalizer();
  assert.deepEqual(normalizeCatalog(fixture), [
    { id: '49245', map: 'mapgenie:43:121', category: '1952', level: null, state: true,
      position: { x: -0.65158133958176, y: 0.75091057748315, space: 'mapgenie:lng-lat' } },
    { id: '49391', map: 'mapgenie:43:121', category: '1952', level: null, state: true,
      position: { x: -0.62175382247244, y: 0.71597365167218, space: 'mapgenie:lng-lat' } },
    { id: '49392', map: 'mapgenie:43:121', category: '1952', level: null, state: true,
      position: { x: -0.64072100012920, y: 0.73007436933921, space: 'mapgenie:lng-lat' } },
  ]);
  assert.equal(typeof fixture[0].longitude, 'string');
});

test('MapGenie catalog rejects wrong map, duplicate IDs and malformed native fields', () => {
  const { normalizeCatalog } = loadNormalizer();
  const row = fixture[0];
  for (const input of [null, {}, [], Array(1), [row, { ...row }], [{ ...row, map_id: 120 }],
    [{ ...row, id: 0 }], [{ ...row, id: '049245' }], [{ ...row, id: 1.5 }],
    [{ ...row, category_id: null }], [{ ...row, latitude: '' }],
    [{ ...row, longitude: ' 0.1' }], [{ ...row, latitude: 'Infinity' }],
    [{ ...row, latitude: null }], [{ ...row, longitude: 0.1 }],
    [{ ...row, longitude: '1000000000001' }]]) {
    assert.throws(() => normalizeCatalog(input), { code: 'catalog-unavailable' });
  }
});

test('MapGenie catalog accepts canonical numeric identity strings and zero coordinates', () => {
  const { normalizeCatalog } = loadNormalizer();
  const [row] = normalizeCatalog([{ ...fixture[0], id: '49245', category_id: '1952', longitude: '-0', latitude: '0' }]);
  assert.equal(row.id, '49245');
  assert.equal(row.category, '1952');
  assert.equal(Object.is(row.position.x, -0), false);
  assert.equal(row.position.y, 0);
});

test('MapGenie reader stops before account/storage/network/download access without verified source contract', async () => {
  const { runSourceExport } = loadReader();
  const messages = [];
  const forbidden = () => { throw new Error('unverified source IO attempted'); };
  const window = {
    location: { origin: 'https://mapgenie.io', pathname: '/genshin-impact/maps/teyvat' },
    get store() { return forbidden(); }, get localStorage() { return forbidden(); },
    get document() { return forbidden(); },
  };
  await runSourceExport({ window, fetch: forbidden, download: forbidden,
    console: { log: forbidden, warn: forbidden, error: message => messages.push(message) } });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /source-verification-required/);
  assert.match(messages[0], /No file was exported/);
});

test('MapGenie reader rejects unrelated sites without reading their state', async () => {
  const { exportMapGenie } = loadReader();
  await assert.rejects(exportMapGenie({ location: { origin: 'https://example.com', pathname: '/genshin-impact/maps/teyvat' } }), { code: 'wrong-site' });
  await assert.rejects(exportMapGenie({ location: { origin: 'https://mapgenie.io', pathname: '/other-game/maps/world' } }), { code: 'wrong-site' });
});
