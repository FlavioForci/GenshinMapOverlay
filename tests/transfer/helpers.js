'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getProvider } = require('../../src/transfer/registry');
const { PROVIDER_IDS } = require('../../src/transfer/capabilities');

/** @typedef {{format:'genshin-map-overlay.transfer',version:1,producer:{name:string,version:string},exportedAt:string,provider:import('../../src/transfer/capabilities').ProviderId,adapterVersion:string,map:string,catalog:{generation:string,fingerprint:string},coverage:{categories:string[],levels:string[],complete:boolean},records:import('../../tools/transfer/catalog-report').TransferRecord[]}} TransferEnvelope */

/** Read only an explicitly named small, sanitized fixture. */
function fixture(provider, name) {
  if (!PROVIDER_IDS.includes(provider) || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid-fixture');
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', provider, name + '.json'), 'utf8'));
}

/** @param {object} [overrides] @returns {TransferEnvelope} */
function makeTransfer(overrides = {}) {
  return structuredClone({
    format: 'genshin-map-overlay.transfer', version: 1,
    producer: { name: 'synthetic-test', version: '0.1.0' },
    exportedAt: '2000-01-01T00:00:00.000Z', provider: 'appsample', adapterVersion: '0.1.0',
    map: 'appsample:gim:2', catalog: { generation: 'synthetic-catalog', fingerprint: 'a'.repeat(64) },
    coverage: { categories: [], levels: [], complete: false }, records: [],
    ...overrides,
  });
}

/** Deterministic, wholly synthetic Task 5 adapter/UI/time harness. No browser or credentials.
 * A queued 'uncertain' outcome persists before responding, to model an ambiguous timeout.
 * Queued 'failed' outcomes do not persist. Later runtime tests can extend this harness.
 */
function makeBrowserHarness({ provider, foundIds = [], failures = {} }) {
  const capability = getProvider(provider);
  const variant = capability.variants[0];
  capability.variants = [variant];
  capability.status = 'supported'; capability.reasonCode = null;
  Object.assign(variant, {
    generation: 'synthetic-harness', browser: { family: 'chromium', version: 'synthetic-harness' },
    catalogFingerprint: 'a'.repeat(64), read: 'verified', write: 'verified', restore: 'verified', reasonCode: null,
    accountTier: variant.accountTier === 'unverified' ? (provider === 'mapgenie' ? 'website-free' : 'website-account') : variant.accountTier,
    pacing: { batchSize: 1, minIntervalMs: 1000, maxAttempts: 3, maxBackoffMs: 30000 },
    evidence: { checkedAt: '2000-01-01', read: true, write: true, reload: true, destinationOnlyPreserved: true, pairAccepted: true, restore: true },
  });
  const context = { provider, map: variant.map, catalogFingerprint: variant.catalogFingerprint, contextFingerprint: 'synthetic-context-0', accountLabel: null, saveLabel: 'Synthetic local test save', identityKnown: true };
  const found = new Set(foundIds);
  const catalogIds = [...new Set(['42', '43', '44', ...foundIds, ...Object.keys(failures)])].sort();
  const pending = Object.fromEntries(Object.entries(failures).map(([id, values]) => [id, [...values]]));
  const events = []; const downloads = []; const writes = [];
  const listeners = { apply: new Set(), cancel: new Set(), backupAcknowledged: new Set() };
  let clock = 0;
  const fingerprint = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const check = captured => {
    if (!context.identityKnown || captured.contextFingerprint !== context.contextFingerprint || captured.catalogFingerprint !== context.catalogFingerprint || captured.map !== context.map || captured.provider !== context.provider) throw Object.assign(new Error('context-changed'), { code: 'context-changed' });
  };
  const envelope = () => makeTransfer({ provider, map: context.map, catalog: { generation: 'synthetic-harness', fingerprint: context.catalogFingerprint }, records: [...found].sort().map(id => ({ id, map: context.map, category: null, level: null, state: true, position: null })) });
  const adapter = {
    capability, variantId: variant.id, pacing: variant.pacing,
    async detect() { return structuredClone(context); },
    async read(captured) { check(captured); const foundIds = [...found].sort(); return { foundIds, fingerprint: fingerprint(foundIds), catalogIds: [...catalogIds] }; },
    async exportProgress(captured) { check(captured); return envelope(); },
    async setFound(captured, id, signal) {
      check(captured); signal?.throwIfAborted(); writes.push(id);
      const result = pending[id]?.shift() ?? 'persisted';
      if (result instanceof Error) throw result;
      const status = typeof result === 'string' ? result : result.status;
      if (status === 'persisted' || status === 'uncertain') found.add(id);
      return typeof result === 'object' ? structuredClone(result) : { status, code: status === 'persisted' ? 'ok' : 'synthetic-' + status };
    },
    async restoreProgress(captured, backup, signal) {
      check(captured); signal?.throwIfAborted();
      if (backup.provider !== provider || backup.map !== context.map) throw new Error('wrong-scope');
      found.clear(); for (const record of backup.records) if (record.state) found.add(record.id);
    },
  };
  const addListener = (event, callback) => { listeners[event].add(callback); return () => listeners[event].delete(callback); };
  const show = type => value => events.push({ type, value: structuredClone(value) });
  const ui = {
    async chooseFile() { return null; },
    showContext: show('context'), showPreview: show('preview'), showProgress: show('progress'), showReceipt: show('receipt'), showError: show('error'),
    onApply: callback => addListener('apply', callback), onCancel: callback => addListener('cancel', callback), onBackupAcknowledged: callback => addListener('backupAcknowledged', callback),
    dispose() { for (const callbacks of Object.values(listeners)) callbacks.clear(); },
  };
  return {
    adapter, ui, context, events, downloads, writes,
    async download(name, bytes) { downloads.push({ name, bytes: Uint8Array.from(bytes) }); },
    async sleep(ms) { if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('invalid-time'); clock += ms; },
    now: () => clock,
    emit(event) { for (const callback of listeners[event]) callback(); },
  };
}

/** Minimal eventful DOM for testing our UI's controls and text rendering, not browser layout. */
function makeDocument() {
  const nodes = [];
  function element(tagName) {
    const handlers = new Map(); let ownText = '';
    const node = {
      tagName, children: [], parentNode: null, disabled: false, checked: false, files: [], style: {},
      set textContent(value) { ownText = String(value); this.children = []; },
      get textContent() { return ownText + this.children.map(child => child.textContent).join(''); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, callback) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(callback); },
      removeEventListener(type, callback) { handlers.get(type)?.delete(callback); },
      dispatch(type) { if (this.disabled) return; for (const callback of handlers.get(type) || []) callback({ target: this }); },
      click() { this.dispatch('click'); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; },
    };
    nodes.push(node); return node;
  }
  return { createElement: element, body: element('body'), find: (tag, text, type) => nodes.find(n => n.tagName === tag && (text === null || n.textContent === text) && (!type || n.type === type)) };
}
module.exports = { fixture, makeTransfer, makeBrowserHarness, makeDocument };
