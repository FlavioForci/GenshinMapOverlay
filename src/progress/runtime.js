'use strict';

const path = require('node:path');

/**
 * Compose local progress before creating renderer windows. Configuration is read
 * in preservation mode before repository creation and migration. Awaiting this
 * function guarantees the initial local/recovery snapshot has been published.
 * No app event listeners, windows or IPC handlers are installed here (Task 6 owns
 * activation and the quit loop).
 *
 * Optional loadConfig/createRepository/createService are main-process dependency
 * injection only. Defaults are lazy so importing this module never loads Electron.
 * userData is captured once, including for retryLocal; no renderer may supply it.
 * @param {{app:{getPath:(name:string)=>string},log?:(message:string)=>void,onSnapshot?:(snapshot:import('./service').PublicSnapshot)=>void,loadConfig?:(options:{preserveMalformed:true})=>unknown,createRepository?:(options:{root:string})=>import('./repository').ProgressRepository,createService?:(options:object)=>import('./service').ProgressService}} options
 * @returns {Promise<{service:import('./service').ProgressService,shutdown:()=>Promise<void>,retryLocal:()=>Promise<import('./service').PublicSnapshot>}>}
 */
async function createProgressRuntime({ app, log = () => {}, onSnapshot = () => {}, loadConfig = options => require('../config').load(options), createRepository = options => new (require('./repository').ProgressRepository)(options), createService = options => new (require('./service').ProgressService)(options) }) {
  const userData = path.resolve(app.getPath('userData'));
  await loadConfig({ preserveMalformed: true });
  const repository = createRepository({ root: path.join(userData, 'progress') });
  const service = createService({ repository, onSnapshot });
  const retryLocal = () => service.initialize({ userData });
  const initial = await retryLocal();
  if (initial.sync.phase === 'recovery') {
    // Main-only diagnostics; logging must not hide the usable recovery runtime.
    try { log(`Progress initialization: ${initial.sync.code}`); } catch { /* diagnostic only */ }
  }
  return { service, shutdown: () => service.shutdown(), retryLocal };
}

module.exports = { createProgressRuntime };
