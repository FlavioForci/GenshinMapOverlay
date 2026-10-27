'use strict';
const { TRANSFER_LIMITS, serializeTransfer } = require('../../envelope');
const { snapshotCatalog, normalizeProgress } = require('./normalize');

// First-party source inspected 2026-10-27. Pin both build and app bundle: the
// build ID alone need not change when a deployment's assets are replaced.
const BUILD = 'g2A_0C3iZKpNbinJgViG_';
const APP = '/_next/static/chunks/pages/_app-1e81edb09414b5db.js';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function checkPage(window) {
  if (window.location?.origin !== 'https://genshin-impact-map.appsample.com') fail('wrong-site');
  let data;
  try { data = JSON.parse(window.document.querySelector('#__NEXT_DATA__')?.textContent || 'null'); } catch { fail('site-version-changed'); }
  if (data?.buildId !== BUILD || !Array.from(window.document.scripts).some(script => {
    try { const url = new URL(script.src, window.location.href); return url.origin === window.location.origin && url.pathname === APP; } catch { return false; }
  })) fail('site-version-changed');
}
function siteModules(window) {
  const chunks = window.webpackChunk_N_E;
  if (!Array.isArray(chunks)) fail('site-not-ready');
  let load;
  // Obtain the existing module reader with an empty, unique webpack chunk.
  // Register no module factories, replace no functions, load no remote code.
  const entry = [['gmo-source-' + globalThis.crypto.randomUUID()], {}, runtime => { load = runtime; }];
  try { chunks.push(entry); } catch { fail('site-not-ready'); }
  finally { if (chunks[chunks.length - 1] === entry) chunks.pop(); }
  if (typeof load !== 'function') fail('site-not-ready');
  try { return { cloud: load(9302).Z, catalog: load(3580), config: load(3951) }; } catch { fail('site-version-changed'); }
}
function account(window, modules) {
  checkPage(window);
  const { cloud, config } = modules;
  if (config.lw !== 'gim' || cloud?.app !== 'gim' || typeof cloud.get !== 'function') fail('site-version-changed');
  const uid = cloud.auth?.currentUser?.uid;
  if (typeof uid !== 'string' || !uid || cloud.uid !== uid || window._store?.getState?.()?.user?.user?.uid !== uid) fail('sign-in-required');
  return uid;
}
function legacyProgress(window) {
  let raw;
  try { raw = window.localStorage.getItem('gim-local-markers'); } catch { fail('local-progress-unavailable'); }
  if (raw === null || raw === 'undefined') return { raw, ids: [] };
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > TRANSFER_LIMITS.BYTES) fail('invalid-local-progress');
  let value; try { value = JSON.parse(raw); } catch { fail('invalid-local-progress'); }
  if (!value || typeof value !== 'object' || !Array.isArray(value.markerIds)) fail('invalid-local-progress');
  return { raw, ids: value.markerIds };
}

/** Read progress in the site's signed-in session. No tokens leave the site,
 * no marker setters are called, and read errors never become empty exports.
 */
async function exportAppSample(window) {
  checkPage(window);
  const modules = siteModules(window);
  if (typeof modules.cloud?.auth?.authStateReady === 'function') await modules.cloud.auth.authStateReady();
  const uid = account(window, modules);
  const catalog = snapshotCatalog(modules.catalog.gz);
  const legacy = legacyProgress(window);
  function assertCurrent() {
    let current; try { current = account(window, modules); } catch { fail('account-changed'); }
    if (current !== uid) fail('account-changed');
    if (snapshotCatalog(modules.catalog.gz).signature !== catalog.signature) fail('catalog-changed');
    if (legacyProgress(window).raw !== legacy.raw) fail('progress-changed');
  }
  let document;
  try { document = await modules.cloud.get('users', uid); } catch { fail('cloud-read-failed'); }
  assertCurrent();
  if (document !== undefined && (document === null || typeof document !== 'object' || Array.isArray(document))) fail('invalid-progress');
  // The site's get() returns undefined for a nonexistent user document; a
  // document without markerIds also represents no saved cloud marks.
  const cloudIds = document && Object.hasOwn(document, 'markerIds') ? document.markerIds : [];
  const result = await normalizeProgress({ catalog, cloudIds, localIds: legacy.ids, generation: 'next:' + BUILD + ':app:1e81edb09414b5db' });
  assertCurrent();
  return { ...result, assertCurrent };
}

const ERRORS = Object.freeze({
  'wrong-site': 'Open https://genshin-impact-map.appsample.com/ and run this script there.',
  'site-version-changed': 'AppSample has changed. Use an updated overlay source script.',
  'site-not-ready': 'Wait for the AppSample map to finish loading, then run the script again.',
  'sign-in-required': 'Sign in to AppSample, wait for your found markers to load, then run the script again.',
  'cloud-read-failed': 'Could not read your AppSample cloud save. Check your connection and sign-in, then retry.',
  'account-changed': 'Your AppSample account changed during export. Run the script again for the intended account.',
  'catalog-unavailable': 'The full AppSample marker catalog is not ready or has an unexpected format. Reload the map and retry.',
  'catalog-changed': 'The AppSample marker catalog changed during export. Run the script again.',
  'progress-changed': 'Browser-local progress changed during export. Run the script again.',
  'invalid-progress': 'AppSample returned an unexpected saved-marker format. No file was exported.',
  'invalid-local-progress': 'AppSample browser-local progress has an unexpected format. No file was exported.',
  'local-progress-unavailable': 'The browser did not allow reading AppSample local progress. No file was exported.',
});
async function runSourceExport({ window, download, console }) {
  try {
    const result = await exportAppSample(window);
    const bytes = serializeTransfer(result.envelope);
    result.assertCurrent();
    await download('genshin-appsample-progress.json', bytes);
    const { found, otherMaps, unknown } = result.summary;
    console.log('AppSample export: download requested for ' + found + ' found Teyvat markers. ' + otherMaps + ' found markers on other maps and ' + unknown + ' unknown marker IDs were excluded.');
    console.log('Save genshin-appsample-progress.json. In the overlay, open Profiles & transfers, select AppSample, choose the file, review the preview, then apply.');
    if (!found) console.warn('No found Teyvat markers were returned. Check that you signed in to the intended AppSample account before importing this file.');
  } catch (error) {
    const code = Object.hasOwn(ERRORS, error?.code) ? error.code : 'source-export-failed';
    console.error('AppSample export stopped (' + code + '): ' + (ERRORS[code] || 'The source file could not be exported. Reload AppSample and try again.'));
  }
}
module.exports = { exportAppSample, runSourceExport };
