// Overlay: Marker auf der Ingame-Karte + Panel.
// Maus nur über Marker/Panel abfangen, sonst geht alles ans Spiel (ziehen, zoomen, Wegpunkte).
/* global I18n, Media, Hud */
const api = window.overlayApi;
const $ = (id) => document.getElementById(id);

const canvas = $('markers');
const ctx = canvas.getContext('2d');
const BUSY_PHASES = ['starting', 'loading', 'download', 'building'];
const ERROR_PHASES = ['error', 'capture-error'];
const MAX_DRAWN = 5000;

let settings = { language: 'en', enabledTypes: [], hideFound: false, opacity: 1, markerSize: 26, hotkeys: {}, active: true };
let data = null;
let typeIndexByKey = new Map();
let markerIndexById = new Map();
let markersByType = [];
let enabled = new Set();
let found = new Set();
let foundByType = new Uint32Array(0);
let trackerStatus = { phase: 'starting', message: '', progress: 0 };
let target = null;
let velocity = null;
let view = null;
let visibility = 0;
let hover = -1;
let drawnCount = 0;
const drawnIndex = new Int32Array(MAX_DRAWN);
const drawnX = new Float32Array(MAX_DRAWN);
const drawnY = new Float32Array(MAX_DRAWN);
let panelOpen = false;
let captured = false;
let frameRequested = false;
let mouse = { x: -1, y: -1 };
let toastTimer;
let spot = null;
let spotCloseTimer;
const mediaUrls = new Map();
const MAX_MEDIA_URLS = 40;

const iconBytes = new Map();
const iconBitmaps = new Map();
const iconUrls = new Map();

// ---------- Hilfsfunktionen ----------

const tt = (key, params) => I18n.t(settings.language, key, params);

// 1 bei 1080p, 2 bei 4K: Größen skalieren mit der Höhe wie die Genshin-UI (--u in overlay.css)
const uiScale = () => innerHeight / 1080;

function applyStaticTexts() {
  document.documentElement.lang = I18n.resolve(settings.language);
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tt(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = tt(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', tt(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tt(el.dataset.i18nPlaceholder);
}

function requestDraw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(tick);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function setCapture(on) {
  if (on === captured) return;
  captured = on;
  api.mouse(on);
}

function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function loadIconBytes(key) {
  if (!iconBytes.has(key)) iconBytes.set(key, api.icon(key).catch(() => null));
  return iconBytes.get(key);
}

function iconBitmap(key) {
  if (iconBitmaps.has(key)) return iconBitmaps.get(key);
  iconBitmaps.set(key, null);
  loadIconBytes(key).then(async (bytes) => {
    if (!bytes || !bytes.length) return;
    iconBitmaps.set(key, await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
    requestDraw();
  });
  return null;
}

async function iconUrl(key) {
  if (iconUrls.has(key)) return iconUrls.get(key);
  const bytes = await loadIconBytes(key);
  const url = bytes && bytes.length ? URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) : null;
  iconUrls.set(key, url);
  return url;
}

// ---------- Ansicht (vom Tracker) ----------

function isJump(a, b) {
  const ratio = a.sx / b.sx;
  return ratio > 1.4 || ratio < 0.7 || Math.abs(a.ox - b.ox) > 0.25 || Math.abs(a.oy - b.oy) > 0.25;
}

// Messrauschen (2-7 px pro Bild) glätten, One-Euro-Filter:
// - langsam/still → stark glätten, schnell → kaum (kein Nachziehen beim Ziehen/Zoomen)
// - gefiltert: Zoom (log) und Kartenpunkt in Bildschirmmitte, Tempo in Bildschirmpixeln/s
const FILTER_MIN_HZ = 0.4;
const FILTER_BETA = 0.015;

class OneEuro {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  filter(x, t, pxPerUnit) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    this.t = t;
    const alpha = (hz) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));
    this.dx += alpha(1) * ((x - this.x) / dt - this.dx);
    this.x += alpha(FILTER_MIN_HZ + FILTER_BETA * Math.abs(this.dx) * pxPerUnit) * (x - this.x);
    return this.x;
  }
}

const viewFilter = { zoom: new OneEuro(), cx: new OneEuro(), cy: new OneEuro() };

// y-Maßstab getrennt halten (k = y/x):
// - Aufnahme nicht exakt im Bildschirmverhältnis, z. B. 1366×768 → 1280×720 (gerundet), k ≈ 1,0005
// - Kartenpixel um 1e6 → schon 0,05 % ergeben sonst Hunderte Pixel Versatz
function smoothView(next, t) {
  const W = innerWidth;
  const H = innerHeight;
  const s = next.sx * W;
  const k = (next.sy * H) / s;
  const ls = viewFilter.zoom.filter(Math.log(s), t, H / 2);
  const fs = Math.exp(ls);
  const cx = viewFilter.cx.filter((W / 2 - next.ox * W) / s, t, fs);
  const cy = viewFilter.cy.filter((H / 2 - next.oy * H) / (s * k), t, fs);
  return { ...next, sx: fs / W, sy: (fs * k) / H, ox: (W / 2 - fs * cx) / W, oy: (H / 2 - fs * k * cy) / H };
}

// Restschwankung unter STICK_PX (bei 1080p): Marker bleiben exakt stehen
const STICK_PX = 2;

// größte Verschiebung zwischen zwei Ansichten in Bildschirmpixeln (Ecken + Mitte)
function viewShift(a, b) {
  let worst = 0;
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    const mx = (px - a.ox) / a.sx;
    const my = (py - a.oy) / a.sy;
    worst = Math.max(worst, Math.hypot((b.sx * mx + b.ox - px) * innerWidth, (b.sy * my + b.oy - py) * innerHeight));
  }
  return worst;
}

function holdStill(current, next) {
  return !!current && viewShift(current, next) < STICK_PX * (innerHeight / 1080);
}

// Zwischen zwei Erkennungen (ca. 70-100 ms) mit letzter Geschwindigkeit weiterrechnen,
// sonst stehen die Marker beim Ziehen/Zoomen kurz und springen dann.
const PREDICT_MAX_MS = 120;
const PREDICT_LEAD_MS = 30;

function updateVelocity(prev, next) {
  const dt = next.at - prev.at;
  if (dt <= 0 || dt > 400 || isJump(prev, next)) {
    velocity = null;
    return;
  }
  const v = {
    ls: (Math.log(next.sx) - Math.log(prev.sx)) / dt,
    ox: (next.ox - prev.ox) / dt,
    oy: (next.oy - prev.oy) / dt,
  };
  velocity = velocity
    ? { ls: (velocity.ls + v.ls) / 2, ox: (velocity.ox + v.ox) / 2, oy: (velocity.oy + v.oy) / 2 }
    : v;
}

function predicted(now) {
  if (!velocity) return target;
  const dt = Math.min(PREDICT_MAX_MS, now - target.at + PREDICT_LEAD_MS);
  const f = Math.exp(velocity.ls * dt);
  return { sx: target.sx * f, sy: target.sy * f, ox: target.ox + velocity.ox * dt, oy: target.oy + velocity.oy * dt };
}

function tick(now) {
  frameRequested = false;
  let animating = false;
  if (target) {
    const goal = predicted(now);
    if (!view || isJump(view, goal)) {
      view = { ...goal };
    } else {
      // Weich nachziehen, damit kleine Messschwankungen nicht zittern.
      for (const k of ['sx', 'sy', 'ox', 'oy']) view[k] += (goal[k] - view[k]) * 0.5;
      const dx = Math.abs(goal.ox - view.ox) * innerWidth;
      const dy = Math.abs(goal.oy - view.oy) * innerHeight;
      animating = dx > 0.3 || dy > 0.3 || Math.abs(goal.sx / view.sx - 1) > 0.001;
    }
    if (velocity && now - target.at < PREDICT_MAX_MS) animating = true;
    visibility = Math.min(1, visibility + 0.25);
  } else {
    visibility = Math.max(0, visibility - 0.2);
  }
  animating = animating || (target ? visibility < 1 : visibility > 0);
  draw();
  if (animating) requestDraw();
}

function draw() {
  const W = innerWidth;
  const H = innerHeight;
  ctx.clearRect(0, 0, W, H);
  drawnCount = 0;
  if (!data || !view || visibility <= 0) {
    updateHover();
    return;
  }

  const u = uiScale();
  const size = settings.markerSize * u;
  const half = size / 2;
  // keine Marker über den Knöpfen der Ingame-Karte (verdecken sie, fangen Klicks ab)
  const hud = Hud.rects(W, H);
  const underHud = (x, y) => hud.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const { x: mx, y: my, id: ids } = data.markers;
  const ax = view.sx * W;
  const bx = view.ox * W;
  const ay = view.sy * H;
  const by = view.oy * H;
  const baseAlpha = settings.opacity * visibility;

  // Symbole sind Stecknadeln wie im Spiel: Spitze (unten Mitte) sitzt auf der Markerposition.
  // (x, y) = Spitze, cy = Symbolmitte
  for (const t of enabled) {
    const list = markersByType[t];
    if (!list) continue;
    const icon = iconBitmap(data.types[t].key);
    for (let k = 0; k < list.length && drawnCount < MAX_DRAWN; k++) {
      const i = list[k];
      const x = ax * mx[i] + bx;
      const y = ay * my[i] + by;
      if (x < -half || y < 0 || x > W + half || y > H + size) continue;
      const isFound = found.has(ids[i]);
      if (isFound && settings.hideFound) continue;
      const cy = y - half;
      if (underHud(x, cy)) continue;

      ctx.globalAlpha = baseAlpha * (isFound ? 0.35 : 1);
      if (icon) {
        // ganze Pixel: kein Flimmern der Kanten bei Bruchteil-Bewegungen
        ctx.drawImage(icon, Math.round(x - half), Math.round(y - size), Math.round(size), Math.round(size));
      } else {
        ctx.fillStyle = '#d3bc8e';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, half * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
      if (isFound) drawCheck(x + half * 0.5, cy - half * 0.5, Math.max(6 * u, size * 0.28));

      drawnIndex[drawnCount] = i;
      drawnX[drawnCount] = x;
      drawnY[drawnCount] = cy;
      drawnCount++;
    }
  }
  ctx.globalAlpha = 1;
  updateHover();
  if (hover >= 0) {
    const x = ax * mx[hover] + bx;
    const cy = ay * my[hover] + by - half;
    ctx.strokeStyle = '#ffe6b2';
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.arc(x, cy, half + 3 * u, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (spot) {
    const x = ax * mx[spot.index] + bx;
    const cy = ay * my[spot.index] + by - half;
    ctx.globalAlpha = visibility;
    ctx.strokeStyle = '#d3bc8e';
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.arc(x, cy, half + 6 * u, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawCheck(x, y, r) {
  ctx.globalAlpha = Math.min(1, settings.opacity * visibility);
  ctx.fillStyle = '#3f9d57';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, r * 0.3);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.45, y);
  ctx.lineTo(x - r * 0.1, y + r * 0.4);
  ctx.lineTo(x + r * 0.5, y - r * 0.35);
  ctx.stroke();
}

// ---------- Maus ----------

function overPanel(x, y) {
  const inside = (el) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  // Lightbox deckt alles ab, Klick irgendwo schließt sie.
  if (!$('lightbox').hidden) return true;
  if (panelOpen && inside($('panel'))) return true;
  if (spot && inside($('spot'))) return true;
  return !$('panel-handle').hidden && inside($('panel-handle'));
}

function renderHandle() {
  const show = !!target && !panelOpen;
  const handle = $('panel-handle');
  if (handle.hidden === !show) return;
  handle.hidden = !show;
  updateHover();
}

function updateHover() {
  const radius = (settings.markerSize / 2 + 3) * uiScale();
  let best = -1;
  let bestDist = radius * radius;
  if (mouse.x >= 0 && !overPanel(mouse.x, mouse.y)) {
    for (let k = 0; k < drawnCount; k++) {
      const dx = drawnX[k] - mouse.x;
      const dy = drawnY[k] - mouse.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = drawnIndex[k];
      }
    }
  }
  if (best !== hover) {
    hover = best;
    requestDraw();
  }
  setCapture(hover >= 0 || overPanel(mouse.x, mouse.y));
  renderTooltip();
}

function renderTooltip() {
  const el = $('tooltip');
  if (hover < 0 || !data) {
    el.hidden = true;
    return;
  }
  const type = data.types[data.markers.type[hover]];
  const isFound = found.has(data.markers.id[hover]);
  $('tooltip-name').textContent = type.name;
  $('tooltip-hint').textContent = tt(isFound ? 'ui.tipFound' : 'ui.tipOpen');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const u = uiScale();
  el.style.left = `${Math.min(mouse.x + 16 * u, innerWidth - r.width - 8 * u)}px`;
  el.style.top = `${Math.min(mouse.y + 16 * u, innerHeight - r.height - 8 * u)}px`;
}

window.addEventListener('mousemove', (event) => {
  mouse = { x: event.clientX, y: event.clientY };
  updateHover();
});

window.addEventListener('mouseleave', () => {
  mouse = { x: -1, y: -1 };
  updateHover();
});

// Gepollte Cursorposition aus main.js: Ist Genshin vorne, kommen keine Mausevents an.
api.on('cursor', (point) => {
  const inside = point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight;
  mouse = inside ? point : { x: -1, y: -1 };
  updateHover();
});

window.addEventListener('mousedown', (event) => {
  if (hover < 0 || overPanel(event.clientX, event.clientY)) return;
  if (event.button === 0) {
    event.preventDefault();
    openSpot(hover);
  } else if (event.button === 2) {
    event.preventDefault();
    toggleFoundMarker(hover);
  }
});
window.addEventListener('contextmenu', (event) => event.preventDefault());

function toggleFoundMarker(index) {
  const id = data.markers.id[index];
  setFound(id, !found.has(id));
  api.toggleFound(id);
}

// ---------- Gefunden ----------

function recountFound() {
  if (!data) return;
  foundByType = new Uint32Array(data.types.length);
  for (const id of found) {
    const i = markerIndexById.get(id);
    if (i !== undefined) foundByType[data.markers.type[i]]++;
  }
}

function setFound(id, isFound) {
  if (found.has(id) === isFound) return;
  if (isFound) found.add(id);
  else found.delete(id);
  const i = markerIndexById.get(id);
  if (i !== undefined) {
    foundByType[data.markers.type[i]] += isFound ? 1 : -1;
    updateTypeCount(data.markers.type[i]);
  }
  if (spot && data.markers.id[spot.index] === id) renderSpotFound();
  requestDraw();
}

// ---------- Fundort-Karte ----------

// Auswahl wie beim Import (shared/media.js) → genau diese Fotos liegen auf dem eigenen Server
function spotMedia(items) {
  const votesOf = (item) => item.votes;
  const media = Media.topPhotos(items, (item) => item.image, votesOf).map((item) => ({ image: item.image, votes: item.votes }));
  const video = Media.topVideo(items, (item) => item.text, votesOf);
  if (video) media.push(video.link);
  return media;
}

async function openSpot(index) {
  clearTimeout(spotCloseTimer);
  closeLightbox();
  spot = { index, media: [], summary: '', loading: false, error: false };
  const type = data.types[data.markers.type[index]];
  $('spot-name').textContent = type.name;
  $('spot-icon').removeAttribute('src');
  iconUrl(type.key).then((url) => {
    if (url && spot && spot.index === index) $('spot-icon').src = url;
  });
  $('spot').classList.add('open');
  $('spot-body').scrollTop = 0;
  renderSpotFound();
  requestDraw();
  await loadSpot();
}

function closeSpot() {
  clearTimeout(spotCloseTimer);
  closeLightbox();
  spot = null;
  $('spot').classList.remove('open');
  updateHover();
  requestDraw();
}

async function loadSpot() {
  const current = spot;
  if (!current || current.loading) return;
  current.loading = true;
  current.error = false;
  renderSpot();
  const typeKey = data.types[data.markers.type[current.index]].key;
  const result = await api.comments(typeKey, data.markers.id[current.index], 1).catch(() => null);
  if (spot !== current) return; // inzwischen ein anderer Marker gewählt
  current.loading = false;
  if (!result || result.error) {
    current.error = true;
  } else {
    current.summary = result.summary;
    current.media = spotMedia(result.comments);
  }
  renderSpot();
}

function renderSpotFound() {
  if (!spot) return;
  const isFound = found.has(data.markers.id[spot.index]);
  const button = $('spot-found');
  button.textContent = tt(isFound ? 'spot.markOpen' : 'spot.markFound');
  button.classList.toggle('done', isFound);
}

function spotNote(text, buttonText, onClick) {
  const note = document.createElement('div');
  note.className = 'spot-note';
  note.textContent = text;
  if (buttonText) {
    const button = document.createElement('button');
    button.className = 'gi-btn small';
    button.type = 'button';
    button.textContent = buttonText;
    button.addEventListener('click', onClick);
    note.append(document.createElement('br'), button);
  }
  return note;
}

function renderSpot() {
  const body = $('spot-body');
  body.textContent = '';
  if (!spot) return;
  const s = spot;
  if (s.loading) {
    body.append(mediaTile(null));
    return;
  }
  if (s.error) {
    body.append(spotNote(tt('spot.failed'), tt('spot.retry'), loadSpot));
    return;
  }
  if (s.media.length) {
    const media = document.createElement('div');
    media.className = 'media';
    for (const item of s.media) media.append(mediaTile(item));
    body.append(media);
  } else {
    body.append(spotNote(tt('spot.none')));
  }
  if (s.summary) {
    const summary = document.createElement('div');
    summary.className = 'summary';
    const label = document.createElement('small');
    label.textContent = tt('spot.summary');
    const text = document.createElement('p');
    text.textContent = s.summary;
    summary.append(label, text);
    summary.addEventListener('click', () => summary.classList.toggle('expanded'));
    body.append(summary);
  }
}

// ohne item: Platzhalter während des Ladens
function mediaTile(item) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'media-tile loading';
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => tile.classList.remove('loading'));
  tile.append(img);
  if (!item) {
    tile.disabled = true;
    return tile;
  }
  const badge = document.createElement('span');
  badge.className = 'media-badge';
  if (item.videoId) {
    tile.classList.add('video');
    tile.title = tt('spot.video');
    const play = document.createElement('span');
    play.className = 'play';
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19.5 12z"/></svg>';
    badge.textContent = 'YouTube';
    tile.append(play);
    tile.addEventListener('click', () => api.openLink(item.url));
    loadMediaImage(tile, img, `yt:${item.videoId}`, () => api.videoThumb(item.videoId));
  } else {
    tile.title = tt('spot.enlarge');
    if (item.votes > 0) {
      badge.textContent = `▲ ${item.votes}`;
      badge.title = tt('spot.votes', { n: item.votes });
    }
    tile.addEventListener('click', () => {
      if (img.src) openLightbox(img.src);
    });
    loadMediaImage(tile, img, item.image, () => api.commentImage(item.image));
  }
  tile.append(badge);
  return tile;
}

async function loadMediaImage(tile, img, key, fetchBytes) {
  let url = mediaUrls.get(key);
  if (!url) {
    const bytes = await fetchBytes().catch(() => null);
    if (!bytes || !bytes.length) {
      tile.remove();
      return;
    }
    url = URL.createObjectURL(new Blob([bytes]));
    mediaUrls.set(key, url);
    if (mediaUrls.size > MAX_MEDIA_URLS) {
      const [oldKey, oldUrl] = mediaUrls.entries().next().value;
      mediaUrls.delete(oldKey);
      URL.revokeObjectURL(oldUrl);
    }
  }
  img.src = url;
}

function openLightbox(url) {
  $('lightbox-img').src = url;
  $('lightbox').hidden = false;
  updateHover();
}

function closeLightbox() {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true;
  $('lightbox-img').removeAttribute('src');
  updateHover();
}

// ---------- Panel ----------

function setPanel(open) {
  panelOpen = open;
  $('panel').classList.toggle('open', open);
  if (!open) $('search').blur();
  // Außerhalb der Karte hält Genshin den Mauszeiger fest, ans Panel nur mit Alt.
  if (open && !target) showToast(tt('ui.altHint'));
  renderHandle();
  updateHover();
}

function typeLabel(t) {
  return `${foundByType[t] || 0}/${data.types[t].count}`;
}

function updateTypeCount(t) {
  for (const el of document.querySelectorAll(`.type-row[data-type="${t}"] .count`)) el.textContent = typeLabel(t);
}

function updateCategoryHeads() {
  for (const cat of document.querySelectorAll('.cat')) {
    const types = cat.dataset.types.split(',').map(Number);
    const on = types.filter((t) => enabled.has(t)).length;
    cat.querySelector('.cat-count').textContent = `${on}/${types.length}`;
    const all = cat.querySelector('.cat-all');
    all.checked = on === types.length;
    all.indeterminate = on > 0 && on < types.length;
  }
  for (const box of document.querySelectorAll('.type-row input')) box.checked = enabled.has(Number(box.dataset.type));
  $('enabled-count').textContent = tt('ui.enabledCount', { n: enabled.size });
}

function saveEnabled() {
  api.saveSettings({ enabledTypes: [...enabled].map((t) => data.types[t].key) });
  updateCategoryHeads();
  requestDraw();
}

const iconObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    iconObserver.unobserve(img);
    iconUrl(img.dataset.key).then((url) => { if (url) img.src = url; });
  }
}, { root: document.querySelector('#panel .panel-scroll') });

function buildPanel() {
  const root = $('categories');
  root.textContent = '';
  data.categories.forEach((cat, index) => {
    const section = document.createElement('section');
    section.className = index === 0 ? 'cat open' : 'cat';
    section.dataset.types = cat.types.join(',');

    const head = document.createElement('div');
    head.className = 'cat-head';
    head.innerHTML = '<span class="diamond"></span><span class="cat-title"></span><span class="cat-count"></span><input class="cat-all" type="checkbox">';
    head.querySelector('.cat-title').textContent = cat.title;
    head.querySelector('.cat-all').title = tt('ui.categoryToggle');
    head.addEventListener('click', (event) => {
      if (event.target.classList.contains('cat-all')) return;
      section.classList.toggle('open');
    });
    head.querySelector('.cat-all').addEventListener('change', (event) => {
      for (const t of cat.types) {
        if (event.target.checked) enabled.add(t);
        else enabled.delete(t);
      }
      saveEnabled();
    });

    const list = document.createElement('div');
    list.className = 'cat-list';
    for (const t of cat.types) {
      const type = data.types[t];
      const row = document.createElement('label');
      row.className = 'pill type-row';
      row.dataset.type = t;
      row.dataset.name = type.name.toLowerCase();
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.type = t;
      box.addEventListener('change', () => {
        if (box.checked) enabled.add(t);
        else enabled.delete(t);
        saveEnabled();
      });
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.key = type.key;
      iconObserver.observe(img);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = type.name;
      const count = document.createElement('span');
      count.className = 'count value-box';
      count.textContent = typeLabel(t);
      row.append(img, name, count, box);
      list.append(row);
    }
    section.append(head, list);
    root.append(section);
  });
  updateCategoryHeads();
  applySearch();
}

function applySearch() {
  const query = $('search').value.trim().toLowerCase();
  let any = false;
  for (const section of document.querySelectorAll('.cat')) {
    let matches = 0;
    for (const row of section.querySelectorAll('.type-row')) {
      const hit = !query || row.dataset.name.includes(query);
      row.hidden = !hit;
      if (hit) matches++;
    }
    section.hidden = query && matches === 0;
    if (query && matches) section.classList.add('open');
    any = any || matches > 0;
  }
  let empty = $('categories').querySelector('.empty');
  if (!any && query) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      $('categories').append(empty);
    }
    empty.textContent = tt('ui.noResults', { query: $('search').value.trim() });
  } else if (empty) {
    empty.remove();
  }
}

function renderStatus() {
  const phase = trackerStatus.phase;
  let state = 'search';
  let text = tt('ui.searching');
  if (BUSY_PHASES.includes(phase)) {
    state = 'busy';
    text = trackerStatus.message;
  } else if (ERROR_PHASES.includes(phase)) {
    state = 'error';
    text = trackerStatus.message;
  } else if (target) {
    state = 'locked';
    text = tt('ui.locked');
  } else if (phase === 'paused') {
    text = trackerStatus.message;
  }
  $('status').dataset.state = state;
  $('status-text').textContent = text;

  // Vorbereitung/Fehler auch bei geschlossenem Panel zeigen
  const hud = $('hud');
  hud.hidden = !(state === 'busy' || state === 'error');
  $('hud-text').textContent = text;
  $('hud-progress').style.width = `${Math.round((trackerStatus.progress || 0) * 100)}%`;
}

function renderSettings() {
  $('hide-found').checked = settings.hideFound;
  $('show-captures').checked = !!settings.showInCaptures;
  $('opacity').value = Math.round(settings.opacity * 100);
  $('opacity-value').textContent = `${Math.round(settings.opacity * 100)} %`;
  $('size').value = settings.markerSize;
  $('size-value').textContent = `${settings.markerSize} px`;
  updateRangeFill($('opacity'));
  updateRangeFill($('size'));
  const hk = settings.hotkeys || {};
  $('kbd-found').textContent = hk.toggleFound || '';
  const keys = [
    hk.toggleOverlay && `${hk.toggleOverlay} ${tt('ui.key.toggleOverlay')}`,
    hk.togglePanel && `${hk.togglePanel} ${tt('ui.key.togglePanel')}`,
    hk.toggleFound && `${hk.toggleFound} ${tt('ui.key.toggleFound')}`,
    hk.cycleOpacity && `${hk.cycleOpacity} ${tt('ui.key.cycleOpacity')}`,
  ].filter(Boolean).join(' · ');
  const errors = settings.hotkeyErrors || [];
  $('keys').textContent = errors.length ? `${keys} – ${tt('ui.keysUnavailable', { keys: errors.join(', ') })}` : keys;
  $('keys').classList.toggle('error', errors.length > 0);
}

function renderDataInfo() {
  if (!data) return;
  const locale = I18n.locale(settings.language);
  const when = new Date(data.updatedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  $('data-info').textContent = tt('ui.dataInfo', { count: data.markers.count.toLocaleString(locale), date: when });
}

// ---------- Bedienelemente ----------

$('close-panel').addEventListener('click', () => setPanel(false));
$('panel-handle').addEventListener('click', () => setPanel(true));
$('close-spot').addEventListener('click', closeSpot);
$('lightbox').addEventListener('click', closeLightbox);
$('spot-found').addEventListener('click', () => {
  if (spot) toggleFoundMarker(spot.index);
});
$('none').addEventListener('click', () => {
  enabled.clear();
  saveEnabled();
});
$('refresh').addEventListener('click', () => {
  $('data-info').textContent = tt('ui.loadingData');
  api.refreshData();
});
$('hide-found').addEventListener('change', (event) => api.saveSettings({ hideFound: event.target.checked }));
$('show-captures').addEventListener('change', (event) => api.saveSettings({ showInCaptures: event.target.checked }));
// --fill: Regler links vom Griff hell, rechts dunkel (overlay.css)
function updateRangeFill(input) {
  const share = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--fill', `${Math.round(share * 100)}%`);
}

$('opacity').addEventListener('input', (event) => {
  settings.opacity = Number(event.target.value) / 100;
  $('opacity-value').textContent = `${event.target.value} %`;
  updateRangeFill(event.target);
  api.saveSettings({ opacity: settings.opacity });
  requestDraw();
});
$('size').addEventListener('input', (event) => {
  settings.markerSize = Number(event.target.value);
  $('size-value').textContent = `${event.target.value} px`;
  updateRangeFill(event.target);
  api.saveSettings({ markerSize: settings.markerSize });
  requestDraw();
});

// Fokus dem Spiel nur nehmen, solange im Suchfeld getippt wird.
const search = $('search');
search.addEventListener('mousedown', () => {
  api.keyboard(true);
  setTimeout(() => search.focus(), 30);
});
search.addEventListener('blur', () => api.keyboard(false));
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Enter') search.blur();
});
search.addEventListener('input', applySearch);

// ---------- Nachrichten vom Hauptprozess ----------

api.on('settings', (next) => {
  const languageChanged = next.language !== settings.language;
  settings = next;
  if (languageChanged) {
    applyStaticTexts();
    renderStatus();
    renderDataInfo();
    renderSpot();
    renderSpotFound();
  }
  if (data) {
    enabled = new Set(settings.enabledTypes.map((k) => typeIndexByKey.get(k)).filter((t) => t !== undefined));
    updateCategoryHeads();
  }
  renderSettings();
  requestDraw();
});

api.on('data:markers', (payload) => {
  // Neue Daten → andere Indizes, offene Fundort-Karte schließen
  if (spot) closeSpot();
  data = payload;
  typeIndexByKey = new Map(data.types.map((t, i) => [t.key, i]));
  markerIndexById = new Map();
  const buckets = data.types.map(() => []);
  for (let i = 0; i < data.markers.count; i++) {
    buckets[data.markers.type[i]].push(i);
    markerIndexById.set(data.markers.id[i], i);
  }
  markersByType = buckets.map((b) => Int32Array.from(b));
  enabled = new Set(settings.enabledTypes.map((k) => typeIndexByKey.get(k)).filter((t) => t !== undefined));
  recountFound();
  buildPanel();
  renderDataInfo();
  requestDraw();
});

api.on('found:all', (ids) => {
  found = new Set(ids.map(Number));
  recountFound();
  if (data) for (let t = 0; t < data.types.length; t++) updateTypeCount(t);
  requestDraw();
});

api.on('found:changed', ({ id, found: isFound }) => setFound(id, isFound));

api.on('tracker:status', (next) => {
  trackerStatus = next;
  renderStatus();
});

api.on('view', (next) => {
  const wasLocked = !!target;
  if (next.locked) {
    const now = performance.now();
    if (!target || isJump(target, next)) Object.values(viewFilter).forEach((f) => f.reset());
    const stamped = { ...smoothView(next, now), at: now };
    if (holdStill(target, stamped)) {
      velocity = null;
    } else {
      if (target) updateVelocity(target, stamped);
      else velocity = null;
      target = stamped;
    }
  } else {
    target = null;
    velocity = null;
  }
  if (wasLocked !== !!target) {
    renderStatus();
    renderHandle();
    // Verzögert: beim schnellen Ziehen geht die Karte oft nur kurz verloren
    clearTimeout(spotCloseTimer);
    if (!target && spot) {
      spotCloseTimer = setTimeout(() => {
        if (!target) closeSpot();
      }, 1500);
    }
  }
  requestDraw();
});

api.on('notice', showToast);
api.on('panel:toggle', () => setPanel(!panelOpen));

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
applyStaticTexts();
renderSettings();
renderStatus();
