/* global I18n */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else factory().mountSettings({ document: root.document, api: root.profileApi, I18n: root.I18n, window: root });
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function validateProfileText(name, region) {
    return { ok: typeof name === 'string' && Array.from(name.trim()).length >= 1
      && Array.from(name.trim()).length <= 80 && typeof region === 'string' && Array.from(region).length <= 80 };
  }

  /** Bind the production vanilla UI. All labels, including imported names, use textContent. */
  function mountSettings({ document, api, I18n, window }) {
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
      if (window) window.removeEventListener('beforeunload', dispose);
    }
    if (window) window.addEventListener('beforeunload', dispose, { once: true });
    return { ready, command, dispose, prepareQuit, resumeAfterQuit };
  }

  return { mountSettings, validateProfileText };
});
