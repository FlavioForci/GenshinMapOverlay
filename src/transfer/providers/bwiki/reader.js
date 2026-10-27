'use strict';
const { TRANSFER_LIMITS, serializeTransfer } = require('../../envelope');
const { buildSourceTransfer } = require('../../browser/source');
const { MAP, snapshotCatalog, markerId, category } = require('./normalize');
const KEY = 'wikiMap_ys_Data:Map4_Data';
const DB = 'wikiYSMap4Data';
const SHARDS = ['point.json', 'point2.json', 'point3.json', 'point4.json', 'point5.json', 'point6.json'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
function context(window) {
  if (window.location?.origin !== 'https://wiki.biligame.com' || !window.location.pathname?.startsWith('/ys/')) fail('wrong-site');
  if (window.mw?.config?.get('wgGameName') !== 'ys' || window.mw.config.get('wgRevisionId') !== 690410
    || window.mapData?.dataPrefix !== 'Data:Map4' || JSON.stringify(window.mapData.dataList) !== JSON.stringify(SHARDS)
    || window.mapPackage?.wikiData?._wgGameName !== 'ys' || window.markEmbedType) fail('site-version-changed');
  // Vue's mounted root vnode exposes the existing component. No app creation,
  // method invocation, filtered computed catalog, or marker/UI setters.
  const root = window.document?.querySelector('#app');
  const instance = root?._vnode?.component?.proxy || root?.__vue_app__?._instance?.proxy;
  if (!instance || typeof instance.indexedDBState !== 'boolean' || instance.storageName?.data !== KEY || instance.daDian?.show !== false) fail('site-not-ready');
  return { instance, useIDB: instance.indexedDBState, catalog: snapshotCatalog(window.pointsData), progress: progressSnapshot(instance.onchoose) };
}
function time(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid-progress');
  return value;
}
function progressSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-progress');
  const entries = [];
  for (const [type, marks] of Object.entries(value)) {
    category(type, 'invalid-progress');
    if (!marks || typeof marks !== 'object' || Array.isArray(marks)) fail('invalid-progress');
    for (const [id, timestamp] of Object.entries(marks)) {
      if (entries.length >= TRANSFER_LIMITS.RECORDS) fail('invalid-progress');
      entries.push([markerId(id, 'invalid-progress'), type, time(timestamp)]);
    }
  }
  entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { ids: [...new Set(entries.map(row => row[0]))].sort(), signature: JSON.stringify(entries) };
}
function readFallback(window) {
  let raw;
  try { raw = window.localStorage.getItem(KEY); } catch { fail('save-unavailable'); }
  // A brand-new fallback save may be absent. Never import the old map's data
  // or merge another persistence backend; equality with onchoose is required.
  if (raw === null) return progressSnapshot({});
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > TRANSFER_LIMITS.BYTES) fail('invalid-progress');
  let parsed; try { parsed = JSON.parse(raw); } catch { fail('invalid-progress'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'data')) fail('invalid-progress');
  return progressSnapshot(parsed.data);
}
async function readDatabase(window) {
  const indexedDB = window.indexedDB;
  if (typeof indexedDB?.databases !== 'function') fail('save-unavailable');
  let databases;
  try { databases = await indexedDB.databases(); } catch { fail('save-unavailable'); }
  if (!Array.isArray(databases) || !databases.some(item => item.name === DB && item.version === 1)) fail('save-unavailable');
  return new Promise((resolve, reject) => {
    let request, db, finished = false;
    const end = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer);
      db?.close(); error ? reject(Object.assign(new Error(error), { code: error })) : resolve(result);
    };
    const timer = setTimeout(() => end('save-unavailable'), 10000);
    try {
      // No version argument. A disappearance race is handled by aborting the
      // upgrade transaction, so this reader never creates a database/store.
      request = indexedDB.open(DB);
      request.onupgradeneeded = () => { request.transaction?.abort(); end('save-unavailable'); };
      request.onerror = request.onblocked = () => end('save-unavailable');
      request.onsuccess = () => {
        db = request.result;
        if (finished) { db.close(); return; }
        try {
          if (db.version !== 1 || !db.objectStoreNames.contains('pointsOnchoose')) return end('save-unavailable');
          const transaction = db.transaction(['pointsOnchoose'], 'readonly');
          const store = transaction.objectStore('pointsOnchoose');
          if (store.keyPath !== 'id') return end('save-unavailable');
          let snapshot;
          const read = store.getAll();
          read.onsuccess = () => {
            try {
              if (!Array.isArray(read.result) || read.result.length > TRANSFER_LIMITS.RECORDS) fail('invalid-progress');
              const grouped = Object.create(null);
              for (const row of read.result) {
                const type = category(row?.type, 'invalid-progress'), id = markerId(row?.id, 'invalid-progress');
                grouped[type] ||= Object.create(null);
                if (Object.hasOwn(grouped[type], id)) fail('invalid-progress');
                grouped[type][id] = time(row.time);
              }
              snapshot = progressSnapshot(grouped);
            } catch { end('invalid-progress'); }
          };
          read.onerror = transaction.onabort = transaction.onerror = () => end('save-unavailable');
          transaction.oncomplete = () => snapshot ? end(null, snapshot) : end('save-unavailable');
        } catch { end('save-unavailable'); }
      };
    } catch { end('save-unavailable'); }
  });
}
async function exportBwiki(window) {
  const initial = context(window);
  function assertCurrent() {
    const current = context(window);
    if (current.instance !== initial.instance || current.useIDB !== initial.useIDB) fail('save-changed');
    if (current.catalog.signature !== initial.catalog.signature) fail('catalog-changed');
    if (current.progress.signature !== initial.progress.signature) fail('progress-changed');
  }
  const read = () => initial.useIDB ? readDatabase(window) : readFallback(window);
  const persisted = await read(); assertCurrent();
  if (persisted.signature !== initial.progress.signature) fail('progress-changed');
  const result = await buildSourceTransfer({ provider: 'bwiki', map: MAP, generation: 'Data:Map4:revision690410', catalog: initial.catalog.records, foundIds: persisted.ids });
  const after = await read(); assertCurrent();
  if (after.signature !== persisted.signature) fail('progress-changed');
  return { ...result, conflicts: initial.catalog.conflicts.length, assertCurrent };
}
const ERRORS = {
  'wrong-site': 'Open https://wiki.biligame.com/ys/大地图 and run the script on that map.',
  'site-version-changed': 'The BWIKI Map4 page changed or is a different map. Use an updated source script.',
  'site-not-ready': 'Wait for the complete BWIKI map to load and leave point editing before retrying.',
  'catalog-unavailable': 'The complete loaded BWIKI catalog is unavailable or has an unexpected format. Reload the map and retry.',
  'save-unavailable': 'The active BWIKI save could not be read safely. No file was exported.',
  'save-changed': 'The active BWIKI save changed. Run the script again.',
  'catalog-changed': 'The BWIKI catalog changed during export. Run the script again.',
  'progress-changed': 'BWIKI progress is still loading, saving, or changed during export. Wait and run the script again.',
  'invalid-progress': 'BWIKI returned an unexpected mark format. No file was exported.',
};
async function runSourceExport({ window, fetch, download, console }) {
  try {
    const result = await exportBwiki(window);
    const bytes = serializeTransfer(result.envelope); result.assertCurrent();
    await download('genshin-bwiki-progress.json', bytes);
    console.log('BWIKI export: download requested for ' + result.summary.found + ' marked points; ' + result.summary.unknown + ' unknown IDs retain progress without mapping metadata.');
    if (result.conflicts) console.warn('BWIKI catalog: ' + result.conflicts + ' conflicting IDs excluded from coordinate mapping. Their marked progress is retained as unknown IDs.');
    console.log('Save genshin-bwiki-progress.json. In the overlay, open Profiles & transfers, select BWIKI, choose the file, review the preview, then apply.');
    if (!result.summary.found) console.warn('No marked BWIKI points were returned. Check the intended browser save before importing.');
  } catch (error) {
    const code = Object.hasOwn(ERRORS, error?.code) ? error.code : 'source-export-failed';
    console.error('BWIKI export stopped (' + code + '): ' + (ERRORS[code] || 'The source file could not be exported. Reload the map and retry.'));
  }
}
module.exports = { exportBwiki, runSourceExport };
