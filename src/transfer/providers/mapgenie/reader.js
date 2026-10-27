'use strict';
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Fail closed until the current first-party account/profile and successful
 * progress response contracts can be inspected. Endpoint names and Redux path
 * names alone cannot distinguish authenticated empty progress from a read error
 * or bind a response to the selected save. Never guess that contract.
 */
async function exportMapGenie(window) {
  if (window?.location?.origin !== 'https://mapgenie.io'
    || !/^\/genshin-impact\/maps\/teyvat\/?$/.test(window.location.pathname)) fail('wrong-site');
  fail('source-verification-required');
}

const ERRORS = Object.freeze({
  'wrong-site': 'Open https://mapgenie.io/genshin-impact/maps/teyvat and use the MapGenie source script there.',
  'source-verification-required': 'MapGenie source export is unavailable: its current account/profile and saved-progress format could not be verified because site access was blocked. No file was exported. Use an updated source script after this source has been verified.',
});
async function runSourceExport({ window, console }) {
  try { await exportMapGenie(window); }
  catch (error) {
    const code = Object.hasOwn(ERRORS, error?.code) ? error.code : 'source-export-failed';
    console.error('MapGenie export stopped (' + code + '): ' + (ERRORS[code] || 'No file was exported. Reload MapGenie and try again.'));
  }
}
module.exports = { exportMapGenie, runSourceExport };
