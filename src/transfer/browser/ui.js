'use strict';
const { TRANSFER_LIMITS } = require('../envelope');

// Local dictionary only: never install or alter the host site's translation globals.
const MESSAGES = {
  en: {
    title: 'Map progress transfer', intro: 'Read the destination account and save before applying.', choose: 'Choose a transfer file to preview additions.',
    preservation: 'Only found markers are added. Destination notes, routes, preferences and other found markers are preserved.',
    acknowledge: ' I saved the requested destination backup and can find the file.',
    backupWarning: 'A download request does not prove that a backup was saved. No transactional rollback is promised.',
    apply: 'Apply additions', cancel: 'Cancel', close: 'Close', provider: 'Provider', map: 'Map', save: 'Save', account: 'Account',
    noSave: 'Save identity unavailable', noAccount: 'Account identity unavailable', add: 'Add', unchanged: 'Already found', skipped: 'Skipped',
    coverage: 'Coverage', completeScope: 'complete declared scope', partial: 'partial', categories: 'Categories', levels: 'Levels', unspecified: 'not specified',
    backupRequested: 'Backup download requested. Save it and acknowledge before Apply.', progress: 'Verified operations', result: 'Result', confirmed: 'Confirmed', failed: 'Failed', uncertain: 'Uncertain',
    receiptRequested: 'Receipt download requested. To resume, reopen the import script with the original file, preview current state and save a new backup.',
    stopped: 'Transfer stopped', resume: 'Wait as instructed by the provider, then preview the original file again to resume.', refresh: 'Refresh the preview before trying again.',
    statuses: { complete: 'complete', partial: 'partial', canceled: 'canceled' },
  },
  de: {
    title: 'Kartenfortschritt übertragen', intro: 'Prüfe vor dem Anwenden das Zielkonto und den Spielstand.', choose: 'Wähle eine Übertragungsdatei für die Vorschau der Ergänzungen.',
    preservation: 'Nur gefundene Markierungen werden ergänzt. Notizen, Routen, Einstellungen und andere gefundene Markierungen am Ziel bleiben erhalten.',
    acknowledge: ' Ich habe die angeforderte Sicherung des Zielspielstands gespeichert und kann die Datei finden.',
    backupWarning: 'Eine Downloadanforderung bestätigt keine gespeicherte Sicherung. Eine transaktionale Rücknahme wird nicht zugesichert.',
    apply: 'Ergänzungen anwenden', cancel: 'Abbrechen', close: 'Schließen', provider: 'Anbieter', map: 'Karte', save: 'Spielstand', account: 'Konto',
    noSave: 'Spielstandidentität nicht verfügbar', noAccount: 'Kontoidentität nicht verfügbar', add: 'Ergänzen', unchanged: 'Bereits gefunden', skipped: 'Übersprungen',
    coverage: 'Abdeckung', completeScope: 'vollständiger angegebener Bereich', partial: 'teilweise', categories: 'Kategorien', levels: 'Ebenen', unspecified: 'nicht angegeben',
    backupRequested: 'Sicherungsdownload angefordert. Speichere die Datei und bestätige dies vor dem Anwenden.', progress: 'Überprüfte Vorgänge', result: 'Ergebnis', confirmed: 'Bestätigt', failed: 'Fehlgeschlagen', uncertain: 'Ungewiss',
    receiptRequested: 'Ergebnisdownload angefordert. Öffne zum Fortsetzen das Importskript erneut mit der Originaldatei, prüfe den aktuellen Stand und speichere eine neue Sicherung.',
    stopped: 'Übertragung gestoppt', resume: 'Warte entsprechend den Vorgaben des Anbieters und öffne dann erneut die Vorschau der Originaldatei.', refresh: 'Aktualisiere vor einem neuen Versuch die Vorschau.',
    statuses: { complete: 'vollständig', partial: 'teilweise', canceled: 'abgebrochen' },
  },
};

/** An isolated panel with text-only imported labels. Site CSP is respected; injection
 * failure ends the script. Download acknowledgement is a user assertion, not proof of saving.
 */
/** @param {Document} document @returns {import('./runtime').BrowserUi} */
function createTransferUi(document) {
  const language = document.documentElement?.lang || document.defaultView?.navigator?.language || 'en';
  const t = MESSAGES[/^de(?:-|$)/i.test(language) ? 'de' : 'en'];
  let panel; let disposed = false; let chooser = null; let previewed = false; let running = false;
  const subscriptions = []; const callbacks = { apply: new Set(), cancel: new Set(), ack: new Set() };
  function make(tag, text, parent) {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node); return node;
  }
  function listen(node, event, callback) {
    node.addEventListener(event, callback); subscriptions.push(() => node.removeEventListener(event, callback));
  }
  function emit(type) { for (const callback of callbacks[type]) callback(); }
  let context; let preview; let status; let ack; let apply; let file;
  try {
    panel = make('section'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t.title);
    // Fixed styling is scoped to this panel; imported content is never parsed as markup/CSS.
    panel.setAttribute('style', 'position:fixed;z-index:2147483647;right:20px;top:20px;max-height:85vh;overflow:auto;width:380px;max-width:90vw;padding:20px;background:#262c3a;color:#ece5d8;border:1px solid #d3bc8e;border-radius:4px;font:15px/1.5 "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 30px #0008');
    make('h2', t.title, panel);
    context = make('p', t.intro, panel);
    preview = make('p', t.choose, panel);
    make('p', t.preservation, panel);
    const label = make('label', undefined, panel);
    ack = make('input', undefined, label); ack.type = 'checkbox'; ack.disabled = true;
    make('span', t.acknowledge, label);
    make('p', t.backupWarning, panel);
    apply = make('button', t.apply, panel); apply.disabled = true;
    const cancel = make('button', t.cancel, panel); const close = make('button', t.close, panel);
    for (const button of [apply, cancel, close]) { button.type = 'button'; button.setAttribute('style', 'margin:6px 6px 0 0;padding:8px 12px;border:1px solid #d3bc8e;border-radius:3px;background:#ece5d8;color:#262c3a;font:inherit'); }
    status = make('p', '', panel); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    file = make('input', undefined, panel); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    document.body.appendChild(panel);
    listen(ack, 'change', () => { apply.disabled = !previewed || !ack.checked || running; if (ack.checked) emit('ack'); });
    listen(apply, 'click', () => { if (!apply.disabled) emit('apply'); });
    listen(cancel, 'click', () => { emit('cancel'); });
    listen(close, 'click', () => { emit('cancel'); api.dispose(); });
    listen(file, 'cancel', () => settle(null));
    listen(file, 'change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) { settle(null); return; }
      if (chosen.size > TRANSFER_LIMITS.BYTES) { api.showError('transfer-too-large'); settle(null); return; }
      try {
        const bytes = new Uint8Array(await chosen.arrayBuffer());
        if (bytes.byteLength > TRANSFER_LIMITS.BYTES) { api.showError('transfer-too-large'); settle(null); }
        else settle(bytes);
      } catch { api.showError('file-unavailable'); settle(null); }
    });
  } catch {
    panel?.remove(); throw Object.assign(new Error('ui-unavailable'), { code: 'ui-unavailable' });
  }
  function settle(value) { const resolve = chooser; chooser = null; resolve?.(value); }
  const subscribe = type => callback => { callbacks[type].add(callback); return () => callbacks[type].delete(callback); };
  const api = {
    chooseFile() {
      if (disposed) return Promise.resolve(null);
      settle(null); file.value = ''; previewed = false; ack.checked = false; ack.disabled = true; apply.disabled = true;
      return new Promise(resolve => { chooser = resolve; try { file.click(); } catch { api.showError('file-unavailable'); settle(null); } });
    },
    showContext(value) {
      context.textContent = t.provider + ': ' + value.provider + ' | ' + t.map + ': ' + value.map + ' | ' + t.save + ': ' + (value.saveLabel || t.noSave) + ' | ' + (!value.identityKnown || !value.accountLabel ? t.noAccount : t.account + ': ' + value.accountLabel) + (value.accountLabel && !value.identityKnown ? ' | ' + value.accountLabel : '');
    },
    showPreview(value) {
      const coverage = value.coverage;
      preview.textContent = t.add + ': ' + value.counts.add + ' | ' + t.unchanged + ': ' + value.counts.unchanged + ' | ' + t.skipped + ': ' + value.counts.skipped + ' | ' + t.coverage + ': ' + (coverage.complete ? t.completeScope : t.partial) + ' | ' + t.categories + ': ' + (coverage.categories.join(', ') || t.unspecified) + ' | ' + t.levels + ': ' + (coverage.levels.join(', ') || t.unspecified);
      previewed = true; running = false; ack.checked = false; ack.disabled = false; apply.disabled = true;
      status.textContent = t.backupRequested;
    },
    showProgress(value) { running = true; apply.disabled = true; ack.disabled = true; status.textContent = t.progress + ': ' + value.completed + '/' + value.total; },
    showReceipt(value) {
      running = false; previewed = false; apply.disabled = true; ack.disabled = true;
      status.textContent = t.result + ': ' + t.statuses[value.status] + ' | ' + t.confirmed + ': ' + value.confirmed.length + ' | ' + t.unchanged + ': ' + value.unchanged.length + ' | ' + t.skipped + ': ' + value.skipped.length + ' | ' + t.failed + ': ' + value.failed.length + ' | ' + t.uncertain + ': ' + value.uncertain.length + '. ' + t.receiptRequested;
    },
    showError(code) { apply.disabled = true; status.textContent = t.stopped + ': ' + code + '. ' + (code === 'resume-required' ? t.resume : t.refresh); },
    onApply: subscribe('apply'), onCancel: subscribe('cancel'), onBackupAcknowledged: subscribe('ack'),
    dispose() { if (disposed) return; disposed = true; settle(null); for (const remove of subscriptions) remove(); for (const set of Object.values(callbacks)) set.clear(); panel.remove(); },
  };
  return api;
}
module.exports = { createTransferUi };
