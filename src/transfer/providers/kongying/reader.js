'use strict';
const { TRANSFER_LIMITS, serializeTransfer } = require('../../envelope');
const { buildSourceTransfer } = require('../../browser/source');
const { normalizeCatalog, catalogScope, markerId } = require('./normalize');
const ORIGIN = 'https://v3.yuanshen.site';
const INDEX = '/assets/index.6b600c49.js';
const PAGE = '/assets/IndexPage.11f8966b.js';
const GENERATION = 'index.6b600c49:IndexPage.11f8966b';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function checkPage(window) {
  if (window.location?.origin !== ORIGIN || window.location.pathname !== '/') fail('wrong-site');
  const sameAsset = (source, pathname) => { try { const url = new URL(source, window.location.href); return url.origin === ORIGIN && url.pathname === pathname; } catch { return false; } };
  if (!Array.from(window.document.scripts).some(script => sameAsset(script.src, INDEX))) fail('site-version-changed');
  if (!window.document.querySelector('#map') || !window.performance?.getEntriesByType?.('resource')?.some(entry => sameAsset(entry.name, PAGE))) fail('site-not-ready');
}
function visitor(window) {
  let cookies;
  try { cookies = window.document.cookie; } catch { fail('visitor-required'); }
  const matches = cookies.split(';').map(value => value.trim()).filter(value => value.startsWith('_yuanshen_map_usertoken='));
  if (matches.length !== 1) fail('visitor-required');
  let token; try { token = decodeURIComponent(matches[0].slice('_yuanshen_map_usertoken='.length)); } catch { fail('visitor-required'); }
  if (!token || token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(token)) fail('visitor-required');
  return token;
}
function progress(window) {
  const keys = ['marked_layers', 'marked_timelayers', '_yuanshenmap_saveid', '_yuanshenmap_save_time'];
  let raw;
  try { raw = keys.map(key => window.localStorage.getItem(key)); } catch { fail('local-progress-unavailable'); }
  if (raw[0] === null || raw[1] === null) fail('site-not-ready');
  if (raw.some(value => value !== null && (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > TRANSFER_LIMITS.BYTES))) fail('invalid-progress');
  let ids, timed;
  try { ids = JSON.parse(raw[0]); timed = JSON.parse(raw[1]); } catch { fail('invalid-progress'); }
  if (!Array.isArray(ids) || ids.length > TRANSFER_LIMITS.RECORDS || !timed || typeof timed !== 'object' || Array.isArray(timed) || Object.keys(timed).length > TRANSFER_LIMITS.RECORDS) fail('invalid-progress');
  try { ids = ids.map(markerId); } catch { fail('invalid-progress'); }
  return { raw: JSON.stringify(raw), ids: [...new Set(ids)], timed: Object.keys(timed).length };
}
async function readJSON(fetch, url, options) {
  let response, text, value;
  try { response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...options }); } catch { fail('catalog-read-failed'); }
  if (!response?.ok || response.status !== 200) fail('catalog-read-failed');
  try {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > TRANSFER_LIMITS.BYTES) fail('catalog-too-large');
    value = JSON.parse(text);
  } catch (error) { if (error?.code === 'catalog-too-large') throw error; fail('catalog-unavailable'); }
  return value;
}
async function exportKongying(window, fetch) {
  checkPage(window);
  const token = visitor(window), saved = progress(window), href = window.location.href;
  function assertCurrent() {
    try {
      checkPage(window);
      if (window.location.href !== href || visitor(window) !== token || progress(window).raw !== saved.raw) fail('context-changed');
    } catch { fail('context-changed'); }
  }
  const config = await readJSON(fetch, 'https://assets.yuanshen.site/webapp.json', { method: 'GET' });
  assertCurrent();
  // Exact first-party visitor cookie -> fixed catalog routes, as in
  // base_request.js. The token never enters output, logs or another service.
  async function query(path, body) {
    assertCurrent();
    const value = await readJSON(fetch, 'https://cloud.yuanshen.site/api' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
    });
    assertCurrent();
    if (value?.errorStatus !== 200 || !Array.isArray(value.data) || value.data.length > TRANSFER_LIMITS.RECORDS) fail('catalog-unavailable');
    return value.data;
  }
  const areas = await query('/area/get/list', { isTraverse: true, parentId: -1 });
  const scope = catalogScope(config, areas);
  const body = areaIdList => ({ typeIdList: [], areaIdList, itemIdList: [], getBeta: 0 });
  const markers = await query('/marker/get/list_byinfo', body(scope.teyvat));
  const catalog = normalizeCatalog({ config, areas, areaIds: scope.teyvat, markers });
  const known = new Set(catalog.map(row => row.id));
  const foreign = scope.other.length ? await query('/marker/get/list_byinfo', body(scope.other)) : [];
  const other = new Set();
  for (const row of foreign) {
    const id = markerId(row?.id);
    if (known.has(id)) fail('catalog-map-conflict');
    other.add(id);
  }
  // marked_layers spans all maps. A missing ID cannot safely be assigned to
  // Teyvat; exclude and report it instead of manufacturing map metadata.
  const foundIds = saved.ids.filter(id => known.has(id));
  const otherMaps = saved.ids.filter(id => other.has(id)).length;
  const unknown = saved.ids.length - foundIds.length - otherMaps;
  const result = await buildSourceTransfer({ provider: 'kongying', map: 'kongying:v3:teyvat', generation: GENERATION, catalog, foundIds });
  assertCurrent();
  return { ...result, summary: { ...result.summary, unknown, otherMaps, timed: saved.timed }, assertCurrent };
}
const ERRORS = Object.freeze({
  'wrong-site': 'Open https://v3.yuanshen.site/ and run this script there.',
  'site-version-changed': 'Kongying has changed. Use an updated overlay source script.',
  'site-not-ready': 'Wait for the Kongying map and browser-local save to finish loading, then retry.',
  'visitor-required': 'Kongying visitor access is not ready. Reload the map normally, wait for it to load, then retry.',
  'local-progress-unavailable': 'The browser did not allow reading Kongying local progress. No file was exported.',
  'invalid-progress': 'Kongying browser-local progress has an unexpected format. No file was exported.',
  'context-changed': 'The Kongying page, visitor session or local save changed during export. Run the script again.',
  'catalog-read-failed': 'Could not read the Kongying public catalog in this visitor session. Reload the map and retry.',
  'catalog-unavailable': 'Kongying returned an incomplete or unexpected catalog format. No file was exported.',
  'catalog-too-large': 'The Kongying catalog exceeds the safe transfer size. Use an updated overlay source script.',
  'catalog-map-conflict': 'Kongying returned conflicting marker map identities. No file was exported.',
});
async function runSourceExport({ window, fetch, download, console }) {
  try {
    const result = await exportKongying(window, fetch);
    const bytes = serializeTransfer(result.envelope);
    result.assertCurrent();
    await download('genshin-kongying-progress.json', bytes);
    const { found, timed, otherMaps, unknown } = result.summary;
    console.log('Kongying export: download requested for ' + found + ' permanent found Teyvat markers. ' + timed + ' timed respawn entries, ' + otherMaps + ' found markers on other maps and ' + unknown + ' unknown marker IDs were excluded.');
    console.log('This file contains the currently loaded browser-local save. To export a Gitee save, first load that save normally in Kongying. In the overlay, open Profiles & transfers, select Kongying and choose genshin-kongying-progress.json.');
    return true;
  } catch (error) {
    console.error('Kongying export stopped: ' + (ERRORS[error?.code] || 'No file was exported. Reload the map and use an updated overlay source script.'));
    return false;
  }
}
module.exports = { runSourceExport, exportKongying };
