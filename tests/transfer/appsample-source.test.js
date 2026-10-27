'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseTransfer } = require('../../src/transfer/envelope');
const { makeDocument } = require('./helpers');
const ROOT = path.resolve(__dirname, '../..');

// Source-shaped contracts inspected in AppSample's first-party app bundle on
// 2026-10-27. Synthetic user/progress values; no credentials or live-save claim.
function sourceSite() {
  const document = makeDocument();
  const values = new Map([['gim-local-markers', JSON.stringify({ markerIds: ['43', '42', '70'] })]]);
  let account = 'synthetic-account';
  let cloud = { markerIds: ['42', '70', '99'], unrelatedPrivateField: 'must-not-export' };
  const rows = {
    2: { o5: [{ id: '42', mid: 2, type: 'o5', lat: 0.1, lng: 0.2, level: 5 }], o9: [{ id: '43', mid: 2, type: 'o9', lat: 0.3, lng: 0.4, level: 7 }] },
    7: { o5: [{ id: '70', mid: 7, type: 'o5', lat: 0, lng: 0, level: 5 }] },
  };
  const auth = { get currentUser() { return account ? { uid: account } : null; } };
  let read = async () => cloud;
  const service = {
    app: 'gim', auth, get uid() { return account || ''; },
    async get(collection, uid) { assert.equal(collection, 'users'); assert.equal(uid, account); return read(); },
    set() { throw new Error('source must not write'); }, addToList() { throw new Error('source must not write'); },
    getAuthToken() { throw new Error('source must not extract credentials'); },
  };
  const modules = { 9302: { Z: service }, 3580: { gz: rows }, 3951: { lw: 'gim' } };
  const chunks = [];
  chunks.push = function(entry) {
    // Same relevant contract as the inspected webpack runtime: the callback
    // runs only if at least one chunk ID is new. Module definitions stay empty.
    assert.equal(Object.keys(entry[1]).length, 0);
    if (entry[0].length) entry[2](id => { if (!modules[id]) throw new Error('unknown module'); return modules[id]; });
    return Array.prototype.push.call(this, entry);
  };
  const nextData = { textContent: JSON.stringify({ buildId: 'g2A_0C3iZKpNbinJgViG_' }) };
  document.querySelector = selector => selector === '#__NEXT_DATA__' ? nextData : null;
  document.scripts = [{ src: 'https://genshin-impact-map.appsample.com/_next/static/chunks/pages/_app-1e81edb09414b5db.js' }];
  const window = {
    location: { origin: 'https://genshin-impact-map.appsample.com', pathname: '/', href: 'https://genshin-impact-map.appsample.com/' },
    document, webpackChunk_N_E: chunks,
    _store: { getState: () => ({ user: { user: account ? { uid: account, name: 'Synthetic Player' } : undefined, foundDataError: '' } }) },
    localStorage: { getItem: key => values.get(key) ?? null, setItem() { throw new Error('source must not write'); } },
  };
  return { window, rows, nextData, values, setAccount: value => { account = value; }, setCloud: value => { cloud = value; }, setRead: value => { read = value; } };
}

async function execute(site) {
  const errors = [], logs = [], blobs = new Map(), downloads = [];
  const document = site.window.document;
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'a') node.click = () => { downloads.push({ name: node.download, blob: blobs.get(node.href) }); };
    return node;
  };
  const context = {
    window: site.window, document, crypto: globalThis.crypto, Blob, TextEncoder, TextDecoder, Uint8Array, URL,
    console: { error: value => errors.push(String(value)), log: value => logs.push(String(value)), warn: value => logs.push(String(value)) },
    setTimeout: callback => { callback(); return 0; },
  };
  context.URL = class extends URL {
    static createObjectURL(blob) { const url = 'blob:synthetic-' + blobs.size; blobs.set(url, blob); return url; }
    static revokeObjectURL() {}
  };
  context.fetch = () => { throw new Error('must use site session reader, never an invented endpoint'); };
  const code = await fs.readFile(path.join(ROOT, 'src/transfer/scripts/appsample-export.js'), 'utf8');
  await vm.runInNewContext(code, context, { timeout: 1000 });
  const files = await Promise.all(downloads.map(async item => ({ name: item.name, bytes: new Uint8Array(await item.blob.arrayBuffer()) })));
  return { errors, logs, files };
}

test('AppSample DevTools source bundle downloads cloud plus legacy Teyvat found IDs as an importable file', async () => {
  const result = await execute(sourceSite());
  assert.equal(result.files.length, 1, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  const file = parseTransfer(result.files[0].bytes);
  assert.equal(file.provider, 'appsample'); assert.equal(file.map, 'appsample:gim:2');
  assert.deepEqual(file.records.map(row => [row.id, row.category, row.state, row.level]), [['42', 'o5', true, null], ['43', 'o9', true, null]]);
  assert.match(file.catalog.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(file.coverage.complete, false);
  assert.doesNotMatch(new TextDecoder().decode(result.files[0].bytes), /synthetic-account|Synthetic Player|must-not-export|markerIds/);
  assert.match(result.logs.join('\n'), /1.*other map/i); assert.match(result.logs.join('\n'), /1.*unknown/i);
});

test('AppSample source rechecks identity after a cloud read and never downloads the previous account', async () => {
  const site = sourceSite(); site.setRead(async () => { site.setAccount('another-account'); return { markerIds: ['42'] }; });
  const result = await execute(site); assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), /account-changed/);
});

for (const [name, change, error] of [
  ['signed out', site => site.setAccount(null), 'sign-in-required'],
  ['cloud read denied', site => site.setRead(async () => { throw new Error('server private error'); }), 'cloud-read-failed'],
  ['malformed cloud data', site => site.setCloud({ markerIds: ['42', 'invalid'] }), 'invalid-progress'],
  ['malformed local data', site => site.values.set('gim-local-markers', '{broken'), 'invalid-local-progress'],
  ['invalid local IDs', site => site.values.set('gim-local-markers', '{"markerIds":[-1]}'), 'invalid-local-progress'],
  ['changed site build', site => { site.nextData.textContent = '{"buildId":"changed"}'; }, 'site-version-changed'],
  ['wrong website', site => { site.window.location.origin = 'https://example.invalid'; }, 'wrong-site'],
  ['empty catalog', site => { delete site.rows[2]; }, 'catalog-unavailable'],
]) test(`AppSample source stops without a download for ${name}`, async () => {
  const site = sourceSite(); change(site); const result = await execute(site);
  assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), new RegExp(error));
  assert.doesNotMatch(result.errors.join('\n'), /server private error/);
});

test('AppSample source stops if the catalog or legacy progress changes while the cloud read is pending', async () => {
  for (const [change, code] of [
    [site => { site.rows[2].o5[0].type = 'o9'; }, 'catalog-unavailable'],
    [site => { site.rows[2].o5[0].lng = 0.9; }, 'catalog-changed'],
    [site => site.values.set('gim-local-markers', '{"markerIds":["42"]}'), 'progress-changed'],
  ]) {
    const site = sourceSite(); site.setRead(async () => { change(site); return { markerIds: ['42'] }; });
    const result = await execute(site); assert.equal(result.files.length, 0); assert.match(result.errors.join('\n'), new RegExp(code));
  }
});

test('AppSample source handles a new cloud account and numeric legacy IDs without inventing found marks', async () => {
  const site = sourceSite(); site.setCloud(undefined); site.values.set('gim-local-markers', '{"markerIds":[43]}');
  const result = await execute(site); assert.deepEqual(result.errors, []); assert.equal(result.files.length, 1);
  assert.deepEqual(parseTransfer(result.files[0].bytes).records.map(row => row.id), ['43']);
  site.values.delete('gim-local-markers');
  const empty = await execute(site); assert.equal(parseTransfer(empty.files[0].bytes).records.length, 0);
  assert.match(empty.logs.join('\n'), /No found Teyvat markers/);
});

test('downloaded AppSample source file previews, imports, survives restart, and merges idempotently', async t => {
  const result = await execute(sourceSite()); assert.equal(result.files.length, 1, JSON.stringify(result.errors));
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'appsample-source-import-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const { ProgressRepository } = require('../../src/progress/repository');
  const { ProgressService } = require('../../src/progress/service');
  const { TransferController } = require('../../src/transfer/controller');
  const root = path.join(userData, 'progress');
  const repository = new ProgressRepository({ root }); const service = new ProgressService({ repository });
  await service.initialize({ userData });
  const catalog = { namespace: 'appsample:gim:2', fingerprint: 'a'.repeat(64), markers: [
    { id: '42', category: 'o5', level: null, x: 0.2, y: 0.1 }, { id: '43', category: 'o9', level: null, x: 0.4, y: 0.3 },
  ] };
  const controller = new TransferController({ progress: service, getCatalog: () => catalog, getMapping: () => null });
  const ctx = () => ({ sessionGeneration: service.snapshot().sessionGeneration, profileId: service.snapshot().activeProfile.id });
  const bytes = Buffer.from(result.files[0].bytes);
  const preview = await controller.previewImport(ctx(), { bytes, mode: 'new' });
  assert.equal(preview.counts.matched, 2); assert.deepEqual(service.snapshot().activeProfile.foundIds, []);
  assert.equal((await controller.applyImport(ctx(), { previewId: preview.id })).ok, true);
  assert.deepEqual(service.snapshot().activeProfile.foundIds, [42, 43]);
  const before = await repository.load({ kind: 'local' });
  const again = await controller.previewImport(ctx(), { bytes, mode: 'merge' });
  assert.equal((await controller.applyImport(ctx(), { previewId: again.id })).ok, true);
  assert.equal((await repository.load({ kind: 'local' })).revision, before.revision);
  const reopened = new ProgressService({ repository: new ProgressRepository({ root }) }); await reopened.initialize({ userData });
  assert.deepEqual(reopened.snapshot().activeProfile.foundIds, [42, 43]);
});
