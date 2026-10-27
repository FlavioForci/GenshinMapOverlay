'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ROWS = [{ id: 42, label_id: 5, x_pos: 10, y_pos: 20, z_level: 0, point_group: null, author_name: 'private-source-author' }];
function site() {
  const vm = { $isSea: true, $route: { params: { mapId: '2' } }, $store: { state: { userInfo: { uid: 'synthetic-account', loginStatus: 1 } } } };
  const window = { location: { origin: 'https://act.hoyolab.com', pathname: '/ys/app/interactive-map/index.html' }, document: {
    getElementById: () => ({ __vue__: vm }), scripts: [{ src: 'https://act.hoyolab.com/ys/app/interactive-map/bundle_cecaae550a4003092d80.js' }],
  } };
  const replies = [{ retcode: 0, data: { list: [{ id: 999, point_id: 42, label_id: 5 }, { id: 1000, point_id: 43, label_id: 6 }] } }, { retcode: 0, data: { point_list: ROWS } }];
  let mutate = () => {};
  const fetch = async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    if (url.includes('mark_map_point_list')) assert.equal(options.credentials, 'include'); else assert.equal(options.credentials, 'omit');
    assert.match(url, /^https:\/\/sg-public-api(?:-static)?\.hoyolab\.com\/common\/map_user\/ys_obc\//);
    mutate(); const body = replies.shift(); return { ok: true, text: async () => JSON.stringify(body) };
  };
  return { window, vm, fetch, replies, mutate: fn => { mutate = fn; } };
}
test('HoYoLAB source reads point_id, retains unknown IDs and emits no user/author/mark-record identity', async () => {
  const { exportHoYoLab } = require('../../src/transfer/providers/hoyolab/reader');
  const f = site(); const result = await exportHoYoLab(f);
  assert.deepEqual(result.envelope.records.map(row => [row.id, row.category]), [['42', '5'], ['43', null]]);
  assert.deepEqual(result.summary, { found: 2, unknown: 1 });
  assert.doesNotMatch(JSON.stringify(result.envelope), /synthetic-account|private-source-author|999|1000/);
});
test('HoYoLAB source stops after account/map changes and API authentication errors', async () => {
  const { exportHoYoLab } = require('../../src/transfer/providers/hoyolab/reader');
  for (const [change, code] of [
    [f => { f.vm.$store.state.userInfo.uid = ''; }, 'sign-in-required'],
    [f => { f.vm.$route.params.mapId = '7'; }, 'wrong-map'],
    [f => { f.replies[0] = { retcode: -100, message: 'secret-server-text' }; }, 'source-read-failed'],
    [f => f.mutate(() => { f.vm.$store.state.userInfo.uid = 'other'; }), 'context-changed'],
    [f => { f.replies[0].data.list = [{ id: 999, label_id: 5 }]; }, 'invalid-progress'],
    [f => { f.replies[0].data.has_more = true; }, 'incomplete-progress'],
  ]) {
    const f = site(); change(f); await assert.rejects(exportHoYoLab(f), { code });
  }
});
test('HoYoLAB catalog normalization validates all rows and does not treat raw altitude as a floor', () => {
  const { normalizeCatalog } = require('../../src/transfer/providers/hoyolab/normalize');
  const records = normalizeCatalog(ROWS);
  assert.deepEqual(records, [{ id: '42', map: 'hoyolab:ys_obc:2', category: '5', level: null, state: true, position: { x: 10, y: 20, space: 'hoyolab:x_pos-y_pos' } }]);
  for (const rows of [[...ROWS, { ...ROWS[0] }], [{ ...ROWS[0], x_pos: Infinity }], [{ ...ROWS[0], id: 0 }]]) assert.throws(() => normalizeCatalog(rows));
});

test('HoYoLAB marks unverified layer context so a formerly ungrouped row cannot reuse a surface pair', () => {
  const { normalizeCatalog } = require('../../src/transfer/providers/hoyolab/normalize');
  for (const patch of [{ z_level: 1 }, { point_group: { id: 5 } }, { z_level: undefined }, { point_group: undefined }]) {
    const [record] = normalizeCatalog([{ ...ROWS[0], ...patch }]);
    assert.equal(record.level, 'hoyolab:unreviewed-layer');
  }
});
