// Profile: je Profil eine eigene Fundliste. Profil 1 = found.json wie vor den Profilen.
// profiles.json: { active, next, list: [{ id, name }] }, leerer Name = „Profil <id>“
const fs = require('fs');
const path = require('path');
const backup = require('./backup');

const NAME_MAX = 40;

function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

class ProfileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.active = '1';
    // Ids nie wiederverwenden, sonst landen alte Sicherungen beim neuen Profil
    this.next = 2;
    this.list = [{ id: '1', name: '' }];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const seen = new Set();
      const list = [];
      for (const p of Array.isArray(data.list) ? data.list : []) {
        const id = String(p && p.id);
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        list.push({ id, name: cleanName(p.name) });
      }
      if (list.length) this.list = list;
      this.next = Math.max(2, Number(data.next) || 0);
      if (this.has(String(data.active))) this.active = String(data.active);
    } catch {
      // fehlt (vor den Profilen) oder kaputt → Fundlisten unten wieder aufnehmen
    }
    this.discover();
  }

  // Fundlisten ohne Eintrag (profiles.json fehlt/kaputt) wieder als Profil aufnehmen
  discover() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // Ordner gibt es noch nicht
    }
    for (const name of names) {
      const match = /^found-(\d+)\.json$/.exec(name);
      if (match && !this.has(match[1])) this.list.push({ id: match[1], name: '' });
    }
    this.next = Math.max(this.next, ...this.list.map((p) => Number(p.id) + 1));
  }

  has(id) {
    return this.list.some((p) => p.id === id);
  }

  get(id) {
    return this.list.find((p) => p.id === id) || null;
  }

  foundFile(id) {
    return path.join(this.dir, id === '1' ? 'found.json' : `found-${id}.json`);
  }

  setActive(id) {
    if (!this.has(id)) return false;
    this.active = id;
    this.save();
    return true;
  }

  add(name) {
    const id = String(this.next++);
    this.list.push({ id, name: cleanName(name) });
    this.save();
    return id;
  }

  rename(id, name) {
    const profile = this.get(id);
    if (!profile) return false;
    profile.name = cleanName(name);
    this.save();
    return true;
  }

  // Nie das letzte Profil; die Fundliste wandert in die Sicherungen statt gelöscht zu werden
  remove(id, backupDir) {
    if (this.list.length < 2 || !this.has(id)) return false;
    backup.setAside(this.foundFile(id), backupDir, 'removed', true);
    this.list = this.list.filter((p) => p.id !== id);
    if (this.active === id) this.active = this.list[0].id;
    this.save();
    return true;
  }

  save() {
    backup.writeAtomic(this.file, JSON.stringify({ active: this.active, next: this.next, list: this.list }, null, 2));
  }
}

module.exports = { ProfileStore, NAME_MAX };
