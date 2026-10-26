'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { buildTransferScripts } = require('../../tools/build-transfer-scripts');
const { createTransferUi } = require('../../src/transfer/browser/ui');
const { makeDocument } = require('./helpers');

test('ten deterministic self-contained scripts fail closed with concrete reasons and no remote calls', async () => {
  const root = path.resolve(__dirname, '../..'); const paths = await buildTransferScripts({ root });
  assert.equal(paths.length, 10); const first = await Promise.all(paths.map(p => fs.readFile(p, 'utf8')));
  await buildTransferScripts({ root }); assert.deepEqual(await Promise.all(paths.map(p => fs.readFile(p, 'utf8'))), first);
  for (const code of first) {
    const errors = []; let remote = 0;
    const context = { console: { error: x => errors.push(x) }, fetch: () => remote++, document: { createElement: () => { throw new Error('must stop before file/UI'); } } };
    await vm.runInNewContext(code, context, { timeout: 1000 });
    assert.equal(remote, 0); assert.equal(errors.length, 1); assert.match(errors[0], /acceptance|verification|interface|catalog/);
    assert.match(errors[0], /unavailable|pending/);
  }
});

test('UI displays unavailable identity, file scope, counts and acknowledgement using text nodes', async () => {
  const document = makeDocument(); const ui = createTransferUi(document); const seen = [];
  ui.showContext({ provider: 'appsample', map: 'appsample:gim:2', accountLabel: '<img onerror=evil()>', saveLabel: 'Test save', identityKnown: false });
  assert.match(document.body.textContent, /Account identity unavailable/); assert.match(document.body.textContent, /<img onerror=evil\(\)>/);
  ui.showPreview({ context: {}, stateFingerprint: 'x', counts: { add: 2, unchanged: 3, skipped: 4 }, eligibleIds: ['42'], coverage: { complete: false, categories: ['Chests'], levels: ['surface'] } });
  assert.match(document.body.textContent, /2/); assert.match(document.body.textContent, /Chests/); assert.match(document.body.textContent, /partial/i);
  ui.onApply(() => seen.push('apply')); ui.onBackupAcknowledged(() => seen.push('ack'));
  const apply = document.find('button', 'Apply additions'); assert.equal(apply.disabled, true);
  const ack = document.find('input', null, 'checkbox'); ack.checked = true; ack.dispatch('change');
  apply.dispatch('click'); assert.deepEqual(seen, ['ack', 'apply']);
  const bytes = new Uint8Array([123, 125]); const chosen = ui.chooseFile();
  const file = document.find('input', null, 'file'); file.files = [{ size: 2, arrayBuffer: async () => bytes.buffer }]; file.dispatch('change');
  assert.deepEqual(await chosen, bytes);
  ui.dispose(); assert.equal(document.body.children.length, 0); apply.dispatch('click'); assert.deepEqual(seen, ['ack', 'apply']);
});

test('file cancel/dispose settles chooser and injection denial fails without bypass', async () => {
  const doc = makeDocument(); const ui = createTransferUi(doc);
  let pending = ui.chooseFile(); doc.find('input', null, 'file').dispatch('cancel'); assert.equal(await pending, null);
  pending = ui.chooseFile(); ui.dispose(); assert.equal(await pending, null);
  const denied = makeDocument(); denied.body.appendChild = () => { throw new Error('blocked by site'); };
  assert.throws(() => createTransferUi(denied), { code: 'ui-unavailable' });
});

test('builder rejects Node builtins or non-allowlisted dependencies before executing source', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-bundle-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve(__dirname, '../../src/transfer'), path.join(root, 'src/transfer'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/transfer/browser/runtime.js'), "require('node:crypto'); module.exports = {};\n");
  await assert.rejects(buildTransferScripts({ root }), /bundle-dependency/);
});

async function syntheticBundle(t) {
  const { makeBrowserHarness, makeTransfer } = require('./helpers');
  const { serializeTransfer } = require('../../src/transfer/envelope');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-active-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve(__dirname, '../../src/transfer'), path.join(root, 'src/transfer'), { recursive: true });
  const h = makeBrowserHarness({ provider: 'appsample' }); h.adapter.capability.variants[0].pacing.minIntervalMs = 0;
  await fs.writeFile(path.join(root, 'src/transfer/providers/appsample/capability.json'), JSON.stringify(h.adapter.capability));
  await fs.writeFile(path.join(root, 'src/transfer/providers/appsample/adapter.js'), `
    const bundledCapability=require('./capability.json');
    module.exports.createAdapter=function({window,fetch,capability}){
      const state=globalThis.synthetic;
      const inputs={pageWindow:window===globalThis.window,pageFetch:fetch===globalThis.fetch,fixedCapability:capability===bundledCapability};
      state.factoryInputs.push(inputs);
      if(!inputs.pageWindow||!inputs.pageFetch||!inputs.fixedCapability)throw new Error('invalid-provider-construction');
      return { capability,variantId:capability.variants[0].id,
        async detect(){return structuredClone(state.context);},
        async read(context){if(context.contextFingerprint!==state.context.contextFingerprint)throw new Error('context-changed');const foundIds=[...state.found].sort();return {foundIds,catalogIds:['42','43','44'],fingerprint:JSON.stringify(foundIds)};},
        async exportProgress(){return structuredClone({...state.envelope,records:[...state.found].sort().map(id=>({id,map:state.context.map,category:null,level:null,state:true,position:null}))});},
        async setFound(context,id,signal){state.writes.push(id);state.started?.();if(state.writeGate)await state.writeGate;if(state.response){const result=state.response;state.response=null;return result;}state.found.add(id);return {status:'persisted',code:'ok'};}
      };
    };`);
  const paths = await buildTransferScripts({ root }); const document = makeDocument(); const downloads = [];
  const synthetic = { context: h.context, envelope: makeTransfer({ catalog: { generation: 'synthetic-harness', fingerprint: h.context.catalogFingerprint } }), found: new Set(['44']), writes: [], clock: 0, factoryInputs: [] };
  const context = vm.createContext({ document, synthetic, fetch: () => { throw new Error('unexpected-network'); }, TextEncoder, TextDecoder, AbortController, crypto: require('node:crypto').webcrypto, performance: { now: () => synthetic.clock },
    console: { error: error => { throw new Error(error); } }, Blob: class { constructor(parts) { downloads.push(...parts); } },
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => {} }, setTimeout: (callback, ms) => { synthetic.clock += ms || 0; callback(); } });
  vm.runInContext('globalThis.window=globalThis;globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value));', context);
  const bytes = serializeTransfer(makeTransfer({ records: [{ id: '42', map: h.context.map, category: null, level: null, state: true, position: null }] }));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function runImport() {
    const execution = vm.runInContext(await fs.readFile(paths.find(p => p.endsWith('appsample-import.js')), 'utf8'), context);
    await tick(); const file = document.body.children.at(-1).children.find(node => node.tagName === 'input' && node.type === 'file');
    file.files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }]; file.dispatch('change'); await execution;
  }
  return { paths, document, context, downloads, synthetic, runImport, tick };
}

test('supported synthetic import actually chooses a file, backs up, acknowledges and writes; export is read-only', async t => {
  const h = await syntheticBundle(t); await h.runImport();
  assert.equal(h.downloads.length, 1); assert.deepEqual(h.synthetic.writes, []);
  const ack = h.document.find('input', null, 'checkbox'); ack.checked = true; ack.dispatch('change');
  h.document.find('button', 'Apply additions').dispatch('click');
  for (let n = 0; n < 30 && !h.document.body.textContent.includes('Result:'); n++) await h.tick();
  assert.deepEqual(h.synthetic.writes, ['42']); assert.match(h.document.body.textContent, /Result: complete/);
  await vm.runInContext(await fs.readFile(h.paths.find(p => p.endsWith('appsample-export.js')), 'utf8'), h.context);
  assert.deepEqual(h.synthetic.writes, ['42']); assert.equal(h.downloads.length, 3);
});

test('replacement script disposes controls and waits for an uncertain in-flight write before reopening', async t => {
  const h = await syntheticBundle(t); await h.runImport();
  let release; let started; const wrote = new Promise(resolve => { started = resolve; });
  h.synthetic.writeGate = new Promise(resolve => { release = resolve; }); h.synthetic.started = started;
  const ack = h.document.find('input', null, 'checkbox'); ack.checked = true; ack.dispatch('change'); h.document.find('button', 'Apply additions').dispatch('click');
  await wrote;
  const replacement = vm.runInContext(await fs.readFile(h.paths.find(p => p.endsWith('appsample-import.js')), 'utf8'), h.context);
  await h.tick(); assert.equal(h.document.body.children.length, 0); assert.deepEqual(h.synthetic.writes, ['42']);
  release(); for (let n = 0; n < 30 && h.document.body.children.length === 0; n++) await h.tick();
  assert.equal(h.document.body.children.length, 1);
  // Find the new chooser, since disposed node listeners no longer respond.
  h.document.body.children[0].children.find(n => n.tagName === 'input' && n.type === 'file').dispatch('cancel');
  await replacement; assert.deepEqual(h.synthetic.writes, ['42']);
});

test('generated replacements carry endpoint cooldown across an observed save switch', async t => {
  const h = await syntheticBundle(t); await h.runImport(); h.synthetic.response = { status: 'failed', code: 'rate-limited', retryAfterMs: 60000 };
  function applyPanel() { const panel = h.document.body.children[0]; const label = panel.children.find(n => n.tagName === 'label'); const ack = label.children[0]; ack.checked = true; ack.dispatch('change'); panel.children.find(n => n.tagName === 'button' && n.textContent === 'Apply additions').dispatch('click'); }
  applyPanel(); for (let n = 0; n < 30 && !h.document.body.textContent.includes('Result:'); n++) await h.tick();
  assert.deepEqual(h.synthetic.writes, ['42']); h.synthetic.context.contextFingerprint = 'new-observed-save';
  // Replacement creates another file chooser after disposing the first panel.
  const execution = vm.runInContext(await fs.readFile(h.paths.find(p => p.endsWith('appsample-import.js')), 'utf8'), h.context);
  await h.tick(); const file = h.document.body.children[0].children.find(n => n.tagName === 'input' && n.type === 'file');
  const { serializeTransfer } = require('../../src/transfer/envelope'); const { makeTransfer } = require('./helpers');
  const source = serializeTransfer(makeTransfer({ records: [{ id: '42', map: 'appsample:gim:2', category: null, level: null, state: true, position: null }] }));
  file.files = [{ size: source.length, arrayBuffer: async () => source.buffer }]; file.dispatch('change'); await execution; applyPanel();
  for (let n = 0; n < 30 && !h.document.body.textContent.includes('Result:'); n++) await h.tick();
  assert.deepEqual(h.synthetic.writes, ['42']); assert.match(h.document.body.textContent, /Result: partial/);
});

test('standalone panel selects German from document/browser language with English fallback and safe labels', () => {
  for (const [documentLanguage, browserLanguage, german] of [['de-DE', 'en-US', true], ['', 'de-AT', true], ['fr', 'de', false], ['', 'es', false]]) {
    const document = makeDocument(); document.documentElement = { lang: documentLanguage }; document.defaultView = { navigator: { language: browserLanguage } };
    const ui = createTransferUi(document);
    ui.showContext({ provider: 'appsample', map: 'appsample:gim:2', saveLabel: '<script>untrusted()</script>', accountLabel: null, identityKnown: false });
    ui.showPreview({ counts: { add: 1, unchanged: 0, skipped: 0 }, coverage: { complete: false, categories: ['<b>Chests</b>'], levels: [] } });
    assert.match(document.body.textContent, german ? /Kontoidentität nicht verfügbar/ : /Account identity unavailable/);
    assert.ok(document.find('button', german ? 'Ergänzungen anwenden' : 'Apply additions'));
    assert.match(document.body.textContent, /<script>untrusted\(\)<\/script>/); assert.match(document.body.textContent, /<b>Chests<\/b>/);
    ui.showError('resume-required'); assert.match(document.body.textContent, german ? /Warte/ : /Wait/); ui.dispose();
  }
});

test('provider construction uses createAdapter with page window/fetch and the bundled fixed capability for both directions', async t => {
  const h = await syntheticBundle(t);
  await vm.runInContext(await fs.readFile(h.paths.find(p => p.endsWith('appsample-export.js')), 'utf8'), h.context);
  assert.deepEqual(h.synthetic.factoryInputs.map(value => ({ ...value })), [{ pageWindow: true, pageFetch: true, fixedCapability: true }]);
  await h.runImport();
  assert.deepEqual(h.synthetic.factoryInputs.map(value => ({ ...value })), [
    { pageWindow: true, pageFetch: true, fixedCapability: true },
    { pageWindow: true, pageFetch: true, fixedCapability: true },
  ]);
  assert.deepEqual(h.synthetic.writes, []);
});
