'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserTransfer } = require('../../src/transfer/browser/runtime');
const { makeBrowserHarness, makeTransfer } = require('./helpers');
const { serializeTransfer, parseTransfer } = require('../../src/transfer/envelope');

function setup(options = {}) {
  const harness = makeBrowserHarness({ provider: 'appsample', ...options });
  return { ...harness, runner: createBrowserTransfer(harness) };
}
function input(h, ids = ['42', '43'], overrides = {}) {
  return serializeTransfer(makeTransfer({ provider: h.context.provider, map: h.context.map,
    catalog: { generation: 'synthetic-harness', fingerprint: h.context.catalogFingerprint },
    records: ids.map(id => ({ id, map: h.context.map, category: null, level: null, state: true, position: null })), ...overrides }));
}
const signal = () => new AbortController().signal;
function accounted(receipt, ids) {
  const all = [...receipt.confirmed, ...receipt.unchanged, ...receipt.skipped.map(x => x.id), ...receipt.failed.map(x => x.id), ...receipt.uncertain];
  assert.deepEqual(all.sort(), [...ids].sort()); assert.equal(new Set(all).size, all.length);
}

test('backup request and explicit acknowledgement precede writes; receipt preserves destination-only IDs', async () => {
  const h = setup({ foundIds: ['44'] });
  const preview = await h.runner.preview(input(h));
  assert.deepEqual(preview.counts, { add: 2, unchanged: 0, skipped: 0 });
  assert.equal(h.downloads.length, 1); assert.deepEqual(parseTransfer(h.downloads[0].bytes).records.map(r => r.id), ['44']);
  await assert.rejects(h.runner.apply(signal()), { code: 'backup-acknowledgement-required' });
  assert.equal(h.writes.length, 0); h.runner.acknowledgeBackup();
  const receipt = await h.runner.apply(signal());
  assert.equal(receipt.status, 'complete'); assert.deepEqual(receipt.confirmed, ['42', '43']);
  assert.deepEqual((await h.adapter.read(h.context)).foundIds, ['42', '43', '44']);
  accounted(receipt, ['42', '43']); assert.equal(h.now(), 1000);
});

for (const change of ['context', 'state', 'catalog', 'logout', 'generation', 'identity']) test(`${change} change invalidates preview before writes`, async () => {
  const h = setup(); await h.runner.preview(input(h)); h.runner.acknowledgeBackup();
  if (change === 'context') h.context.contextFingerprint = 'another-save';
  if (change === 'state') await h.adapter.setFound(h.context, '44', signal());
  if (change === 'catalog') h.context.catalogFingerprint = 'b'.repeat(64);
  if (change === 'logout' || change === 'identity') h.context.identityKnown = false;
  if (change === 'generation') h.context.contextFingerprint = 'new-site-generation';
  h.writes.length = 0;
  await assert.rejects(h.runner.apply(signal())); assert.equal(h.writes.length, 0);
  await assert.rejects(h.runner.apply(signal())); assert.equal(h.writes.length, 0);
});

test('absent observable identity is displayed and disables writes', async () => {
  const h = setup(); h.context.identityKnown = false;
  await assert.rejects(h.runner.preview(input(h)), { code: 'identity-unavailable' });
  assert.equal(h.events.find(e => e.type === 'context').value.identityKnown, false);
  assert.equal(h.writes.length, 0); assert.equal(h.downloads.length, 0);
});

for (const [name, overrides] of [
  ['provider', { provider: 'hoyolab' }], ['map', { map: 'another-map', records: [] }],
  ['catalog', { catalog: { generation: 'native-projection', fingerprint: 'b'.repeat(64) } }],
  ['unverified', { catalog: { generation: 'unverified', fingerprint: 'unverified' } }],
]) test(`wrong ${name} file fails before backup or mutation`, async () => {
  const h = setup(); await assert.rejects(h.runner.preview(input(h, ['42'], overrides)));
  assert.equal(h.downloads.length, 0); assert.equal(h.writes.length, 0);
});

test('failed preview replaces an earlier acknowledgement and apply authority', async () => {
  const h = setup(); await h.runner.preview(input(h)); h.runner.acknowledgeBackup();
  await assert.rejects(h.runner.preview(new Uint8Array([0])));
  await assert.rejects(h.runner.apply(signal())); assert.equal(h.writes.length, 0);
});

test('partial scope excludes unknown IDs and false records without clearing anything', async () => {
  const h = setup({ foundIds: ['43', '44'] });
  const data = parseTransfer(input(h, ['42', '43', 'missing'])); data.records.push({ ...data.records[0], id: '44', state: false });
  const p = await h.runner.preview(serializeTransfer(data)); assert.deepEqual(p.counts, { add: 1, unchanged: 1, skipped: 2 });
  h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(r.skipped, [{ id: 'missing', reason: 'outside-catalog' }, { id: '44', reason: 'not-found-observation' }]);
  assert.deepEqual(r.unchanged, ['43']); assert.deepEqual(r.confirmed, ['42']); accounted(r, ['42', '43', 'missing', '44']);
});

test('timeout after persisted write uses fresh durable readback and never repeats write', async () => {
  const h = setup({ failures: { '42': ['uncertain'] } });
  await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(r.confirmed, ['42']); assert.deepEqual(h.writes, ['42']); assert.equal(r.status, 'complete');
});

test('unknown bodies and memory-only success never become confirmed', async () => {
  for (const response of [{ status: 'mystery', code: 'html-response' }, { status: 'persisted', code: 'ok' }]) {
    const h = setup(); h.adapter.setFound = async () => response;
    await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
    assert.equal(r.status, 'partial'); assert.deepEqual(r.confirmed, []); assert.deepEqual(r.uncertain, ['42']); accounted(r, ['42']);
  }
});

test('denied readback after write retains uncertainty and stops remaining writes', async () => {
  const h = setup(); const read = h.adapter.read; const write = h.adapter.setFound;
  h.adapter.setFound = async (...args) => { const value = await write(...args); h.adapter.read = async () => { throw new Error('private data must not leak'); }; return value; };
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(r.uncertain, ['42']); assert.deepEqual(r.skipped, [{ id: '43', reason: 'readback-unavailable' }]);
  assert.equal(r.status, 'partial'); assert.deepEqual(h.writes, ['42']); h.adapter.read = read;
});

for (const change of ['cancel', 'logout', 'save-switch', 'catalog-switch']) test(`mid-run ${change} accounts for confirmed and remaining records`, async () => {
  const h = setup(); const abort = new AbortController(); const write = h.adapter.setFound;
  h.adapter.setFound = async (...args) => {
    const value = await write(...args);
    if (change === 'cancel') abort.abort();
    if (change === 'logout') h.context.identityKnown = false;
    if (change === 'save-switch') h.context.contextFingerprint = 'save-b';
    if (change === 'catalog-switch') h.context.catalogFingerprint = 'b'.repeat(64);
    return value;
  };
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(abort.signal);
  assert.equal(r.status, change === 'cancel' ? 'canceled' : 'partial');
  if (change === 'cancel') { assert.deepEqual(r.confirmed, ['42']); assert.deepEqual(r.skipped, [{ id: '43', reason: 'canceled' }]); }
  else { assert.deepEqual(r.uncertain, ['42']); assert.deepEqual(r.skipped, [{ id: '43', reason: 'context-changed' }]); }
  assert.deepEqual(h.writes, ['42']); accounted(r, ['42', '43']);
});

test('transient retries read fresh state and obey measured pacing with bounded attempts', async () => {
  const h = setup({ failures: { '42': [{ status: 'failed', code: 'transient' }, { status: 'failed', code: 'transient' }, { status: 'failed', code: 'transient' }] } });
  await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(h.writes, ['42', '42', '42']); assert.equal(h.now(), 3000);
  assert.deepEqual(r.failed, [{ id: '42', code: 'transient' }]); assert.equal(r.status, 'partial');
});

test('429 Retry-After is honored; beyond backoff bound pauses with resume instruction', async () => {
  for (const retryAfterMs of [5000, 31000]) {
    const h = setup({ failures: { '42': [{ status: 'failed', code: 'rate-limited', retryAfterMs }] } });
    await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
    if (retryAfterMs === 5000) { assert.deepEqual(r.confirmed, ['42', '43']); assert.equal(h.now(), 6000); }
    else { assert.deepEqual(h.writes, ['42']); assert.deepEqual(r.failed, [{ id: '42', code: 'retry-after-exceeds-bound' }]); assert.deepEqual(r.skipped, [{ id: '43', reason: 'resume-required' }]); assert.ok(h.events.some(e => e.type === 'error' && e.value === 'resume-required')); }
  }
});

test('resume uses fresh state, never stale confirmations, and validates receipt binding', async () => {
  const h = setup(); const abort = new AbortController(); const write = h.adapter.setFound;
  h.adapter.setFound = async (...args) => { const value = await write(...args); abort.abort(); return value; };
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const receipt = await h.runner.apply(abort.signal);
  h.adapter.setFound = write;
  await assert.rejects(h.runner.resume({ ...receipt, contextFingerprint: 'another-account' }, signal()), { code: 'receipt-mismatch' });
  h.writes.length = 0; const resumed = await h.runner.resume(receipt, signal());
  assert.deepEqual(resumed.unchanged, ['42']); assert.deepEqual(resumed.confirmed, ['43']); assert.deepEqual(h.writes, ['43']);
  assert.equal(resumed.status, 'complete'); accounted(resumed, ['42', '43']);
});

test('lost cloud persistence is re-added on fresh-state resume instead of trusting receipt', async () => {
  const h = setup(); await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const receipt = await h.runner.apply(signal());
  await h.adapter.restoreProgress(h.context, makeTransfer({ records: [] }), signal());
  h.writes.length = 0; const resumed = await h.runner.resume(receipt, signal());
  assert.deepEqual(resumed.confirmed, ['42']); assert.deepEqual(h.writes, ['42']);
});

test('concurrent apply and duplicate reruns cannot overlap writes', async () => {
  const h = setup(); await h.runner.preview(input(h)); h.runner.acknowledgeBackup();
  const first = h.runner.apply(signal()); await assert.rejects(h.runner.apply(signal()), { code: 'transfer-busy' });
  await first; const again = await h.runner.apply(signal()).catch(e => e);
  assert.equal(again.code, 'preview-required'); assert.deepEqual(h.writes, ['42', '43']);
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(r.unchanged, ['42', '43']); assert.deepEqual(h.writes, ['42', '43']);
});

test('backup download failure and unverified capability cannot authorize apply or restore', async () => {
  const h = setup(); const runner = createBrowserTransfer({ ...h, download: async () => { throw new Error('secret'); } });
  await assert.rejects(runner.preview(input(h)), { code: 'backup-download-failed' }); runner.acknowledgeBackup();
  await assert.rejects(runner.apply(signal())); assert.equal(h.writes.length, 0); assert.equal(typeof runner.restoreProgress, 'undefined');
  h.adapter.capability.status = 'planned'; h.adapter.capability.reasonCode = 'pending';
  await assert.rejects(h.runner.preview(input(h))); assert.equal(h.writes.length, 0);
});

test('export reads and requests a validated credential-free download without writes', async () => {
  const h = setup({ foundIds: ['42'] }); await h.runner.exportProgress();
  assert.deepEqual(parseTransfer(h.downloads[0].bytes).records.map(r => r.id), ['42']); assert.equal(h.writes.length, 0);
});

test('final durable read reconciles progress lost after an earlier per-ID confirmation', async () => {
  const h = setup(); const write = h.adapter.setFound; const restore = h.adapter.restoreProgress;
  h.adapter.setFound = async (...args) => {
    const response = await write(...args);
    if (args[1] === '43') await restore(h.context, makeTransfer({ records: [{ id: '43', map: h.context.map, category: null, level: null, state: true, position: null }] }), signal());
    return response;
  };
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.equal(r.status, 'partial'); assert.deepEqual(r.confirmed, ['43']); assert.deepEqual(r.uncertain, ['42']); accounted(r, ['42', '43']);
});

test('adapter version or selected variant changes invalidate prior preview authority', async () => {
  for (const change of ['version', 'variant']) {
    const h = setup(); await h.runner.preview(input(h)); h.runner.acknowledgeBackup();
    if (change === 'version') h.adapter.capability.adapterVersion = '0.2.0';
    else { const other = structuredClone(h.adapter.capability.variants[0]); other.id = 'other-variant'; h.adapter.capability.variants.push(other); h.adapter.variantId = other.id; }
    await assert.rejects(h.runner.apply(signal()), { code: 'adapter-changed' }); assert.equal(h.writes.length, 0);
  }
});

test('receipt from an old transfer cannot resume a new file, and fresh runner requires backup ack', async () => {
  const h = setup(); await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  await h.runner.preview(input(h, ['43'])); h.runner.acknowledgeBackup();
  await assert.rejects(h.runner.resume(r, signal()), { code: 'receipt-mismatch' });
  const other = createBrowserTransfer(h); await assert.rejects(other.resume(r, signal()), { code: 'preview-required' });
  await other.preview(input(h, ['42'])); await assert.rejects(other.resume(r, signal()), { code: 'backup-acknowledgement-required' });
  other.acknowledgeBackup(); const result = await other.resume(r, signal()); assert.deepEqual(result.unchanged, ['42']);
});

test('ambiguous non-persisted timeout retries only after a fresh durable read', async () => {
  const h = setup(); const write = h.adapter.setFound; const read = h.adapter.read; let reads = 0; let attempts = 0; let beforeRetry = 0;
  h.adapter.read = async (...args) => { reads++; return read(...args); };
  h.adapter.setFound = async (...args) => {
    attempts++;
    if (attempts === 1) { beforeRetry = reads; throw new Error('timeout'); }
    assert.ok(reads > beforeRetry); return write(...args);
  };
  await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.equal(attempts, 2); assert.deepEqual(r.confirmed, ['42']);
});

test('cancel during pacing or asynchronous read prevents the next write', async () => {
  const h = setup(); const abort = new AbortController();
  const runner = createBrowserTransfer({ ...h, sleep: async ms => { await h.sleep(ms); abort.abort(); } });
  await runner.preview(input(h)); runner.acknowledgeBackup(); const r = await runner.apply(abort.signal);
  assert.deepEqual(h.writes, ['42']); assert.equal(r.status, 'canceled'); accounted(r, ['42', '43']);
});

test('rate-limit cooldown survives exhausted attempts before the next ID', async () => {
  const h = setup({ failures: { '42': [
    { status: 'failed', code: 'transient' }, { status: 'failed', code: 'transient' },
    { status: 'failed', code: 'rate-limited', retryAfterMs: 5000 },
  ] } });
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.equal(h.now(), 8000); assert.deepEqual(r.failed, [{ id: '42', code: 'rate-limited' }]); assert.deepEqual(r.confirmed, ['43']);
});

test('resume cannot bypass a server Retry-After longer than the backoff bound', async () => {
  const h = setup({ failures: { '42': [{ status: 'failed', code: 'rate-limited', retryAfterMs: 31000 }] } });
  await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const receipt = await h.runner.apply(signal());
  const paused = await h.runner.resume(receipt, signal());
  assert.deepEqual(h.writes, ['42']); assert.equal(paused.status, 'partial'); assert.deepEqual(paused.skipped, [{ id: '42', reason: 'resume-required' }]);
  await h.sleep(1001); const resumed = await h.runner.resume(paused, signal());
  assert.deepEqual(resumed.confirmed, ['42']); assert.equal(h.now(), 31000);
});

test('selected unverified variant cannot inherit another variant persistence proof', async () => {
  const { getProvider } = require('../../src/transfer/registry');
  const h = setup(); const unverified = getProvider('appsample').variants[0]; unverified.id = 'unverified-other';
  h.adapter.capability.variants.push(unverified); h.adapter.variantId = unverified.id;
  await assert.rejects(h.runner.preview(input(h)), { code: 'adapter-unverified' }); assert.deepEqual(h.writes, []);
});

test('invalid destination backup never yields apply authority and source duplicates add once', async () => {
  const h = setup(); const envelope = parseTransfer(input(h, ['42'])); envelope.records.push({ ...envelope.records[0] });
  await h.runner.preview(serializeTransfer(envelope)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(h.writes, ['42']); accounted(r, ['42']);
  const other = setup(); const exportProgress = other.adapter.exportProgress;
  other.adapter.exportProgress = async (...args) => ({ ...await exportProgress(...args), accessToken: 'never-export-this' });
  await assert.rejects(other.runner.preview(input(other)), { code: 'backup-unavailable' });
  assert.equal(other.downloads.length, 0); assert.deepEqual(other.writes, []);
});

test('injected cooldown survives replacement and account/save change and cannot be reset by receipt input', async () => {
  const h = setup({ failures: { '42': [{ status: 'failed', code: 'rate-limited', retryAfterMs: 61000 }] } });
  const pacingState = { notBefore: 0, lastWriteAt: null };
  const first = createBrowserTransfer({ ...h, pacingState }); await first.preview(input(h, ['42'])); first.acknowledgeBackup();
  await first.apply(signal()); await first.dispose();
  h.context.contextFingerprint = 'different-observable-save';
  const second = createBrowserTransfer({ ...h, pacingState }); await second.preview(input(h, ['42'])); second.acknowledgeBackup();
  const paused = await second.apply(signal()); assert.equal(paused.status, 'partial'); assert.deepEqual(h.writes, ['42']);
  const again = await second.resume({ ...paused, pacingState: { notBefore: 0 }, confirmed: ['injected-id'] }, signal());
  assert.deepEqual(h.writes, ['42']); assert.deepEqual(again.skipped, [{ id: '42', reason: 'resume-required' }]);
  await h.sleep(61000); const completed = await second.resume(again, signal()); assert.deepEqual(completed.confirmed, ['42']);
});

test('invalid pacing state is rejected; a valid future deadline never becomes an early write', async () => {
  const h = setup();
  for (const pacingState of [{ notBefore: NaN, lastWriteAt: null }, { notBefore: -1, lastWriteAt: null }, { notBefore: 0, lastWriteAt: Infinity }]) {
    assert.throws(() => createBrowserTransfer({ ...h, pacingState }), { code: 'invalid-pacing-state' });
  }
  const runner = createBrowserTransfer({ ...h, pacingState: { notBefore: 90000, lastWriteAt: null } });
  await runner.preview(input(h, ['42'])); runner.acknowledgeBackup(); const r = await runner.apply(signal());
  assert.deepEqual(h.writes, []); assert.equal(h.now(), 0); assert.deepEqual(r.skipped, [{ id: '42', reason: 'resume-required' }]);
});

test('verified terminal adapter reason stays failed while malformed body codes remain uncertain', async () => {
  for (const [code, expected] of [['save-limit-reached', 'failed'], ['secret token <html>', 'uncertain']]) {
    const h = setup(); h.adapter.setFound = async () => ({ status: 'failed', code });
    await h.runner.preview(input(h, ['42'])); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
    if (expected === 'failed') assert.deepEqual(r.failed, [{ id: '42', code: 'save-limit-reached' }]);
    else { assert.deepEqual(r.uncertain, ['42']); assert.equal(JSON.stringify(r).includes('secret token'), false); }
    assert.equal(r.status, 'partial');
  }
});

for (const [response, stopped] of [[{ status: 'mystery', code: 'html' }, 'unknown-response'], [{ status: 'failed', code: 'access-denied' }, 'access-denied'], [{ status: 'failed', code: 'authentication-required' }, 'authentication-required']]) test(`unconfirmed ${stopped} aborts remaining writes with a disjoint receipt`, async () => {
  const h = setup(); h.adapter.setFound = async (context, id) => { h.writes.push(id); return response; };
  await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
  assert.deepEqual(h.writes, ['42']); assert.deepEqual(r.skipped, [{ id: '43', reason: stopped }]);
  assert.equal(r.status, 'partial'); accounted(r, ['42', '43']);
});

test('thrown denial stops after readback; denied response stops even when concurrent progress is visible', async () => {
  for (const persisted of [false, true]) {
    const h = setup(); const write = h.adapter.setFound;
    h.adapter.setFound = async (...args) => {
      if (persisted) { await write(...args); return { status: 'failed', code: 'access-denied' }; }
      h.writes.push(args[1]); throw Object.assign(new Error('sensitive response'), { code: 'access-denied' });
    };
    await h.runner.preview(input(h)); h.runner.acknowledgeBackup(); const r = await h.runner.apply(signal());
    assert.deepEqual(h.writes, ['42']); assert.deepEqual(r.skipped, [{ id: '43', reason: 'access-denied' }]);
    assert.deepEqual(persisted ? r.confirmed : r.uncertain, ['42']); assert.equal(JSON.stringify(r).includes('sensitive'), false);
  }
});
