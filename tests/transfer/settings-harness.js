'use strict';
const fs = require('node:fs');
class Element {
  constructor() { this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.handlers = {}; this.dataset = {}; this.textContent = ''; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, cb) { this.handlers[type] = cb; }
  removeEventListener(type) { delete this.handlers[type]; }
  click() { if (!this.disabled) return this.handlers.click?.({ target: this }); }
  change() { return this.handlers.change?.({ target: this }); }
  set innerHTML(_) { throw new Error('HTML injection is forbidden'); }
}
// Build the test controls from the production HTML IDs/translation attributes,
// so a misspelled or absent production control cannot silently appear in tests.
function makeSettingsDocument() {
  const nodes = new Map(); const translated = [];
  const html = fs.readFileSync(require.resolve('../../src/settings/index.html'), 'utf8');
  for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[0])?.[1];
    const key = /\bdata-i18n="([^"]+)"/.exec(match[0])?.[1];
    const el = new Element();
    if (id) nodes.set(id, el);
    if (key) { el.dataset.i18n = key; translated.push(el); }
  }
  return { getElementById: id => nodes.get(id) || null, createElement: () => new Element(), querySelectorAll: selector => selector === '[data-i18n]' ? translated : [], documentElement: {} };
}
module.exports = { makeSettingsDocument };
