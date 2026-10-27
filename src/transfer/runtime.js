'use strict';
const path = require('node:path');
const { TransferController } = require('./controller');
const { createMappingResolver } = require('./bundled-mappings');
const { registerTransferIpc } = require('./ipc');
const { getProvider } = require('./registry');
const { readFileBounded } = require('../progress/atomic-file');
const { ProgressError } = require('../progress/schema');
/** Compose main-only transfer services. Catalog is a cached current DataStore projection.
 * Cross-provider pairs come only from bundled reviewed source/target row facts.
 * @param {{progress:import('../progress/service').ProgressService,getCatalog:Function,getSettingsWindow:Function,ipcMain:object,dialogs:object,withProgressBarrier?:Function}} options
 * @returns {{controller:TransferController,dispose:()=>void}}
 */
function createTransferRuntime({ progress, getCatalog, getSettingsWindow, ipcMain, dialogs, withProgressBarrier }) {
  const controller = new TransferController({ progress, getCatalog: () => { const catalog = getCatalog(); if (!catalog) throw new ProgressError('catalog-unavailable'); return catalog; }, getMapping: createMappingResolver(getCatalog) });
  const dispose = registerTransferIpc({ ipcMain, controller, getSettingsWindow, dialogs, withProgressBarrier, getScript: async (provider, direction) => {
    getProvider(provider);
    if (!['export', 'import'].includes(direction)) throw new ProgressError('invalid-command');
    try { return await readFileBounded(path.join(__dirname, 'scripts', provider + '-' + direction + '.js'), 2 * 1024 * 1024); }
    catch { throw new ProgressError('local-read-failed'); }
  } });
  return { controller, dispose };
}
module.exports = { createTransferRuntime };
