'use strict';

/** @typedef {'appsample'|'hoyolab'|'mapgenie'|'kongying'|'bwiki'} ProviderId */
/** @typedef {'unverified'|'verified'|'unavailable'} Verification */
/** @typedef {{checkedAt:string,read:boolean,write:boolean,reload:boolean,destinationOnlyPreserved:boolean,pairAccepted:boolean,restore:boolean}} CapabilityEvidence */
/** @typedef {{id:string,origins:string[],map:string,generation:string,accountTier:string,browser:{family:'chromium'|'firefox',version:string},catalogFingerprint:string,read:Verification,write:Verification,restore:Verification,pacing:{batchSize:number,minIntervalMs:number,maxAttempts:3,maxBackoffMs:30000}|null,endpoints:Array<{method:string,origin:string,path:string}>,statePaths:string[],evidence:CapabilityEvidence,reasonCode:string|null}} ProviderVariant */
/** @typedef {{provider:ProviderId,adapterVersion:string,status:'planned'|'unavailable'|'supported',variants:ProviderVariant[],reasonCode:string|null}} ProviderCapability */

const PROVIDER_IDS = Object.freeze(['appsample', 'hoyolab', 'mapgenie', 'kongying', 'bwiki']);
const H = '/common/map_user/ys_obc';
const endpoint = (method, origin, path) => JSON.stringify([method, origin, path]);
const routes = (method, origin, paths) => paths.map(path => endpoint(method, origin, path));

// Reviewed source declarations only. This metadata performs no network or storage access.
// Adding a route or deployment requires source review, never input-file discovery.
const POLICY = {
  appsample: {
    origins: ['https://genshin-impact-map.appsample.com'], maps: ['appsample:gim:2'],
    tiers: ['unverified', 'website-account'], statePaths: ['site.modules.9302.Z.get(users,uid).markerIds', 'site.modules.3580.gz', 'window._store.getState().user.user.uid', 'localStorage.gim-local-markers.markerIds'],
    endpoints: [
      ...routes('GET', 'https://game-data.lemonapi.com', ['/gim/markers_all.v5.compressed.json']),
      ...routes('GET', 'https://genshin-impact-map.appsample.com', ['/api/markerNames.json']),
    ],
  },
  hoyolab: {
    origins: ['https://act.hoyolab.com'], maps: ['hoyolab:ys_obc:2'],
    tiers: ['unverified', 'website-account', 'website-free', 'website-pro'], statePaths: ['state.markPointList'],
    endpoints: [
      ...routes('GET', 'https://sg-public-api-static.hoyolab.com', [H + '/v3/map/point/list', H + '/v2/map/label/tree', H + '/v3/map/info', H + '/v2/map/point_group']),
      ...routes('GET', 'https://sg-public-api.hoyolab.com', [H + '/v1/map/point/mark_map_point_list']),
      ...routes('POST', 'https://sg-public-api.hoyolab.com', [H + '/v1/map/point/add_mark_map_point', H + '/v1/map/point/batch_mark_map_point', H + '/v1/map/point/new_del_mark_map_point']),
    ],
  },
  mapgenie: {
    origins: ['https://mapgenie.io'], maps: ['mapgenie:43:121'],
    tiers: ['unverified', 'website-free', 'website-pro'],
    statePaths: ['window.store.getState().user.foundLocations', 'window.store.getState().user.activeProfileId'],
    endpoints: [
      ...routes('GET', 'https://mapgenie.io', ['/api/v1/maps/121/data', '/api/v1/user/map-data/121']),
      ...routes('PUT', 'https://mapgenie.io', ['/api/v1/user/locations/{id}']),
      ...routes('DELETE', 'https://mapgenie.io', ['/api/v1/user/locations/{id}']),
    ],
  },
  kongying: {
    origins: ['https://v3.yuanshen.site'], maps: ['kongying:v3:teyvat'],
    tiers: ['browser-local', 'gitee-cloud'],
    statePaths: ['localStorage.marked_layers', 'localStorage.marked_timelayers', 'localStorage._yuanshenmap_saveid', 'localStorage._yuanshenmap_save_time'],
    endpoints: [
      ...routes('POST', 'https://cloud.yuanshen.site', ['/api/marker/get/list_byinfo', '/api/marker/get/list_byid']),
      ...routes('GET', 'https://assets.yuanshen.site', ['/webapp.json']),
      ...routes('GET', 'https://gitee.com', ['/api/v5/gists']),
      ...routes('PATCH', 'https://gitee.com', ['/api/v5/gists/{id}']),
    ],
  },
  bwiki: {
    origins: ['https://wiki.biligame.com'], maps: ['bwiki:ys:Data:Map4'],
    tiers: ['browser-local'],
    statePaths: ['onchoose', 'indexedDB.wikiYSMap4Data.pointsOnchoose', 'localStorage.wikiMap_ys_Data:Map4_Data'],
    endpoints: routes('GET', 'https://wiki.biligame.com', Array.from({ length: 6 }, (_, i) => '/ys/Data:Map4/point' + (i === 0 ? '' : i + 1) + '.json')),
  },
};

function requireValue(condition) {
  if (!condition) throw Object.assign(new Error('invalid-capability'), { code: 'invalid-capability' });
}

// Check descriptors before reading values; reject getters, extra keys and prototype tricks.
function object(value, fields) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length === fields.length && fields.every(key => Object.hasOwn(value, key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
    requireValue(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}

function array(value, max = 256) {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max);
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}

function text(value, empty = false) {
  requireValue(typeof value === 'string' && Array.from(value).length <= 256);
  requireValue(empty || value.length > 0);
  requireValue(value === value.trim() && !/[\u0000-\u001f\u007f<>]/u.test(value));
}
function reason(value, required) {
  if (!required) { requireValue(value === null); return; }
  requireValue(typeof value === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(value));
}
function strings(value, allow) {
  array(value);
  for (const item of value) { text(item); requireValue(allow.includes(item)); }
  requireValue(new Set(value).size === value.length);
}
function date(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value));
  requireValue(Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value));
}

/** Validate and copy a provider record. Verification is scoped to each exact variant. @param {unknown} value @returns {ProviderCapability} */
function validateCapability(value) {
  object(value, ['provider', 'adapterVersion', 'status', 'variants', 'reasonCode']);
  requireValue(PROVIDER_IDS.includes(value.provider));
  const policy = POLICY[value.provider];
  text(value.adapterVersion);
  requireValue(/^\d+\.\d+\.\d+$/.test(value.adapterVersion));
  requireValue(['planned', 'unavailable', 'supported'].includes(value.status));
  reason(value.reasonCode, value.status !== 'supported');
  array(value.variants, 32);
  requireValue(value.variants.length > 0);
  const seen = new Set();
  let accepted = 0;
  for (const variant of value.variants) {
    object(variant, ['id', 'origins', 'map', 'generation', 'accountTier', 'browser', 'catalogFingerprint', 'read', 'write', 'restore', 'pacing', 'endpoints', 'statePaths', 'evidence', 'reasonCode']);
    text(variant.id);
    requireValue(/^[a-z0-9][a-z0-9-]{0,127}$/.test(variant.id) && !seen.has(variant.id));
    seen.add(variant.id);
    strings(variant.origins, policy.origins);
    requireValue(variant.origins.length > 0 && policy.maps.includes(variant.map) && policy.tiers.includes(variant.accountTier));
    text(variant.generation, true);
    object(variant.browser, ['family', 'version']);
    requireValue(['chromium', 'firefox'].includes(variant.browser.family));
    text(variant.browser.version, true);
    requireValue(variant.catalogFingerprint === '' || (typeof variant.catalogFingerprint === 'string' && /^[a-f0-9]{64}$/.test(variant.catalogFingerprint)));
    for (const field of ['read', 'write', 'restore']) requireValue(['unverified', 'verified', 'unavailable'].includes(variant[field]));
    object(variant.evidence, ['checkedAt', 'read', 'write', 'reload', 'destinationOnlyPreserved', 'pairAccepted', 'restore']);
    date(variant.evidence.checkedAt);
    for (const field of ['read', 'write', 'reload', 'destinationOnlyPreserved', 'pairAccepted', 'restore']) requireValue(typeof variant.evidence[field] === 'boolean');
    for (const field of ['read', 'write', 'restore']) requireValue((variant[field] === 'verified') === variant.evidence[field]);
    if (['read', 'write', 'restore'].some(field => variant[field] === 'verified')) {
      requireValue(variant.browser.version !== '' && variant.catalogFingerprint !== '' && variant.generation !== '' && variant.accountTier !== 'unverified');
    }
    if (variant.pacing !== null) {
      object(variant.pacing, ['batchSize', 'minIntervalMs', 'maxAttempts', 'maxBackoffMs']);
      requireValue(Number.isSafeInteger(variant.pacing.batchSize) && variant.pacing.batchSize > 0);
      requireValue(Number.isSafeInteger(variant.pacing.minIntervalMs) && variant.pacing.minIntervalMs >= 0);
      requireValue(variant.pacing.maxAttempts === 3 && variant.pacing.maxBackoffMs === 30000);
    }
    array(variant.endpoints);
    const endpointKeys = [];
    for (const item of variant.endpoints) {
      object(item, ['method', 'origin', 'path']);
      text(item.method); text(item.origin); text(item.path);
      const key = endpoint(item.method, item.origin, item.path);
      requireValue(policy.endpoints.includes(key));
      endpointKeys.push(key);
    }
    requireValue(new Set(endpointKeys).size === endpointKeys.length);
    strings(variant.statePaths, policy.statePaths);
    const full = ['read', 'write', 'reload', 'destinationOnlyPreserved', 'pairAccepted', 'restore'].every(field => variant.evidence[field]);
    if (variant.write === 'verified') requireValue(full && variant.pacing !== null);
    if (variant.evidence.pairAccepted) requireValue(full && variant.pacing !== null);
    reason(variant.reasonCode, !full);
    if (full) accepted++;
  }
  requireValue((value.status === 'supported') === (accepted > 0));
  return structuredClone(value);
}

module.exports = { PROVIDER_IDS, validateCapability };
