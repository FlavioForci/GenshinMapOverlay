// Teyvat-Kartenkacheln der externen Quelle.
// Neue Version → in settings.json unter "tileset" überschreiben.
module.exports = {
  version: 'v70-rc1',
  url: 'https://game-cdn.appsample.com/gim/map-teyvat/v70-rc1/{z}/tile-{x}_{y}.jpg',
  blackTiles: 'https://game-cdn.appsample.com/gim/map-teyvat/v70-rc1/black-tile.json',
  minZoom: 10,
  maxZoom: 15,
  // Kachelbereich je Zoomstufe, in URL-Koordinaten
  tileBounds: {
    10: { minX: -2, maxX: 1, minY: -2, maxY: 2 },
    11: { minX: -4, maxX: 3, minY: -4, maxY: 5 },
    12: { minX: -8, maxX: 7, minY: -8, maxY: 11 },
    13: { minX: -16, maxX: 15, minY: -16, maxY: 22 },
    14: { minX: -32, maxX: 31, minY: -32, maxY: 43 },
    15: { minX: -64, maxX: 63, minY: -64, maxY: 86 },
  },
};
