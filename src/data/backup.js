// Sicheres Schreiben und Sicherungen der Fundlisten (found*.json)
const fs = require('fs');
const path = require('path');

// Sicherungen je Fundliste
const KEEP = 20;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Erst Kopie schreiben, dann tauschen: nach Absturz liegt die alte oder die neue Datei ganz da
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Virenscanner/OneDrive halten die Datei manchmal kurz fest
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleep(50);
    }
  }
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

// Ids aus einer Fundliste: fehlt → [], kaputt oder unlesbar → null
function readIds(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.ids)) return data.ids.map(Number).filter(Number.isFinite);
  } catch {
    // kaputt, z. B. halb geschrieben
  }
  return null;
}

// 2026-10-28_14-05-33, sortiert sich als Text richtig
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function parseStamp(text) {
  const [y, mo, d, h, mi, s] = text.split(/[-_]/).map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

// Sicherungen einer Fundliste (backups/<name>.<Zeit>.json), neueste zuerst
function list(dir, base) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.json$`);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ file: path.join(dir, entry.name), stamp: entry.match[1] }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

// Aktuellen Stand sichern, gleicher Inhalt wie die neueste Sicherung → nichts
function snapshot(file, dir) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  const base = path.basename(file, '.json');
  const existing = list(dir, base);
  try {
    if (existing.length && fs.readFileSync(existing[0].file, 'utf8') === text) return null;
  } catch {
    // neueste Sicherung unlesbar → neu sichern
  }
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${base}.${stamp()}.json`);
  fs.writeFileSync(target, text, 'utf8');
  for (const old of list(dir, base).slice(KEEP)) fs.rmSync(old.file, { force: true });
  return target;
}

// Neueste lesbare Sicherung → { ids, stamp } oder null
function latest(dir, base) {
  for (const entry of list(dir, base)) {
    const ids = readIds(entry.file);
    if (ids) return { ids, stamp: entry.stamp };
  }
  return null;
}

// Datei als <name>.<Grund>-<Zeit>.json in die Sicherungen, zählt nicht zu den KEEP
function setAside(file, dir, reason, move) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${path.basename(file, '.json')}.${reason}-${stamp()}.json`);
  if (move) fs.renameSync(file, target);
  else fs.copyFileSync(file, target);
  return target;
}

module.exports = { writeAtomic, readIds, stamp, parseStamp, list, snapshot, latest, setAside };
