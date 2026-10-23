// Referenz (Merkmale der ganzen Karte) aus den Kacheln aufbauen.
// loadTileRgba(z, urlX, urlY) → 256×256 RGBA oder null (schwarz/fehlt).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher-core'), require('../shared/geo'));
  else root.ReferenceBuilder = factory(root.MatcherCore, root.Geo);
})(typeof self !== 'undefined' ? self : this, function (MatcherCore, Geo) {
  const TILE = 256;
  const CORE_TILES = 6;
  const MARGIN_TILES = 1;

  function blocksForLevel(tileset, z) {
    const b = tileset.tileBounds[z];
    const half = 2 ** (z - 1);
    const tx0 = b.minX + half;
    const tx1 = b.maxX + half;
    const ty0 = half - b.maxY - 1;
    const ty1 = half - b.minY - 1;
    const blocks = [];
    for (let by = ty0; by <= ty1; by += CORE_TILES) {
      for (let bx = tx0; bx <= tx1; bx += CORE_TILES) {
        blocks.push({ z, coreTx: bx, coreTy: by, coreW: Math.min(CORE_TILES, tx1 - bx + 1), coreH: Math.min(CORE_TILES, ty1 - by + 1) });
      }
    }
    return blocks;
  }

  async function buildLevelBlock(cv, block, loadTileRgba, options) {
    const half = 2 ** (block.z - 1);
    const tilesW = block.coreW + 2 * MARGIN_TILES;
    const tilesH = block.coreH + 2 * MARGIN_TILES;
    const width = tilesW * TILE;
    const height = tilesH * TILE;
    const rgba = new Uint8Array(width * height * 4);
    let coreHasContent = false;

    for (let j = 0; j < tilesH; j++) {
      for (let i = 0; i < tilesW; i++) {
        const tx = block.coreTx - MARGIN_TILES + i;
        const ty = block.coreTy - MARGIN_TILES + j;
        const tile = await loadTileRgba(block.z, tx - half, half - ty - 1);
        if (!tile) continue;
        const inCore = i >= MARGIN_TILES && j >= MARGIN_TILES && i < MARGIN_TILES + block.coreW && j < MARGIN_TILES + block.coreH;
        if (inCore) coreHasContent = true;
        for (let row = 0; row < TILE; row++) {
          const src = row * TILE * 4;
          const dst = ((j * TILE + row) * width + i * TILE) * 4;
          rgba.set(tile.subarray(src, src + TILE * 4), dst);
        }
      }
    }
    if (!coreHasContent) return null;

    const mapPerPx = 2 ** (Geo.BASE_ZOOM - block.z);
    return MatcherCore.referenceBlock(cv, rgba, width, height, {
      level: block.z,
      mapPerPx,
      originX: (block.coreTx - MARGIN_TILES) * TILE * mapPerPx,
      originY: (block.coreTy - MARGIN_TILES) * TILE * mapPerPx,
      coreX: MARGIN_TILES * TILE,
      coreY: MARGIN_TILES * TILE,
      coreW: block.coreW * TILE,
      coreH: block.coreH * TILE,
    }, options);
  }

  async function build(cv, tileset, levels, loadTileRgba, options, onProgress) {
    const all = levels.flatMap((z) => blocksForLevel(tileset, z));
    const results = [];
    for (let i = 0; i < all.length; i++) {
      const res = await buildLevelBlock(cv, all[i], loadTileRgba, options);
      if (res && res.count) results.push(res);
      if (onProgress) onProgress(i + 1, all.length);
    }
    return MatcherCore.buildReference(results);
  }

  return { build, blocksForLevel };
});
