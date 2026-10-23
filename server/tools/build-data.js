// Baut das Datenpaket für Cloudflare Pages aus dem lokalen Cache, ohne Downloads.
//   node server/tools/build-data.js
// - liest %APPDATA%\Genshin Map Overlay\cache, dazu server/cache/comments.jsonl + photos/ (falls da)
// - schreibt nach server/public/data/
// - Hash im Namen → Datei ändert sich nie, ewig cachebar; nur manifest.json nicht
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TILESET = require('../../src/data/tileset');
const Media = require('../../src/shared/media');
const { decodeMarkers } = require('../../src/data/store');
const { farmTypeKeys, slimComments } = require('./spots');

const SOURCE = path.join(process.env.APPDATA || '.', 'Genshin Map Overlay', 'cache');
const OUT = path.join(__dirname, '..', 'public', 'data');
const CACHE = path.join(__dirname, '..', 'cache');
const COMMENTS_JSONL = path.join(CACHE, 'comments.jsonl');
const COMMENTS_DONE = path.join(CACHE, 'comments-done.txt');
const REFERENCE_LEVELS = [10, 11, 12, 13, 14];
const COMMENT_SHARDS = 512;
// Pages-Limit: 20.000 Dateien pro Seite (Gratis-Tarif)
const PAGES_FILE_LIMIT = 20000;

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

function writeHashed(dir, base, ext, buf) {
  const name = `${base}-${hash(buf)}${ext}`;
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  fs.writeFileSync(path.join(OUT, dir, name), buf);
  return `${dir}/${name}`;
}

function importedPhotos() {
  const root = path.join(CACHE, 'photos');
  const available = new Set();
  if (!fs.existsSync(root)) return available;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.webp')) available.add(`photos/${path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/')}`);
    }
  };
  walk(root);
  return available;
}

// Hardlink statt Kopie: kein doppelter Platz, schneller.
function linkPhotos(used) {
  for (const rel of used) {
    const source = path.join(CACHE, ...rel.split('/'));
    const target = path.join(OUT, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(source, target);
    } catch {
      fs.copyFileSync(source, target);
    }
  }
}

// - kürzt auch ältere, volle Importe auf das, was die Fundort-Karte zeigt (spots.js)
// - Farm-Arten fragt der Import nicht ab → skipTypes, der Server meldet dort „keine Fotos“
// - füllt usedPhotos: nur Fotos, auf die ein Kommentar zeigt, kommen ins Paket
function buildComments(data, photos, usedPhotos) {
  if (!fs.existsSync(COMMENTS_JSONL)) return null;
  const farm = farmTypeKeys(data);
  const shards = Array.from({ length: COMMENT_SHARDS }, () => ({}));
  const index = {};
  for (const line of fs.readFileSync(COMMENTS_JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (farm.has(entry.k.split('/')[0])) continue;
    const id = Number(entry.k.split('/')[1]);
    // Auf eigene Fotos umschreiben; nicht importierte bleiben bei der Quelle.
    const comments = slimComments(entry.c).map((c) => {
      const own = c.i && Media.ownPhotoPath(c.i);
      if (!own || !photos.has(own)) return c;
      usedPhotos.add(own);
      return { ...c, i: own };
    });
    if (!comments.length && !entry.s) continue;
    shards[id % COMMENT_SHARDS][entry.k] = { s: entry.s, c: comments };
    index[entry.k] = comments.length;
  }
  // Ein Ordner pro Version (Hash über alle Shards) → Shards werden nur gemeinsam ausgetauscht.
  const all = Buffer.from(JSON.stringify(shards));
  const dir = `comments/${hash(all)}`;
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  shards.forEach((shard, n) => fs.writeFileSync(path.join(OUT, dir, `${n}.json`), JSON.stringify(shard)));
  const indexPath = writeHashed('comments', 'index', '.json', Buffer.from(JSON.stringify(index)));
  const done = new Set(fs.existsSync(COMMENTS_DONE) ? fs.readFileSync(COMMENTS_DONE, 'utf8').split('\n').filter(Boolean) : []);
  let wanted = 0;
  let missing = 0;
  for (let i = 0; i < data.markers.count; i++) {
    const type = data.types[data.markers.type[i]].key;
    if (farm.has(type)) continue;
    wanted++;
    if (!done.has(`${type}/${data.markers.id[i]}`)) missing++;
  }
  return {
    index: indexPath,
    shardDir: dir,
    shards: COMMENT_SHARDS,
    complete: missing === 0,
    skipTypes: [...farm].sort(),
    markers: Object.keys(index).length,
    queried: wanted - missing,
    wanted,
  };
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const markersBuf = fs.readFileSync(path.join(SOURCE, 'markers.json'));
  const namesBuf = fs.readFileSync(path.join(SOURCE, 'names.json'));
  const data = decodeMarkers(JSON.parse(markersBuf), JSON.parse(namesBuf), 'en');
  const markerCount = data.markers.count;

  const referenceKey = `refdb-v1-${TILESET.version}-${REFERENCE_LEVELS.join('_')}`;
  const referenceBuf = fs.readFileSync(path.join(SOURCE, 'reference', `${referenceKey}.bin`));

  // Fehlende Symbole lädt das Overlay weiter von der Quelle nach.
  const iconDir = path.join(SOURCE, 'icons');
  const icons = fs.readdirSync(iconDir).filter((f) => /^o\d+\.png$/.test(f) && fs.statSync(path.join(iconDir, f)).size > 0);
  fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
  for (const file of icons) fs.copyFileSync(path.join(iconDir, file), path.join(OUT, 'icons', file));

  const photos = importedPhotos();
  const usedPhotos = new Set();
  const comments = buildComments(data, photos, usedPhotos);
  linkPhotos(usedPhotos);

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    markers: writeHashed('markers', 'markers', '.json', markersBuf),
    names: writeHashed('markers', 'names', '.json', namesBuf),
    icons: { dir: 'icons', available: icons.map((f) => f.replace('.png', '')) },
    reference: {
      key: referenceKey,
      file: writeHashed('reference', referenceKey, '.bin', referenceBuf),
      levels: REFERENCE_LEVELS,
      tileset: TILESET.version,
    },
    comments,
    photos: { dir: 'photos', count: usedPhotos.size },
    // Nur für noch nicht importierte Fotos.
    commentImageBase: 'https://game-cdn.appsample.com',
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name))));
  walk(OUT);
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`Datenpaket: ${files.length} Dateien, ${(bytes / 1e6).toFixed(1)} MB → ${OUT}`);
  console.log(`  Marker ${markerCount}, Symbole ${icons.length}, Referenz ${referenceKey}`);
  console.log(`  Fundorte: ${comments ? `${comments.queried}/${comments.wanted} abgefragt (ohne Farm-Arten), ${comments.markers} mit Fotos, Video oder Tipp, vollständig: ${comments.complete}` : 'noch nicht importiert'}`);
  console.log(`  Fotos im Paket ${usedPhotos.size} (importiert ${photos.size})`);
  if (files.length > PAGES_FILE_LIMIT * 0.95) {
    console.log(`  ACHTUNG: ${files.length} Dateien – Cloudflare Pages erlaubt höchstens ${PAGES_FILE_LIMIT}. Fotos dann auf R2 auslagern.`);
  }
}

main();
