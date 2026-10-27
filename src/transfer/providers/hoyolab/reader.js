'use strict';
const { TRANSFER_LIMITS } = require('../../envelope');
const { buildSourceTransfer } = require('../../browser/source');
const { normalizeCatalog, normalizeProgress } = require('./normalize');
const BUNDLE = '/ys/app/interactive-map/bundle_cecaae550a4003092d80.js';
const PROGRESS = 'https://sg-public-api.hoyolab.com/common/map_user/ys_obc/v1/map/point/mark_map_point_list?map_id=2&app_sn=ys_obc&lang=en-us';
const CATALOG = 'https://sg-public-api-static.hoyolab.com/common/map_user/ys_obc/v3/map/point/list?map_id=2&app_sn=ys_obc&lang=en-us';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function context(window) {
  if (window.location?.origin !== 'https://act.hoyolab.com' || !window.location.pathname.startsWith('/ys/app/interactive-map/')) fail('wrong-site');
  if (!Array.from(window.document.scripts).some(s => { try { const u = new URL(s.src, window.location.origin); return u.origin === window.location.origin && u.pathname === BUNDLE; } catch { return false; } })) fail('site-version-changed');
  const component = window.document.getElementById('root')?.__vue__;
  const vm = component?.$root || component;
  if (!vm?.$store || vm.$isSea !== true) fail('site-not-ready');
  if (String(vm.$route?.params?.mapId) !== '2') fail('wrong-map');
  const user = vm.$store.state.userInfo;
  if (!user || user.loginStatus !== 1 || !user.uid) fail('sign-in-required');
  return { vm, uid: String(user.uid) };
}
async function readJson(fetch, url, credentials) {
  let response, text;
  try {
    response = await fetch(url, { method: 'GET', credentials, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    if (!response.ok) fail('source-read-failed');
    text = await response.text();
  } catch { fail('source-read-failed'); }
  if (new TextEncoder().encode(text).byteLength > TRANSFER_LIMITS.BYTES) fail('source-too-large');
  let result; try { result = JSON.parse(text); } catch { fail('invalid-response'); }
  if (result?.retcode !== 0 || !result.data || typeof result.data !== 'object') fail('source-read-failed');
  return result.data;
}
async function exportHoYoLab({ window, fetch }) {
  const captured = context(window);
  function assertCurrent() {
    let current; try { current = context(window); } catch { fail('context-changed'); }
    if (current.vm !== captured.vm || current.uid !== captured.uid) fail('context-changed');
  }
  const progress = await readJson(fetch, PROGRESS, 'include'); assertCurrent();
  if (progress.has_more === true || (Number.isFinite(progress.total) && progress.total > progress.list?.length)) fail('incomplete-progress');
  const foundIds = normalizeProgress(progress.list);
  const native = await readJson(fetch, CATALOG, 'omit'); assertCurrent();
  const catalog = normalizeCatalog(native.point_list);
  const result = await buildSourceTransfer({ provider: 'hoyolab', map: 'hoyolab:ys_obc:2', generation: 'bundle:cecaae550a4003092d80:map2', catalog, foundIds });
  assertCurrent(); return { ...result, assertCurrent };
}
const MESSAGES = {
  'wrong-site': 'Open the international HoYoLAB Teyvat Interactive Map and run this script there.',
  'site-version-changed': 'HoYoLAB changed its map deployment. Use an updated source script.',
  'site-not-ready': 'Wait for the international HoYoLAB map to finish loading.',
  'wrong-map': 'Select Teyvat (map 2) before exporting.',
  'sign-in-required': 'Sign in to HoYoLAB, wait for your saved marks to load, then retry.',
  'source-read-failed': 'The saved marks could not be read. Check your sign-in and connection; no local fallback was used.',
  'source-too-large': 'The source response exceeds the supported size.',
  'invalid-response': 'HoYoLAB returned an unexpected response format.',
  'invalid-progress': 'HoYoLAB returned an unexpected marker list.',
  'catalog-unavailable': 'The Teyvat marker catalog is unavailable.',
  'incomplete-progress': 'HoYoLAB returned an incomplete progress list. No partial file was exported.',
  'context-changed': 'The account or map changed during export. Run the script again.',
};
async function runSourceExport({ window, fetch, download, console }) {
  try {
    const result = await exportHoYoLab({ window, fetch });
    const { serializeTransfer } = require('../../envelope');
    const bytes = serializeTransfer(result.envelope); result.assertCurrent();
    await download('genshin-hoyolab-progress.json', bytes);
    console.log('HoYoLAB export: download requested for ' + result.summary.found + ' found Teyvat marks; ' + result.summary.unknown + ' catalog-unknown IDs retained for recovery.');
    console.log('In the overlay select HoYoLAB, choose genshin-hoyolab-progress.json, review matched/unmatched counts and apply to a new profile.');
  } catch (error) {
    const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'source-export-failed';
    console.error('HoYoLAB export stopped (' + code + '): ' + (MESSAGES[code] || 'The file could not be exported. Reload the map and retry.'));
  }
}
module.exports = { exportHoYoLab, runSourceExport };
