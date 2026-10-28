// Als gefunden markierte Marker eines Profils, nur lokal (found.json bzw. found-<Profil>.json).
// Vor der ersten Änderung je Start eine Sicherung; kaputte Datei → neueste Sicherung.
const path = require('path');
const backup = require('./backup');

class FoundStore {
  constructor(file, { backupDir, onError } = {}) {
    this.file = file;
    this.backupDir = backupDir;
    this.onError = onError || (() => {});
    this.ids = new Set();
    this.timer = null;
    this.backedUp = false;
    // { stamp }: aus Sicherung geladen, { lost: true }: kaputt und keine Sicherung
    this.recovered = null;
    let ids = backup.readIds(file);
    if (!ids) {
      // Kopie der kaputten Datei aufheben, sie wird gleich überschrieben
      try {
        backup.setAside(file, backupDir, 'broken', false);
      } catch {
        // Kopie ging nicht, weiter mit der Sicherung
      }
      const saved = backup.latest(backupDir, path.basename(file, '.json'));
      ids = saved ? saved.ids : [];
      this.recovered = saved ? { stamp: saved.stamp } : { lost: true };
    }
    for (const id of ids) this.ids.add(id);
    if (this.recovered) {
      // kaputte Datei liegt schon bei den Sicherungen, nicht noch einmal sichern
      this.backedUp = true;
      this.trySave();
    }
  }

  toggle(id) {
    const n = Number(id);
    if (this.ids.has(n)) this.ids.delete(n);
    else this.ids.add(n);
    this.saveSoon();
    return this.ids.has(n);
  }

  list() {
    return [...this.ids];
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.trySave(), 500);
  }

  // Nur wenn noch etwas aussteht (Beenden, Profilwechsel)
  flush() {
    if (this.timer) this.trySave();
  }

  trySave() {
    try {
      this.saveNow();
    } catch (err) {
      this.onError(err);
    }
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.backedUp && this.backupDir) {
      this.backedUp = true;
      try {
        backup.snapshot(this.file, this.backupDir);
      } catch (err) {
        // Speichern trotzdem, die Sicherung holt der nächste Start nach
        this.onError(err);
      }
    }
    backup.writeAtomic(this.file, JSON.stringify({ ids: this.list() }));
  }
}

module.exports = { FoundStore };
