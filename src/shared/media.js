// Foto-Auswahl je Fundort, geteilt mit server/tools/import-photos.js
// → der eigene Server hat genau die Fotos, die das Overlay zeigt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Media = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // nur das beliebteste Foto (+ ggf. Video): hält Import und Datenpaket klein
  const PHOTOS_PER_SPOT = 1;

  function byVotes(list, votesOf) {
    return list.map((item, order) => ({ item, order }))
      .sort((a, b) => votesOf(b.item) - votesOf(a.item) || a.order - b.order)
      .map((entry) => entry.item);
  }

  function topPhotos(comments, imageOf, votesOf) {
    return byVotes(comments.filter(imageOf), votesOf).slice(0, PHOTOS_PER_SPOT);
  }

  // erster YouTube-Link → { videoId, url }, url bereinigt, Startzeit bleibt
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:\S*?&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;
  function youtubeLink(text) {
    for (const match of String(text || '').matchAll(URL_RE)) {
      const id = (match[0].match(YOUTUBE_RE) || [])[1];
      if (!id) continue;
      const start = (match[0].match(/[?&]t=(\d+[hms\d]*)/) || [])[1];
      return { videoId: id, url: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}` : ''}` };
    }
    return null;
  }

  function topVideo(comments, textOf, votesOf) {
    for (const comment of byVotes(comments, votesOf)) {
      const link = youtubeLink(textOf(comment));
      if (link) return { comment, link };
    }
    return null;
  }

  // Quellpfad /gim/comments/o111/8989/….jpg → photos/o111/8989/….webp im eigenen Datenpaket
  function ownPhotoPath(sourcePath) {
    const match = /^\/gim\/comments\/([\w/-]+?(?:\.[\w-]+)*?)(?:\.(?:jpe?g|png|gif|webp))?$/i.exec(sourcePath || '');
    return match && !match[1].includes('..') ? `photos/${match[1]}.webp` : null;
  }

  return { PHOTOS_PER_SPOT, byVotes, topPhotos, youtubeLink, topVideo, ownPhotoPath };
});
