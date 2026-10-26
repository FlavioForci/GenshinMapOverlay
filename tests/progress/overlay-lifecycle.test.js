'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ProgressView = require('../../src/overlay/progress-view');
const I18n = require('../../src/shared/i18n');

test('production overlay retains drain ACK/resume after canceled navigation and cleans up once on committed exit', async () => {
  const lifecycle = new EventEmitter(); const messages = new EventEmitter(); const acks = []; const disposed = [];
  const subscribe = channel => listener => {
    messages.on(channel, listener);
    return () => { disposed.push(channel); messages.removeListener(channel, listener); };
  };
  const snapshot = { viewVersion: 1, sessionGeneration: 'A', activeProfile: { id: 'P', foundIds: [], enabledTypes: [], hideFound: false }, sync: { phase: 'local' } };
  const api = { on: (channel, listener) => subscribe(channel)(listener), onPrepareQuit: subscribe('prepare'), onResumeAfterQuit: subscribe('resume'), quitReady: value => acks.push(structuredClone(value)), getProgress: async () => ({ ok: true, value: snapshot }) };
  // The actual overlay script and ProgressView run; only browser DOM/canvas and
  // Electron messages are simulated. IDs come from the production document.
  const nodes = new Map();
  for (const match of fs.readFileSync(require.resolve('../../src/overlay/index.html'), 'utf8').matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(match[1], { style: { setProperty() {} }, dataset: {}, classList: { toggle() {}, remove() {} }, addEventListener() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }), getContext: () => ({ setTransform() {} }) });
  }
  const window = { overlayApi: api, addEventListener(type, listener, options) { if (options?.once) lifecycle.once(type, listener); else lifecycle.on(type, listener); } };
  const document = { getElementById: id => nodes.get(id), querySelectorAll: () => [], querySelector: () => null, documentElement: {} };
  const filename = require.resolve('../../src/overlay/overlay');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { window, document, ProgressView, I18n, innerWidth: 1920, innerHeight: 1080, requestAnimationFrame() {}, IntersectionObserver: class {}, setTimeout, clearTimeout }, { filename });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('hide-found').disabled, false);
  lifecycle.emit('beforeunload', {}); // Main cancels the navigation, retaining this document.
  messages.emit('prepare', { requestId: 'after-canceled-navigation' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(acks, [{ requestId: 'after-canceled-navigation', ok: true }]);
  assert.equal(nodes.get('hide-found').disabled, true);
  messages.emit('resume', { requestId: 'wrong-request' }); assert.equal(nodes.get('hide-found').disabled, true);
  messages.emit('resume', { requestId: 'after-canceled-navigation' }); assert.equal(nodes.get('hide-found').disabled, false);
  messages.emit('prepare', { requestId: 'next-operation' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(acks, [{ requestId: 'after-canceled-navigation', ok: true }, { requestId: 'next-operation', ok: true }]);
  messages.emit('resume', { requestId: 'next-operation' }); assert.equal(nodes.get('hide-found').disabled, false);
  lifecycle.emit('pagehide', {}); lifecycle.emit('pagehide', {});
  assert.deepEqual(disposed, ['prepare', 'resume']); assert.equal(messages.listenerCount('prepare'), 0); assert.equal(messages.listenerCount('resume'), 0);
  messages.emit('prepare', { requestId: 'after-exit' }); messages.emit('resume', { requestId: 'after-exit' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(acks.length, 2); assert.equal(lifecycle.listenerCount('pagehide'), 0);
});
