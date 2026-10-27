'use strict';

const { PROVIDER_IDS, validateCapability } = require('./capabilities');

// Static imports are inspectable and can be bundled without a dynamic loader.
const records = [
  require('./providers/appsample/capability.json'),
  require('./providers/hoyolab/capability.json'),
  require('./providers/mapgenie/capability.json'),
  require('./providers/kongying/capability.json'),
  require('./providers/bwiki/capability.json'),
].map(validateCapability);

/** @returns {import('./capabilities').ProviderCapability[]} */
function listProviders() { return structuredClone(records); }

/** @param {import('./capabilities').ProviderId} id @returns {import('./capabilities').ProviderCapability} */
function getProvider(id) {
  const index = PROVIDER_IDS.indexOf(id);
  if (index < 0) throw Object.assign(new Error('unknown-provider'), { code: 'unknown-provider' });
  return structuredClone(records[index]);
}

module.exports = { listProviders, getProvider };
