'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { mountSettings } = require('../../src/settings/settings'); const I18n = require('../../src/shared/i18n');
const { listProviders } = require('../../src/transfer/registry');
const { makeSettingsDocument: dom } = require('./settings-harness');
const state = (viewVersion = 1) => ({ viewVersion, sessionGeneration: 'A', profiles: [{ id: 'P', name: 'Local', region: '' }], activeProfile: { id: 'P', name: 'Local', region: '' }, sync: { phase: 'local', code: null } });
const counts = { matched: 1, alreadyFound: 2, ambiguous: 3, unsupported: 4, unknown: 5, invalid: 0, ignoredNotFound: 6, duplicates: 7 };
const p = { id: 'token', context: { sessionGeneration: 'A', profileId: 'P' }, counts, coverage: { categories: ['<img src=x>'], levels: [], complete: false }, priorDestinations: [], canApply: true };
async function setup(overrides = {}) { const document = dom(); let onSnapshot; let onLanguage; let onPrepare; const acks = [];
  const api = { getState: async () => ({ ok: true, value: state() }), command: async () => ({ ok: true, value: state(2) }), onSnapshot: fn => { onSnapshot = fn; return () => {}; }, onLanguage: fn => { onLanguage = fn; return () => {}; }, onPrepareQuit: fn => { onPrepare = fn; return () => {}; }, onResumeAfterQuit: () => () => {}, quitReady: r => acks.push(r) };
  const transferApi = { providers: async () => listProviders(), previewImport: async () => ({ ok: true, value: structuredClone(p) }), applyImport: async () => ({ ok: true, value: { snapshot: state(2), receipt: { counts } } }), exportProfile: async () => ({ ok: true, value: { counts, coverage: p.coverage, decisions: [{ sourceId: '<label>', reason: 'reverse-mapping-unavailable' }] } }), saveReport: async () => ({ ok: true, value: null }), saveScript: async () => ({ ok: true, value: null }), ...overrides };
  const mounted = mountSettings({ document, api, transferApi, I18n }); await mounted.ready;
  return { document, mounted, api, transferApi, acks, snapshot: s => onSnapshot(s), language: l => onLanguage(l), prepare: id => onPrepare({ requestId: id }), $: id => document.getElementById(id) };
}
test('import defaults new, all counters and coverage are visible as text, provider reasons/limitations are visible', async () => {
  const f = await setup(); assert.equal(f.$('transfer-mode').value, 'new'); await f.$('transfer-preview').click();
  for (const [key, value] of Object.entries(counts)) assert.match(f.$('transfer-counts').textContent, new RegExp(String(value)));
  assert.match(f.$('transfer-coverage').textContent, /<img src=x>/); assert.equal(f.$('transfer-coverage').children.length, 0); assert.equal(f.$('transfer-apply').disabled, false);
  assert.match(f.$('transfer-capabilities').textContent, /signed-in-source-and-destination-acceptance-pending/); assert.match(f.$('transfer-capabilities').textContent, /catalog-incomplete-and-acceptance-pending/);
  f.mounted.dispose();
});
test('canceled picker clears the preview; invalid count is displayed and apply disabled', async () => {
  const f = await setup(); await f.$('transfer-preview').click(); f.transferApi.previewImport = async () => ({ ok: true, value: null }); await f.$('transfer-preview').click(); assert.equal(f.$('transfer-apply').disabled, true);
  f.transferApi.previewImport = async () => ({ ok: false, error: { code: 'invalid-transfer', messageKey: 'transfer.error.invalid-transfer' }, validation: { invalidCount: 2, issues: [] } }); await f.$('transfer-preview').click();
  assert.match(f.$('transfer-counts').textContent, /2/); assert.equal(f.$('transfer-apply').disabled, true); f.mounted.dispose();
});
test('duplicate preview shows prior profile text and a distinct create another action; profile activation stales it', async () => {
  const f = await setup({ previewImport: async () => ({ ok: true, value: { ...p, canApply: false, priorDestinations: [{ id: 'P', name: '<old profile>' }] } }) });
  await f.$('transfer-preview').click(); assert.equal(f.$('transfer-apply').disabled, true); assert.equal(f.$('transfer-another').hidden, false); assert.equal(f.$('transfer-prior').children[0].textContent, '<old profile>');
  let request; f.transferApi.applyImport = async (...args) => { request = args; return { ok: true, value: { snapshot: state(2), receipt: { counts } } }; };
  await f.$('transfer-another').click(); assert.deepEqual(request[1], { previewId: 'token', createAnother: true });
  await f.$('transfer-preview').click(); f.snapshot({ ...state(3), sessionGeneration: 'B' }); assert.equal(f.$('transfer-apply').disabled, true); f.mounted.dispose();
});
test('transfer participates in pending quit drain/freeze, preserves result, and never awaits its own preparation', async () => {
  let release; let calls = 0; const f = await setup({ previewImport: () => { calls++; return new Promise(r => { release = r; }); } });
  const pending = f.$('transfer-preview').click(); const quit = f.prepare('Q'); assert.equal(f.$('transfer-export').disabled, true); await f.$('transfer-preview').click(); assert.equal(calls, 1); assert.deepEqual(f.acks, []);
  release({ ok: true, value: structuredClone(p) }); await pending; await quit; assert.deepEqual(f.acks, [{ requestId: 'Q', ok: true }]); f.mounted.dispose();
});
test('EN/DE transfer key parity covers all outcomes, local-only attachments, add-only and pending site instructions', () => {
  for (const language of ['en', 'de']) {
    for (const key of Object.keys(counts)) assert.notEqual(I18n.t(language, 'transfer.count.' + key), 'transfer.count.' + key);
    for (const key of ['localOnly', 'addOnly', 'instructions', 'pending']) assert.notEqual(I18n.t(language, 'transfer.' + key), 'transfer.' + key);
    assert.match(I18n.t(language, 'transfer.localOnly'), /Drive/); assert.match(I18n.t(language, 'transfer.localOnly'), language === 'en' ? /portable backup/ : /portable Sicherung/);
  }
  assert.deepEqual(I18n.keys('en').sort(), I18n.keys('de').sort());
});
test('late Apply reply cannot overwrite a newer authoritative activation or report it applied there', async () => {
  const f = await setup(); await f.$('transfer-preview').click(); let release;
  f.transferApi.applyImport = () => new Promise(resolve => { release = resolve; });
  const pending = f.$('transfer-apply').click(); f.snapshot({ ...state(4), sessionGeneration: 'NEW', activeProfile: { id: 'NEW', name: 'Newer profile' } });
  release({ ok: true, value: { snapshot: state(2), receipt: { counts } } }); await pending;
  assert.equal(f.$('active-profile').textContent, 'Newer profile'); assert.notEqual(f.$('transfer-status').textContent, I18n.t('en', 'transfer.applied')); assert.equal(f.$('transfer-apply').disabled, true); f.mounted.dispose();
});
test('provider details and prior-profile label translate read/write/restore and concrete pending reasons', async () => {
  const f = await setup();
  for (const language of ['en', 'de']) {
    f.language(language);
    for (const key of ['read', 'write', 'restore']) assert.match(f.$('transfer-capabilities').textContent, new RegExp(I18n.t(language, 'transfer.' + key)));
    assert.match(f.$('transfer-capabilities').textContent, new RegExp(I18n.t(language, 'transfer.reason.fallback-save-acceptance-pending')));
    assert.equal(f.$('transfer-prior-label').textContent, I18n.t(language, 'transfer.prior'));
  }
  f.mounted.dispose();
});
for (const duplicate of [false, true]) test(`export counts replace import display only after clearing ${duplicate ? 'duplicate-profile' : 'normal'} import actions`, async () => {
  const importCounts = { ...counts, matched: 12 };
  const exportCounts = Object.fromEntries(Object.keys(counts).map(key => [key, 0]));
  const imported = { ...p, counts: importCounts, coverage: { categories: ['import-only-category'], levels: ['import-only-level'], complete: false }, canApply: !duplicate, priorDestinations: duplicate ? [{ id: 'P', name: 'Prior import' }] : [] };
  const f = await setup({ previewImport: async () => ({ ok: true, value: structuredClone(imported) }), exportProfile: async () => ({ ok: true, value: { counts: exportCounts, coverage: { categories: [], levels: [], complete: false }, decisions: [] } }) });
  await f.$('transfer-preview').click();
  assert.ok(f.$('transfer-counts').textContent.includes(I18n.t('en', 'transfer.count.matched') + ': 12'));
  assert.equal(f.$('transfer-apply').disabled, duplicate); assert.equal(f.$('transfer-another').hidden, !duplicate);
  await f.$('transfer-export').click();
  assert.ok(f.$('transfer-counts').textContent.includes(I18n.t('en', 'transfer.count.matched') + ': 0'));
  assert.doesNotMatch(f.$('transfer-coverage').textContent, /import-only-category|import-only-level/);
  assert.equal(f.$('transfer-apply').disabled, true);
  assert.equal(f.$('transfer-another').hidden, true); assert.equal(f.$('transfer-another').disabled, true);
  assert.equal(f.$('transfer-use-prior').hidden, true); assert.equal(f.$('transfer-report').disabled, true);
  await f.$('transfer-preview').click();
  assert.ok(f.$('transfer-counts').textContent.includes(I18n.t('en', 'transfer.count.matched') + ': 12'));
  assert.equal(f.$('transfer-apply').disabled, duplicate); assert.equal(f.$('transfer-another').hidden, !duplicate);
  f.mounted.dispose();
});
test('canceled export preserves the displayed import counts and their Apply authority', async () => {
  const f = await setup({ exportProfile: async () => ({ ok: true, value: null }) });
  await f.$('transfer-preview').click(); const shownCounts = f.$('transfer-counts').textContent; const shownCoverage = f.$('transfer-coverage').textContent;
  await f.$('transfer-export').click(); assert.equal(f.$('transfer-counts').textContent, shownCounts); assert.equal(f.$('transfer-coverage').textContent, shownCoverage); assert.equal(f.$('transfer-apply').disabled, false); assert.equal(f.$('transfer-report').disabled, false);
  f.mounted.dispose();
});
test('canceled beforeunload keeps settings live until committed pagehide; explicit disposal stays idempotent', async () => {
  const { EventEmitter } = require('node:events');
  const lifecycle = new EventEmitter(); const messages = new EventEmitter(); const acknowledgements = [];
  const lifecycleWindow = {
    addEventListener(type, listener, options) { if (options?.once) lifecycle.once(type, listener); else lifecycle.on(type, listener); },
    removeEventListener(type, listener) { lifecycle.removeListener(type, listener); },
  };
  const subscribe = channel => listener => { messages.on(channel, listener); return () => messages.removeListener(channel, listener); };
  const api = { getState: async () => ({ ok: true, value: state() }), command: async () => ({ ok: true, value: state(2) }), onSnapshot: subscribe('snapshot'), onLanguage: subscribe('language'), onPrepareQuit: subscribe('prepare'), onResumeAfterQuit: subscribe('resume'), quitReady: value => acknowledgements.push(value) };
  const document = dom(); const mounted = mountSettings({ document, api, I18n, window: lifecycleWindow }); await mounted.ready;
  lifecycle.emit('beforeunload', {}); // Main cancels this navigation; the same document remains.
  const updated = { ...state(2), activeProfile: { id: 'P', name: 'After canceled navigation', region: '' } };
  messages.emit('snapshot', updated); messages.emit('language', 'de'); messages.emit('prepare', { requestId: 'still-live' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('active-profile').textContent, 'After canceled navigation');
  assert.equal(document.documentElement.lang, 'de'); assert.deepEqual(acknowledgements, [{ requestId: 'still-live', ok: true }]);
  messages.emit('resume', { requestId: 'still-live' }); assert.equal(document.getElementById('create').disabled, false);
  assert.equal(messages.listenerCount('snapshot'), 1); assert.equal(messages.listenerCount('language'), 1); assert.equal(messages.listenerCount('prepare'), 1); assert.equal(messages.listenerCount('resume'), 1);
  lifecycle.emit('pagehide', {}); // The document actually exits.
  assert.deepEqual(messages.eventNames(), []); assert.equal(lifecycle.listenerCount('pagehide'), 0);
  messages.emit('snapshot', state(3)); messages.emit('language', 'en'); messages.emit('prepare', { requestId: 'after-exit' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('active-profile').textContent, 'After canceled navigation'); assert.equal(document.documentElement.lang, 'de'); assert.equal(acknowledgements.length, 1);
  mounted.dispose(); mounted.dispose();
  const reopened = mountSettings({ document: dom(), api, I18n, window: lifecycleWindow }); await reopened.ready;
  assert.equal(messages.listenerCount('prepare'), 1); reopened.dispose(); reopened.dispose();
  assert.deepEqual(messages.eventNames(), []); assert.equal(lifecycle.listenerCount('pagehide'), 0);
});
