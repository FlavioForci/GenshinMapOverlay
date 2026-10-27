'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateCapability } = require('../../src/transfer/capabilities');
const { listProviders, getProvider } = require('../../src/transfer/registry');
const { catalogReport } = require('../../tools/transfer/catalog-report');
const { fixture, makeTransfer, makeBrowserHarness } = require('./helpers');

const ids = ['appsample', 'hoyolab', 'mapgenie', 'kongying', 'bwiki'];
const bad = { code: 'invalid-capability' };
const copy = value => structuredClone(value);

// Synthetic acceptance exercises the gate; it is never provider research evidence.
function accepted() {
  const value = getProvider('hoyolab');
  value.status = 'supported';
  value.reasonCode = null;
  const variant = value.variants[0];
  Object.assign(variant, {
    browser: { family: 'chromium', version: 'synthetic-test-version' },
    read: 'verified', write: 'verified', restore: 'verified', reasonCode: null,
    accountTier: 'website-account',
    pacing: { batchSize: 1, minIntervalMs: 1000, maxAttempts: 3, maxBackoffMs: 30000 },
  });
  for (const key of ['read', 'write', 'reload', 'destinationOnlyPreserved', 'pairAccepted', 'restore']) variant.evidence[key] = true;
  return value;
}

test('five distinct provider families stay visible without invented support', () => {
  const providers = listProviders();
  assert.deepEqual(providers.map(p => p.provider), ids);
  assert.ok(providers.every(p => p.status !== 'supported' && p.reasonCode));
  assert.ok(providers.every(p => p.variants.every(v => v.write !== 'verified' && !v.evidence.pairAccepted && v.pacing === null)));
  for (const provider of providers) assert.deepEqual(validateCapability(provider), provider);
});

test('registry rejects unknown IDs and callers cannot change later capability results', () => {
  for (const id of ['__proto__', 'constructor', 'mainland', '', null, 1]) assert.throws(() => getProvider(id), { code: 'unknown-provider' });
  const result = listProviders();
  result[0].status = 'supported';
  result[0].variants[0].origins.push('https://example.invalid');
  assert.notEqual(getProvider('appsample').status, 'supported');
  assert.equal(getProvider('appsample').variants[0].origins.includes('https://example.invalid'), false);
});

test('read-only proof remains planned and cannot enable writes or support', () => {
  const value = getProvider('hoyolab');
  const variant = value.variants[0];
  variant.read = 'verified';
  variant.evidence.read = true;
  variant.browser.version = 'synthetic-test-version';
  variant.accountTier = 'website-account';
  assert.equal(validateCapability(value).status, 'planned');
  value.status = 'supported';
  value.reasonCode = null;
  assert.throws(() => validateCapability(value), bad);
  value.status = 'planned';
  value.reasonCode = 'acceptance-pending';
  variant.write = 'verified';
  assert.throws(() => validateCapability(value), bad);
});

test('support requires every live acceptance fact, known context and measured pacing', () => {
  assert.equal(validateCapability(accepted()).status, 'supported');
  for (const field of ['read', 'write', 'reload', 'destinationOnlyPreserved', 'pairAccepted', 'restore']) {
    const value = accepted();
    value.variants[0].evidence[field] = false;
    assert.throws(() => validateCapability(value), bad, field);
  }
  for (const patch of [{ browser: { family: 'chromium', version: '' } }, { catalogFingerprint: '' }, { generation: '' }, { accountTier: 'unverified' }, { pacing: null }]) {
    const value = accepted();
    Object.assign(value.variants[0], patch);
    assert.throws(() => validateCapability(value), bad);
  }
});

test('international acceptance cannot authorize mainland or arbitrary endpoints', () => {
  for (const origin of ['https://api-takumi.mihoyo.com', 'https://act.mihoyo.com', 'https://example.invalid']) {
    const value = accepted();
    value.variants[0].origins.push(origin);
    assert.throws(() => validateCapability(value), bad);
  }
  for (const endpoint of [
    { method: 'POST', origin: 'https://api-takumi.mihoyo.com', path: '/common/map_user/ys_obc/v1/map/point/add_mark_map_point' },
    { method: 'POST', origin: 'https://sg-public-api.hoyolab.com', path: '/arbitrary' },
    { method: 'GET', origin: 'https://sg-public-api.hoyolab.com', path: '/common/map_user/ys_obc/v1/map/point/mark_map_point_list?token=secret' },
  ]) {
    const value = accepted();
    value.variants[0].endpoints.push(endpoint);
    assert.throws(() => validateCapability(value), bad);
  }
});

test('untested account tiers, browsers and client variants cannot inherit website proof', () => {
  for (const patch of [
    { id: 'mobile', generation: 'unobserved-mobile' },
    { id: 'firefox', browser: { family: 'firefox', version: '' } },
    { id: 'other-tier', accountTier: 'website-pro' },
  ]) {
    const value = accepted();
    const extra = copy(value.variants[0]);
    Object.assign(extra, patch);
    for (const key of Object.keys(extra.evidence)) if (key !== 'checkedAt') extra.evidence[key] = false;
    value.variants.push(extra);
    assert.throws(() => validateCapability(value), bad);
    Object.assign(extra, { read: 'unverified', write: 'unverified', restore: 'unverified', pacing: null, reasonCode: 'acceptance-pending' });
    assert.equal(validateCapability(value).variants[1].write, 'unverified');
  }
});

test('strict capability validation rejects unknown fields, unsafe objects and invalid measurements', () => {
  const mutations = [
    v => { v.accountId = 'forbidden'; },
    v => { v.variants[0].browser.token = 'forbidden'; },
    v => { v.variants[0].endpoints[0].credential = 'forbidden'; },
    v => { v.variants[0].evidence.checkedAt = 'yesterday'; },
    v => { v.variants[0].evidence.write = 1; },
    v => { v.variants[0].pacing.maxAttempts = 4; },
    v => { v.variants[0].pacing.maxBackoffMs = 30001; },
    v => { v.variants[0].pacing.batchSize = 0; },
    v => { v.variants[0].pacing.minIntervalMs = -1; },
    v => { v.variants[0].statePaths.push('cookies'); },
    v => { v.variants[0].map = 'hoyolab:mainland:2'; },
    v => { v.variants.push(copy(v.variants[0])); },
    v => { v.variants[0].origins.push(v.variants[0].origins[0]); },
    v => { v.variants[0].catalogFingerprint = 'x'; },
    v => { v.variants[0].browser.family = 'webkit'; },
    v => { v.reasonCode = 'missing-proof'; },
    v => { v.variants[0].reasonCode = 'missing-proof'; },
  ];
  for (const mutate of mutations) { const value = accepted(); mutate(value); assert.throws(() => validateCapability(value), bad); }
  for (const value of [null, [], Object.create({}), JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateCapability(value), bad);
  let invoked = false;
  const value = accepted();
  Object.defineProperty(value.variants[0].browser, 'version', { enumerable: true, get() { invoked = true; return '1'; } });
  assert.throws(() => validateCapability(value), bad);
  assert.equal(invoked, false);
  const sparse = accepted();
  delete sparse.variants[0];
  assert.throws(() => validateCapability(sparse), bad);
});

const a = { id: '42', map: 'appsample:gim:2', category: 'o5', level: null, state: true, position: { x: -12.5, y: 20, space: 'appsample:lng-lat' } };
const b = { id: '100', map: 'appsample:gim:2', category: 'o6', level: '1', state: false, position: null };
const sample = { provider: 'appsample', map: a.map, catalog: [a, b], progress: [a] };

test('catalog reports measure UTF-8 normalized progress and metadata with a stable scoped fingerprint', () => {
  const report = catalogReport(sample);
  assert.equal(report.catalogCount, 2);
  assert.equal(report.progressRecordCount, 1);
  assert.equal(report.progressBytes, Buffer.byteLength(JSON.stringify([a]), 'utf8'));
  assert.deepEqual(report.categories, ['o5', 'o6']);
  assert.deepEqual(report.levels, ['1']);
  assert.equal(report.maxIdLength, 3);
  assert.equal(report.maxStringLength, 17);
  assert.equal(report.maxAbsCoordinate, 20);
  assert.match(report.catalogFingerprint, /^[a-f0-9]{64}$/);
  const reordered = { ...sample, catalog: [{ position: null, state: true, level: '1', category: 'o6', map: b.map, id: '100' }, { ...a, state: false }] };
  assert.equal(catalogReport(reordered).catalogFingerprint, report.catalogFingerprint);
  assert.notEqual(catalogReport({ ...sample, catalog: [a] }).catalogFingerprint, report.catalogFingerprint);
  assert.notEqual(catalogReport({ ...sample, catalog: [{ ...a, level: '2' }, b] }).catalogFingerprint, report.catalogFingerprint);
  assert.equal(catalogReport({ ...sample, progress: [a, { ...b, state: true }] }).progressRecordCount, 2);
  assert.equal(catalogReport({ ...sample, catalog: [], progress: [] }).maxAbsCoordinate, 0);
});

test('catalog report preserves duplicate row measurements and measures bounds instead of truncating', () => {
  const large = { ...a, id: '界'.repeat(129), category: 'c'.repeat(257), position: { x: 1e13, y: 0, space: 'native' } };
  const report = catalogReport({ ...sample, catalog: [large, large], progress: [large] });
  assert.equal(report.catalogCount, 2);
  assert.equal(report.maxIdLength, 129);
  assert.equal(report.maxStringLength, 257);
  assert.equal(report.maxAbsCoordinate, 1e13);
  assert.equal(report.progressBytes, Buffer.byteLength(JSON.stringify([large])));
});

test('catalog report rejects malformed metadata, nonfinite coordinates and mixed maps', () => {
  for (const patch of [{ map: 'other' }, { id: 42 }, { state: 'true' }, { position: { x: NaN, y: 0, space: 'native' } }, { token: 'forbidden' }, { position: { x: 0, y: 0, space: 'native', url: 'forbidden' } }]) {
    assert.throws(() => catalogReport({ ...sample, catalog: [{ ...a, ...patch }] }), { code: 'invalid-catalog-input' });
  }
  assert.throws(() => catalogReport({ ...sample, provider: 'unknown' }), { code: 'invalid-catalog-input' });
  assert.throws(() => catalogReport({ ...sample, catalog: null }), { code: 'invalid-catalog-input' });
});

test('catalog CLI reads explicit developer paths, produces the report and fails on unknown flags', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-report-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(sample.catalog));
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify(sample.progress));
  const cli = path.resolve(__dirname, '../../tools/transfer/catalog-report.js');
  const args = ['--provider', 'appsample', '--map', a.map, '--catalog', path.join(dir, 'catalog.json'), '--progress', path.join(dir, 'progress.json'), '--out', path.join(dir, 'report.json')];
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'))), catalogReport(sample));
  const invalid = spawnSync(process.execPath, [cli, ...args, '--url', 'https://example.invalid'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid-catalog-arguments/);
});

test('fixtures distinguish public catalog observations from synthetic or unobserved progress', () => {
  for (const id of ids) {
    const context = fixture(id, 'context');
    assert.equal(context.liveAcceptance, false);
    assert.ok(['synthetic', 'unobserved'].includes(context.progressEvidence));
    const progress = fixture(id, 'progress');
    if (context.progressEvidence === 'unobserved') assert.equal(progress, null);
    assert.equal(fixture(id, 'expected').supported, false);
    assert.ok(Array.isArray(fixture(id, 'catalog')) || fixture(id, 'catalog') === null);
  }
  assert.throws(() => fixture('appsample', '../../package'));
  assert.throws(() => fixture('../appsample', 'context'));
  const one = makeTransfer();
  one.records.push(a);
  assert.equal(makeTransfer().records.length, 0);
  assert.equal(makeTransfer({ provider: 'hoyolab' }).provider, 'hoyolab');
});

test('browser harness provides deterministic context, explicit durable sets and virtual time', async () => {
  const h = makeBrowserHarness({ provider: 'appsample', foundIds: ['42'], failures: { '43': ['uncertain'] } });
  const context = await h.adapter.detect();
  assert.equal(context.accountLabel, null);
  assert.deepEqual((await h.adapter.read(context)).foundIds, ['42']);
  const first = await h.adapter.setFound(context, '43', new AbortController().signal);
  assert.equal(first.status, 'uncertain');
  assert.deepEqual((await h.adapter.read(context)).foundIds, ['42', '43']);
  await h.sleep(1000);
  assert.equal(h.now(), 1000);
  const backup = await h.adapter.exportProgress(context);
  await h.adapter.setFound(context, '44', new AbortController().signal);
  await h.adapter.restoreProgress(context, backup, new AbortController().signal);
  assert.deepEqual((await h.adapter.read(context)).foundIds, ['42', '43']);
  let applied = 0;
  const off = h.ui.onApply(() => applied++);
  h.emit('apply'); off(); h.emit('apply');
  assert.equal(applied, 1);
  h.ui.showError('test-code');
  assert.deepEqual(h.events.at(-1), { type: 'error', value: 'test-code' });
});
