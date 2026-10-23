// Filter für den Import: nur, was die Fundort-Karte zeigt (import-comments.js, build-data.js).
const Media = require('../../src/shared/media');

// Farm-Arten ("farm": true in categories.json) haben praktisch nie Fotos → nicht abfragen.
// Ausnahme: Art steht auch in einer anderen Kategorie (z. B. „Empfohlen“).
function farmTypeKeys(data) {
  const farm = new Set();
  const other = new Set();
  for (const cat of data.categories) for (const t of cat.types) (cat.farm ? farm : other).add(t);
  return new Set([...farm].filter((t) => !other.has(t)).map((t) => data.types[t].key));
}

// { a, t, d, v, i } → nur beliebtestes Foto { v, i } und Video { v, t: URL }, sonst nichts.
function slimComments(comments) {
  const photos = new Set(Media.topPhotos(comments, (c) => c.i, (c) => c.v));
  const video = Media.topVideo(comments, (c) => c.t, (c) => c.v);
  const slim = [];
  for (const c of comments) {
    const isVideo = video && video.comment === c;
    if (!photos.has(c) && !isVideo) continue;
    const entry = { v: c.v };
    if (photos.has(c)) entry.i = c.i;
    if (isVideo) entry.t = video.link.url;
    slim.push(entry);
  }
  return slim;
}

module.exports = { farmTypeKeys, slimComments };
