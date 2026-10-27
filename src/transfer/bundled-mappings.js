'use strict';
const { rebaseMapping } = require('./source-mapping');

// Fixed reviewed local assets. Import files cannot supply mappings or paths.
const bundles = [
  [require('./providers/hoyolab/mapping.json'), require('./providers/hoyolab/mapping-targets.json')],
  [require('./providers/kongying/mapping.json'), require('./providers/kongying/mapping-targets.json')],
  [require('./providers/bwiki/mapping.json'), require('./providers/bwiki/mapping-targets.json')],
];

function createMappingResolver(getCatalog) {
  const cache = new Map(); let fingerprint = null;
  return (provider, map) => {
    const catalog = getCatalog();
    if (!catalog) return null;
    if (catalog.fingerprint !== fingerprint) { cache.clear(); fingerprint = catalog.fingerprint; }
    const bundle = bundles.find(([pack]) => pack.provider === provider && pack.map === map);
    if (!bundle) return null;
    const key = provider + ':' + map;
    if (!cache.has(key)) cache.set(key, rebaseMapping(bundle[0], bundle[1], catalog));
    return cache.get(key);
  };
}

module.exports = { createMappingResolver };
