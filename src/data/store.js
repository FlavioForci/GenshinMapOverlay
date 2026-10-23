// Marker, Namen, Symbole, Kommentare und Referenz laden, im Cache-Ordner vorhalten.
// Zuerst eigener Server (serverUrl, Paket aus server/tools/build-data.js), sonst Fallback-Quelle.
const fs = require('fs');
const path = require('path');
const geo = require('../shared/geo');
const DEFAULT_TILESET = require('./tileset');
const CATEGORIES = require('./categories.json');

const MARKERS_URL = 'https://game-data.lemonapi.com/gim/markers_all.v5.compressed.json';
const NAMES_URL = 'https://genshin-impact-map.appsample.com/api/markerNames.json';
const ICON_URL = 'https://game-cdn.appsample.com/gim/markers/{type}.png?v=3';
// gleicher Cache-Server wie die Website
const COMMENTS_URL = 'https://cache-v2.lemonapi.com/comments/v2?app=gim&ttl=1800&collection={type}&docId={id}&page={page}&pageSize={size}';
const COMMENT_PAGE_SIZE = 50;
const COMMENT_IMAGE_BASE = 'https://game-cdn.appsample.com';
const COMMENT_TTL = 30 * 60 * 1000;
const TEYVAT_MID = 2;
const DAY = 24 * 60 * 60 * 1000;
const MANIFEST_TTL = 10 * 60 * 1000;

class DataStore {
  constructor(cacheDir, tileset = DEFAULT_TILESET, serverUrl = '') {
    this.cacheDir = cacheDir;
    this.tileset = tileset;
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.manifestCache = null;
    this.blackTiles = null;
    this.inflight = new Map();
    this.commentCache = new Map();
    this.commentImages = new Map();
    this.commentShards = new Map();
    this.commentIndex = null;
  }

  // null ohne Server bzw. offline ohne lokale Kopie
  async manifest({ force = false } = {}) {
    if (!this.serverUrl) return null;
    if (!force && this.manifestCache && Date.now() - this.manifestCache.at < MANIFEST_TTL) return this.manifestCache.data;
    try {
      const buf = await this.fetchCached(`${this.serverUrl}/data/manifest.json`, this.file('server', 'manifest.json'), { maxAge: force ? 0 : MANIFEST_TTL, force });
      const data = buf ? JSON.parse(buf) : null;
      this.manifestCache = { at: Date.now(), data };
      return data;
    } catch {
      return null;
    }
  }

  // Dateinamen mit Hash ändern sich nie → unbegrenzt cachen
  serverFile(rel) {
    return this.fetchCached(`${this.serverUrl}/data/${rel}`, this.file('server', ...rel.split('/')));
  }

  // fertige Referenz vom Server spart ~3.000 Kacheln und den Aufbau
  async reference(key) {
    const m = await this.manifest();
    if (!m || !m.reference || m.reference.key !== key) return null;
    return this.serverFile(m.reference.file);
  }

  async serverComments(m, type, id) {
    if (!this.commentIndex || this.commentIndex.path !== m.comments.index) {
      this.commentIndex = { path: m.comments.index, data: JSON.parse(await this.serverFile(m.comments.index)) };
    }
    const key = `${type}/${id}`;
    // nicht im Index = sicher leer, nur wenn Import fertig oder Art übersprungen (Farm-Arten)
    if (!this.commentIndex.data[key]) {
      const none = m.comments.complete || (m.comments.skipTypes || []).includes(type);
      return none ? { summary: '', comments: [], hasMore: false } : null;
    }
    const shardPath = `${m.comments.shardDir}/${id % m.comments.shards}.json`;
    if (!this.commentShards.has(shardPath)) {
      if (this.commentShards.size > 30) this.commentShards.delete(this.commentShards.keys().next().value);
      this.commentShards.set(shardPath, JSON.parse(await this.serverFile(shardPath)));
    }
    const entry = this.commentShards.get(shardPath)[key] || { c: [] };
    return {
      summary: entry.s || '',
      comments: entry.c.map((c) => ({ author: c.a || '', text: c.t || '', time: c.d || null, votes: c.v || 0, image: c.i || null })),
      hasMore: false,
    };
  }

  // erst eigener Server; fehlt der Marker dort noch → Fallback-Quelle (30 min im Speicher)
  async comments(type, id, page = 1) {
    if (!/^o\d+$/.test(type) || !Number.isInteger(id) || !Number.isInteger(page) || page < 1) return null;
    const m = await this.manifest();
    if (m && m.comments) {
      if (page > 1) return { summary: '', comments: [], hasMore: false };
      const own = await this.serverComments(m, type, id);
      if (own) return own;
    }
    const key = `${type}/${id}/${page}`;
    const cached = this.commentCache.get(key);
    if (cached && Date.now() - cached.at < COMMENT_TTL) return cached.data;

    const url = COMMENTS_URL.replace('{type}', type).replace('{id}', id).replace('{page}', page).replace('{size}', COMMENT_PAGE_SIZE);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const raw = (body && body.data) || {};
    const comments = (raw.comments || []).map((c) => ({
      author: String(c.aname || '?'),
      text: String(c.content || ''),
      time: c.time || null,
      votes: Number(c.vote) || 0,
      image: typeof c.image === 'string' && /^\/gim\/comments\/[\w/.-]+$/.test(c.image) ? c.image : null,
    }));
    const data = {
      summary: raw.summary && raw.summary.content ? String(raw.summary.content) : '',
      comments,
      hasMore: comments.length >= COMMENT_PAGE_SIZE,
    };
    if (this.commentCache.size > 200) this.commentCache.delete(this.commentCache.keys().next().value);
    this.commentCache.set(key, { at: Date.now(), data });
    return data;
  }

  // nur geprüfte Pfade: photos/….webp vom eigenen Server, /gim/comments/… vom Fallback-CDN
  async commentImage(imagePath) {
    if (typeof imagePath !== 'string' || imagePath.includes('..')) return null;
    if (/^photos\/[\w/.-]+\.webp$/.test(imagePath)) {
      return this.serverUrl ? this.fetchImage(imagePath, `${this.serverUrl}/data/${imagePath}`) : null;
    }
    if (!/^\/gim\/comments\/[\w/.-]+$/.test(imagePath)) return null;
    if (this.commentImages.has(imagePath)) return this.commentImages.get(imagePath);
    const m = await this.manifest();
    const base = (m && m.commentImageBase) || COMMENT_IMAGE_BASE;
    return this.fetchImage(imagePath, base + imagePath);
  }

  async videoThumb(videoId) {
    if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)) return null;
    return this.fetchImage(`yt:${videoId}`, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
  }

  async fetchImage(key, url) {
    if (this.commentImages.has(key)) return this.commentImages.get(key);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (this.commentImages.size > 60) this.commentImages.delete(this.commentImages.keys().next().value);
    this.commentImages.set(key, buf);
    return buf;
  }

  file(...parts) {
    return path.join(this.cacheDir, ...parts);
  }

  // - jünger als maxAge → aus dem Cache, sonst neu laden
  // - offline → ältere Kopie; 404 → als leere Datei merken (null)
  async fetchCached(url, file, { maxAge = Infinity, force = false } = {}) {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (stat && !force && Date.now() - stat.mtimeMs < maxAge) {
      return stat.size ? fs.readFileSync(file) : null;
    }
    if (this.inflight.has(file)) return this.inflight.get(file);

    const job = (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.status === 404) {
          writeFile(file, Buffer.alloc(0));
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFile(file, buf);
        return buf;
      } catch (err) {
        if (stat) return stat.size ? fs.readFileSync(file) : null;
        throw new Error(`${url}: ${err.message}`);
      } finally {
        this.inflight.delete(file);
      }
    })();
    this.inflight.set(file, job);
    return job;
  }

  // lang: Sprache für Markernamen und Kategorien ('de', 'en', …)
  async loadMarkers({ force = false, lang = 'de' } = {}) {
    const m = await this.manifest({ force });
    if (m) {
      const [markersBuf, namesBuf] = await Promise.all([this.serverFile(m.markers), this.serverFile(m.names)]);
      return { updatedAt: Date.parse(m.generatedAt), ...decodeMarkers(JSON.parse(markersBuf), JSON.parse(namesBuf), lang) };
    }
    const [markersBuf, namesBuf] = await Promise.all([
      this.fetchCached(MARKERS_URL, this.file('markers.json'), { maxAge: DAY, force }),
      this.fetchCached(NAMES_URL, this.file('names.json'), { maxAge: DAY, force }),
    ]);
    const updatedAt = fs.statSync(this.file('markers.json')).mtimeMs;
    return { updatedAt, ...decodeMarkers(JSON.parse(markersBuf), JSON.parse(namesBuf), lang) };
  }

  async icon(type) {
    if (!/^o\d+$/.test(type)) return null;
    const m = await this.manifest();
    const url = m && m.icons && m.icons.available.includes(type)
      ? `${this.serverUrl}/data/${m.icons.dir}/${type}.png`
      : ICON_URL.replace('{type}', type);
    return this.fetchCached(url, this.file('icons', `${type}.png`));
  }

  async loadBlackTiles() {
    if (this.blackTiles) return this.blackTiles;
    const buf = await this.fetchCached(this.tileset.blackTiles, this.file('tiles', this.tileset.version, 'black-tile.json'));
    const sets = {};
    const data = buf ? JSON.parse(buf).data || {} : {};
    for (const [z, list] of Object.entries(data)) sets[z] = new Set(String(list).split(','));
    this.blackTiles = sets;
    return sets;
  }

  // x/y in URL-Koordinaten; null außerhalb der Karte oder bei schwarzer Kachel
  async tile(z, x, y) {
    const bounds = this.tileset.tileBounds[z];
    if (!bounds || x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return null;
    const black = await this.loadBlackTiles();
    if (black[z] && black[z].has(`${x}_${y}`)) return null;
    const url = this.tileset.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return this.fetchCached(url, this.file('tiles', this.tileset.version, String(z), `${x}_${y}.jpg`));
  }

  async prefetchTiles(levels, onProgress, concurrency = 12) {
    const jobs = [];
    for (const z of levels) {
      const b = this.tileset.tileBounds[z];
      for (let y = b.minY; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) jobs.push([z, x, y]);
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [z, x, y] = jobs[next++];
        try {
          await this.tile(z, x, y);
        } catch {
          // fehlt → beim Aufbau wie schwarz behandelt
        }
        done++;
        if (onProgress) onProgress(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
}

function writeFile(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

// Format: spaltenweise, nach Typ/ID sortiert, IDs als Differenzen
function decodeMarkers(json, names, lang = 'de') {
  const cols = json.data;
  const total = cols.id.length;
  const deltaCols = (json.encoding && json.encoding.delta) || [];
  const ids = new Array(total);
  let running = 0;
  for (let i = 0; i < total; i++) {
    running = deltaCols.includes('id') ? running + cols.id[i] : cols.id[i];
    ids[i] = running;
  }

  const local = names[lang] || {};
  const en = names.en || {};
  const typeIndex = new Map();
  const types = [];
  const keep = [];
  for (let i = 0; i < total; i++) {
    if (Number(cols.mid[i]) !== TEYVAT_MID) continue;
    keep.push(i);
    const key = cols.type[i];
    if (!typeIndex.has(key)) {
      typeIndex.set(key, types.length);
      types.push({ key, name: local[key] || en[key] || key, count: 0 });
    }
    types[typeIndex.get(key)].count++;
  }

  const n = keep.length;
  const markers = {
    count: n,
    id: new Int32Array(n),
    type: new Uint16Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    level: new Uint8Array(n),
  };
  keep.forEach((src, i) => {
    markers.id[i] = ids[src];
    markers.type[i] = typeIndex.get(cols.type[src]);
    markers.x[i] = geo.lngToMapX(Number(cols.lng[src]));
    markers.y[i] = geo.latToMapY(Number(cols.lat[src]));
    markers.level[i] = Number(cols.level[src]) || 0;
  });

  // Typen ohne Kategorie → "Weitere"/"Other"
  const categorized = new Set();
  const categories = CATEGORIES.map((cat) => {
    const items = cat.items.filter((key) => typeIndex.has(key)).map((key) => typeIndex.get(key));
    items.forEach((t) => categorized.add(t));
    return { key: cat.key, title: cat.title[lang] || cat.title.en, farm: !!cat.farm, types: items };
  }).filter((cat) => cat.types.length);
  const rest = types.map((_, i) => i).filter((i) => !categorized.has(i));
  rest.sort((a, b) => types[a].name.localeCompare(types[b].name, lang));
  if (rest.length) categories.push({ key: 'other', title: lang === 'de' ? 'Weitere' : 'Other', types: rest });

  return { types, categories, markers };
}

module.exports = { DataStore, decodeMarkers, COMMENT_IMAGE_BASE };
