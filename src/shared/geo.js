// lng/lat (Web-Mercator) ↔ Kartenpixel.
// Kartenpixel = Pixel einer z13-Kachel, gemeinsame Einheit von Markern, Referenz und Matcher.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE_SIZE = 256;
  const BASE_ZOOM = 13;
  const WORLD = TILE_SIZE * 2 ** BASE_ZOOM;

  function lngToMapX(lng) {
    return ((lng + 180) / 360) * WORLD;
  }

  function latToMapY(lat) {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
  }

  // Kachel-URLs zählen x ab der Kartenmitte, y nach oben
  function tileToMapRect(z, urlX, urlY) {
    const half = 2 ** (z - 1);
    const tx = urlX + half;
    const ty = half - urlY - 1;
    const size = TILE_SIZE * 2 ** (BASE_ZOOM - z);
    return { x: tx * size, y: ty * size, size };
  }

  function mapToTile(z, mapX, mapY) {
    const size = TILE_SIZE * 2 ** (BASE_ZOOM - z);
    const half = 2 ** (z - 1);
    const tx = Math.floor(mapX / size);
    const ty = Math.floor(mapY / size);
    return { urlX: tx - half, urlY: half - ty - 1 };
  }

  return { TILE_SIZE, BASE_ZOOM, lngToMapX, latToMapY, tileToMapRect, mapToTile };
});
