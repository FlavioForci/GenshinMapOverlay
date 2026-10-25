// Complete authoritative progress plus serialized optimistic desired-value edits.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProgressView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const same = (a, b) => !!a && !!b
    && a.sessionGeneration === b.sessionGeneration && a.profileId === b.profileId;

  /** Unknown catalog keys remain selected when editing the visible catalog. */
  function mergeVisibleTypes(current, visible, selected) {
    const known = new Set(visible);
    return [...new Set([...current.filter(key => !known.has(key)), ...selected])];
  }

  /**
   * The service supplies globally monotonic viewVersion values across activations.
   * Pending edits are applied in invocation order over the latest durable base.
   * @param {{sendSetFound:Function,sendSetPreferences?:Function,onChange?:Function,onError?:Function}} options
   */
  function createProgressView({ sendSetFound, sendSetPreferences, onChange = () => {}, onError = () => {} }) {
    let base = { context: null, foundIds: [], enabledTypes: [], hideFound: false };
    let version = -1;
    let phase = 'initializing';
    let pending = [];
    let tail = Promise.resolve();
    let preparation = null;
    let failures = 0;

    function current() {
      const value = {
        ...base, context: base.context ? { ...base.context } : null,
        foundIds: [...base.foundIds], enabledTypes: [...base.enabledTypes],
      };
      const ids = new Set(value.foundIds);
      for (const intent of pending) {
        if (!same(value.context, intent.context)) continue;
        if (intent.kind === 'found') {
          if (intent.patch.found) ids.add(intent.patch.id);
          else ids.delete(intent.patch.id);
        } else Object.assign(value, intent.patch);
      }
      value.foundIds = [...ids].sort((a, b) => a - b);
      value.enabledTypes = [...value.enabledTypes];
      return value;
    }

    function emit(profileChanged = false) {
      onChange(current(), { profileChanged, writable: phase === 'local' && preparation === null });
    }

    /** @param {import('../progress/service').PublicSnapshot} snapshot */
    function applySnapshot(snapshot) {
      if (!snapshot || !Number.isSafeInteger(snapshot.viewVersion) || snapshot.viewVersion <= version) return;
      version = snapshot.viewVersion;
      phase = snapshot.sync?.phase;
      const profile = snapshot.activeProfile;
      const context = profile ? { sessionGeneration: snapshot.sessionGeneration, profileId: profile.id } : null;
      const changed = !same(base.context, context) && (base.context !== null || context !== null);
      base = {
        context, foundIds: profile ? [...profile.foundIds] : [],
        enabledTypes: profile ? [...profile.enabledTypes] : [], hideFound: profile ? profile.hideFound : false,
      };
      if (changed || phase !== 'local') pending = [];
      emit(changed);
    }

    function submit(kind, patch, send) {
      if (!base.context || phase !== 'local' || preparation !== null) return Promise.resolve();
      const intent = { kind, patch, context: { ...base.context } };
      pending.push(intent);
      emit();
      const operation = tail.then(async () => {
        if (!same(base.context, intent.context) || !pending.includes(intent)) { failures++; return; }
        let result;
        try { result = await send({ ...intent.context, ...patch }); }
        catch {
          result = { ok: false, error: { code: 'local-operation-failed', messageKey: 'progress.error.local-operation-failed' } };
        }
        // A later activation invalidates this continuation, including A → B → A.
        if (!same(base.context, intent.context)) { failures++; return; }
        pending = pending.filter(item => item !== intent);
        const next = result?.ok ? result.value : result?.snapshot;
        if (next?.sessionGeneration === intent.context.sessionGeneration && next?.activeProfile?.id === intent.context.profileId) {
          applySnapshot(next);
        }
        emit();
        if (!result?.ok) failures++;
        if (!result?.ok) onError(result?.error || { code: 'local-operation-failed', messageKey: 'progress.error.local-operation-failed' });
      });
      tail = operation.catch(() => { failures++; });
      return operation;
    }

    return {
      applySnapshot, current,
      prepareQuit(requestId) {
        if (preparation) return preparation.requestId === requestId ? preparation.promise : Promise.resolve(false);
        const before = failures;
        const currentPreparation = { requestId, promise: null };
        preparation = currentPreparation;
        emit();
        currentPreparation.promise = tail.then(() => preparation === currentPreparation && failures === before);
        return currentPreparation.promise;
      },
      resumeAfterQuit(requestId) {
        if (preparation?.requestId !== requestId) return;
        preparation = null;
        emit();
      },
      setFound: (id, found) => submit('found', { id, found }, sendSetFound),
      setPreferences: patch => submit('preferences', {
        ...patch, ...(patch.enabledTypes ? { enabledTypes: [...patch.enabledTypes] } : {}),
      }, sendSetPreferences),
    };
  }

  /** Actual renderer refresh orchestration; callbacks bind existing vanilla UI. */
  function createProgressRefreshAdapter(effects) {
    return (state, { profileChanged = false, writable = true } = {}) => {
      if (profileChanged) {
        effects.closeSpot();
        effects.closeLightbox();
      }
      effects.replaceFound(state.foundIds);
      effects.replacePreferences(state.enabledTypes, state.hideFound);
      effects.recount();
      effects.refreshFilters();
      effects.refreshSpot();
      effects.renderControls(writable);
      effects.redraw();
    };
  }

  return { createProgressView, createProgressRefreshAdapter, mergeVisibleTypes };
});
