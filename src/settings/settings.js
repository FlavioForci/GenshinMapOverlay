/* global I18n */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else factory().mountSettings({ document: root.document, api: root.profileApi, transferApi: root.transferApi, I18n: root.I18n, window: root });
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function validateProfileText(name, region) {
    return { ok: typeof name === 'string' && Array.from(name.trim()).length >= 1
      && Array.from(name.trim()).length <= 80 && typeof region === 'string' && Array.from(region).length <= 80 };
  }

  /** Bind the production vanilla UI. All labels, including imported names, use textContent. */
  function mountSettings({ document, api, transferApi, I18n, window }) {
    const $ = id => document.getElementById(id);
    let language = 'en';
    let snapshot = null;
    let statusKey = null;
    let busy = false;
    let preparation = null;
    let pendingCommand = Promise.resolve(true);
    let disposed = false;
    let editedProfile = null;
    const cleanups = [];
    let providers = [];
    let transferPreview = null;
    let transferCounts = null;
    let transferCoverage = null;
    let transferDecisions = [];
    let transferStatus = null;
    const countKeys = ['matched', 'alreadyFound', 'ambiguous', 'unsupported', 'unknown', 'invalid', 'ignoredNotFound', 'duplicates'];
    const t = key => I18n.t(language, key);

    function listen(id, event, callback) {
      $(id).addEventListener(event, callback);
      cleanups.push(() => $(id).removeEventListener(event, callback));
    }

    function render() {
      if (disposed) return;
      document.documentElement.lang = language;
      for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
      const recovery = snapshot?.sync.phase === 'recovery';
      const writable = snapshot?.sync.phase === 'local';
      $('retry-local').hidden = !recovery;
      $('restore-local').hidden = !recovery;
      $('recovery-help').hidden = !recovery;
      for (const id of ['create', 'rename', 'select', 'import-backup', 'export-backup', 'name', 'region', 'profiles']) {
        $(id).disabled = busy || !writable || preparation !== null;
      }
      $('retry-local').disabled = busy || preparation !== null;
      $('restore-local').disabled = busy || preparation !== null;
      $('status').textContent = statusKey ? t(statusKey) : recovery
        ? t('progress.error.' + snapshot.sync.code) : t(snapshot ? 'profiles.local' : 'profiles.loading');
      renderTransfer();
      const selected = $('profiles').value;
      const options = [];
      for (const profile of snapshot?.profiles || []) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name + (profile.region ? ' · ' + profile.region : '');
        options.push(option);
      }
      $('profiles').replaceChildren(...options);
      $('profiles').value = (snapshot?.profiles || []).some(profile => profile.id === selected)
        ? selected : snapshot?.activeProfile?.id || '';
      $('active-profile').textContent = snapshot?.activeProfile?.name || t('profiles.noActive');
      if (editedProfile !== snapshot?.activeProfile?.id) {
        editedProfile = snapshot?.activeProfile?.id;
        $('name').value = snapshot?.activeProfile?.name || '';
        $('region').value = snapshot?.activeProfile?.region || '';
      }
    }

    function apply(value) {
      if (disposed || !value || !Number.isSafeInteger(value.viewVersion)
        || (snapshot && value.viewVersion <= snapshot.viewVersion)) return;
      if (snapshot && value.viewVersion > snapshot.viewVersion && transferPreview) {
        transferPreview = null;
        transferStatus = 'transfer.error.stale-preview';
      }
      snapshot = value;
      statusKey = null;
      render();
    }

    function failure(error) {
      statusKey = error?.messageKey || 'progress.error.local-operation-failed';
      render();
    }

    function command(operation, payload) {
      if (disposed || busy || !snapshot || preparation !== null) return Promise.resolve(true);
      pendingCommand = executeCommand(operation, payload);
      return pendingCommand;
    }

    async function executeCommand(operation, payload) {
      busy = true;
      render();
      try {
        const result = await api.command(operation, { sessionGeneration: snapshot.sessionGeneration, ...payload });
        if (disposed) return false;
        if (result?.ok && result.value?.canceled) return true;
        const replySnapshot = result?.ok ? result.value : result?.snapshot;
        if (replySnapshot && snapshot && replySnapshot.viewVersion < snapshot.viewVersion) return result?.ok === true;
        if (result?.ok) {
          apply(result.value);
          statusKey = snapshot?.sync.phase === 'recovery' ? null : 'profiles.saved';
        } else {
          apply(result?.snapshot);
          statusKey = result?.error?.messageKey || 'progress.error.local-operation-failed';
        }
        return result?.ok === true;
      } catch {
        if (!disposed) statusKey = 'progress.error.local-operation-failed';
        return false;
      } finally {
        busy = false;
        render();
      }
    }

    function prepareQuit(requestId) {
      if (preparation) return preparation.requestId === requestId ? preparation.promise : Promise.resolve(false);
      const currentPreparation = { requestId, promise: null };
      preparation = currentPreparation;
      render();
      const draining = busy ? pendingCommand : Promise.resolve(true);
      currentPreparation.promise = draining.then(ok => preparation === currentPreparation && !disposed && ok === true);
      return currentPreparation.promise;
    }

    function resumeAfterQuit(requestId) {
      if (preparation?.requestId !== requestId) return;
      preparation = null;
      render();
    }

    function renderTransfer() {
      if (!transferApi) return;
      const writable = snapshot?.sync.phase === 'local';
      const disabled = busy || !writable || preparation !== null || !providers.length;
      for (const id of ['transfer-source', 'transfer-destination', 'transfer-map', 'transfer-mode', 'transfer-name', 'transfer-region', 'transfer-preview', 'transfer-export', 'transfer-source-script', 'transfer-destination-script', 'transfer-prior']) $(id).disabled = disabled;
      $('transfer-apply').disabled = disabled || !transferPreview?.canApply;
      $('transfer-another').hidden = !transferPreview?.priorDestinations.length;
      $('transfer-another').disabled = disabled || !transferPreview?.priorDestinations.length;
      $('transfer-use-prior').hidden = !transferPreview?.priorDestinations.length;
      $('transfer-use-prior').disabled = disabled || !transferPreview?.priorDestinations.length;
      $('transfer-report').disabled = disabled || !transferPreview;
      $('transfer-status').textContent = transferStatus ? t(transferStatus) : t('transfer.pending');
      $('transfer-counts').textContent = transferCounts ? countKeys.map(key => t('transfer.count.' + key) + ': ' + transferCounts[key]).join(' · ') : '';
      $('transfer-coverage').textContent = transferCoverage ? t(transferCoverage.complete ? 'transfer.complete' : 'transfer.partial') + ' · ' + t('transfer.categories') + ': ' + transferCoverage.categories.join(', ') + ' · ' + t('transfer.levels') + ': ' + transferCoverage.levels.join(', ') : '';
      $('transfer-decisions').textContent = transferDecisions.map(row => row.sourceId + ': ' + row.reason).join('\n');
      const reason = code => code ? t('transfer.reason.' + code) + ' (' + code + ')' : '';
      $('transfer-capabilities').textContent = providers.map(provider => provider.provider + ' · ' + t('transfer.state.' + provider.status) + ' · ' + reason(provider.reasonCode) + '\n' + provider.variants.map(variant => '  ' + variant.id + ' · ' + variant.map + ' · ' + variant.accountTier + ' · ' + variant.browser.family + ' · ' + ['read', 'write', 'restore'].map(key => t('transfer.' + key) + ': ' + t('transfer.verification.' + variant[key])).join(' · ') + (variant.reasonCode ? ' · ' + reason(variant.reasonCode) : '')).join('\n')).join('\n\n');
      $('transfer-prior').hidden = !transferPreview?.priorDestinations.length;
      $('transfer-prior-label').hidden = !transferPreview?.priorDestinations.length;
    }
    function populateMaps() {
      const provider = providers.find(row => row.provider === $('transfer-destination').value);
      const options = [...new Set(provider?.variants.map(row => row.map) || [])].map(map => { const option = document.createElement('option'); option.value = map; option.textContent = map; return option; });
      $('transfer-map').replaceChildren(...options); $('transfer-map').value = options[0]?.value || '';
    }
    function clearPreview() {
      transferPreview = null; transferCounts = null; transferCoverage = null; transferDecisions = []; transferStatus = null; render();
    }
    function transferCommand(operation, options) {
      if (disposed || busy || !snapshot || preparation !== null || !transferApi) return Promise.resolve(true);
      pendingCommand = executeTransfer(operation, options);
      return pendingCommand;
    }
    async function executeTransfer(operation, options) {
      busy = true; transferStatus = null;
      const captured = { sessionGeneration: snapshot.sessionGeneration, profileId: snapshot.activeProfile?.id };
      if (operation === 'previewImport') clearPreview();
      render();
      try {
        let result;
        if (operation === 'saveScript') result = await transferApi.saveScript(options.provider, options.direction);
        else if (operation === 'saveReport') result = await transferApi.saveReport(options.previewId);
        else result = await transferApi[operation](captured, options);
        if (disposed) return false;
        // A snapshot can change while a native picker is open. Never re-enable an old token.
        const sameContext = snapshot.sessionGeneration === captured.sessionGeneration && snapshot.activeProfile?.id === captured.profileId;
        if (!sameContext && operation !== 'applyImport') { transferPreview = null; transferStatus = 'transfer.error.stale-context'; return false; }
        const replySnapshot = result?.ok ? result.value?.snapshot : result?.snapshot;
        if (replySnapshot && replySnapshot.viewVersion < snapshot.viewVersion) return result?.ok === true;
        if (!result?.ok) {
          transferPreview = null;
          if (result?.validation) transferCounts = Object.fromEntries(countKeys.map(key => [key, key === 'invalid' ? result.validation.invalidCount : 0]));
          if (result?.snapshot) apply(result.snapshot);
          transferStatus = result?.error?.messageKey || 'transfer.error.local-operation-failed';
          return false;
        }
        if (operation === 'previewImport') {
          transferPreview = result.value;
          transferCounts = result.value?.counts || null; transferCoverage = result.value?.coverage || null;
          const prior = result.value?.priorDestinations || [];
          $('transfer-prior').replaceChildren(...prior.map(profile => { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; return option; }));
          $('transfer-prior').value = prior[0]?.id || '';
        } else if (operation === 'applyImport') {
          transferPreview = null;
          apply(result.value.snapshot); transferCounts = result.value.receipt.counts; transferStatus = 'transfer.applied';
        } else if (operation === 'exportProfile' && result.value) {
          // Shared counts now describe the export; require a fresh import preview.
          transferPreview = null;
          transferCounts = result.value.counts; transferCoverage = result.value.coverage; transferDecisions = result.value.decisions; transferStatus = 'transfer.exported';
        } else if (operation === 'saveScript' || operation === 'saveReport') transferStatus = 'transfer.saved';
        return true;
      } catch {
        if (!disposed) { transferPreview = null; transferStatus = 'transfer.error.local-operation-failed'; }
        return false;
      } finally { busy = false; render(); }
    }
    let transferReady = Promise.resolve();
    if (transferApi) {
      $('transfer-mode').value = 'new';
      listen('transfer-preview', 'click', () => {
        const options = { provider: $('transfer-source').value, mode: $('transfer-mode').value };
        options.name = $('transfer-name').value.trim() || t('transfer.importedName');
        if ($('transfer-region').value) options.region = $('transfer-region').value;
        return transferCommand('previewImport', options);
      });
      listen('transfer-apply', 'click', () => transferCommand('applyImport', { previewId: transferPreview?.id }));
      listen('transfer-another', 'click', () => transferCommand('applyImport', { previewId: transferPreview?.id, createAnother: true }));
      listen('transfer-use-prior', 'click', () => command('select', { profileId: $('transfer-prior').value }));
      listen('transfer-export', 'click', () => transferCommand('exportProfile', { provider: $('transfer-destination').value, map: $('transfer-map').value }));
      listen('transfer-source-script', 'click', () => transferCommand('saveScript', { provider: $('transfer-source').value, direction: 'export' }));
      listen('transfer-destination-script', 'click', () => transferCommand('saveScript', { provider: $('transfer-destination').value, direction: 'import' }));
      listen('transfer-report', 'click', () => transferCommand('saveReport', { previewId: transferPreview?.id }));
      for (const id of ['transfer-source', 'transfer-mode', 'transfer-name', 'transfer-region']) listen(id, 'change', clearPreview);
      listen('transfer-destination', 'change', () => { populateMaps(); render(); });
      transferReady = transferApi.providers().then(values => {
        if (disposed) return;
        if (!Array.isArray(values)) throw new Error('invalid-providers');
        providers = values;
        for (const id of ['transfer-source', 'transfer-destination']) {
          const options = providers.map(provider => { const option = document.createElement('option'); option.value = provider.provider; option.textContent = provider.provider; return option; });
          $(id).replaceChildren(...options); $(id).value = options[0]?.value || '';
        }
        populateMaps(); render();
      }).catch(() => { if (!disposed) { transferStatus = 'transfer.error.local-operation-failed'; render(); } });
    }

    function fields() {
      const name = $('name').value;
      const region = $('region').value;
      if (!validateProfileText(name, region).ok) {
        failure({ messageKey: 'profiles.invalidText' });
        return null;
      }
      return { name: name.trim(), region };
    }

    listen('create', 'click', () => {
      const values = fields();
      if (values) void command('create', values);
    });
    listen('rename', 'click', () => {
      const values = fields();
      if (values && snapshot?.activeProfile) void command('rename', { profileId: snapshot.activeProfile.id, ...values });
    });
    listen('select', 'click', () => { void command('select', { profileId: $('profiles').value }); });
    listen('import-backup', 'click', () => { void command('import-backup', {}); });
    listen('export-backup', 'click', () => { void command('export-backup', { profileIds: snapshot?.profiles.map(profile => profile.id) || [] }); });
    listen('retry-local', 'click', () => { void command('retry-local', {}); });
    listen('restore-local', 'click', () => { void command('restore-local', {}); });
    // Subscribe before the asynchronous read; versions reject a delayed initial reply.
    cleanups.push(api.onSnapshot(apply));
    cleanups.push(api.onLanguage(code => {
      if (!disposed) {
        language = I18n.resolve(code);
        render();
      }
    }));
    if (api.onPrepareQuit) cleanups.push(api.onPrepareQuit(async ({ requestId }) => {
      let ok = false;
      try { ok = await prepareQuit(requestId); } catch { /* Main keeps quit prevented. */ }
      if (!disposed) api.quitReady({ requestId, ok });
    }));
    if (api.onResumeAfterQuit) cleanups.push(api.onResumeAfterQuit(({ requestId }) => resumeAfterQuit(requestId)));
    render();
    const ready = api.getState().then(result => {
      if (disposed) return;
      if (result?.ok) apply(result.value);
      else {
        apply(result?.snapshot);
        failure(result?.error);
      }
    }).catch(() => { if (!disposed) failure(); });

    function dispose() {
      if (disposed) return;
      disposed = true;
      cleanups.splice(0).forEach(clean => clean());
      if (window) window.removeEventListener('pagehide', dispose);
    }
    // beforeunload can precede a navigation canceled by main; clean up only on exit.
    if (window) window.addEventListener('pagehide', dispose, { once: true });
    return { ready: Promise.all([ready, transferReady]), command, dispose, prepareQuit, resumeAfterQuit };
  }

  return { mountSettings, validateProfileText };
});
