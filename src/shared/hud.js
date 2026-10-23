// Bedienelemente der Ingame-Karte, gemessen bei 1080p. Genshin skaliert sie mit der Höhe und
// hängt sie an die Ecken. Genutzt vom Overlay (keine Marker dort) und vom Tracker (keine Punkte dort).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hud = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [Ecke, x0, y0, x1, y1]: x von der Ecke nach innen, „m“ = vertikal mittig
  // - Quest-Liste, Zoom-Regler, Zahnrad, Harz-Leiste + X, Gebietsname
  const ZONES = [
    ['tl', 0, 0, 360, 262],
    ['ml', 0, -125, 78, 125],
    ['bl', 0, 0, 98, 100],
    ['tr', 0, 0, 805, 86],
    ['br', 0, 0, 470, 102],
  ];

  // → [[x0, y0, x1, y1], …] in Pixeln eines W×H-Bildes
  function rects(W, H) {
    const k = H / 1080;
    return ZONES.map(([corner, x0, y0, x1, y1]) => {
      const left = corner.endsWith('l');
      const xa = left ? x0 * k : W - x1 * k;
      const xb = left ? x1 * k : W - x0 * k;
      if (corner[0] === 't') return [xa, y0 * k, xb, y1 * k];
      if (corner[0] === 'b') return [xa, H - y1 * k, xb, H - y0 * k];
      return [xa, H / 2 + y0 * k, xb, H / 2 + y1 * k];
    });
  }

  return { ZONES, rects };
});
