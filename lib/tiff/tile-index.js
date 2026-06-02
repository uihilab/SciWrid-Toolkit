// lib/tiff/tile-index.js
//
// Given an IFD's tag map and a pixel (row, col), return the byte-range
// of the strip or tile that owns that pixel, plus the pixel's position
// inside the decoded strip/tile.

const TAG = {
  ImageWidth: 256, ImageLength: 257,
  StripOffsets: 273, RowsPerStrip: 278, StripByteCounts: 279,
  TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325,
};

function arrVal(tags, tag) {
  const t = tags.get(tag); if (!t) return null;
  return t.values;
}

/**
 * Locate the byte range that owns pixel (row, col).
 *
 * For PlanarConfiguration=2 (separate planes), strips/tiles are grouped
 * per band: band 0's strips come first, then band 1's, etc. The caller
 * passes `{ bandIndex, samplesPerPixel, planarConfig }` so we can index
 * into the right group.
 */
export function locatePixel(tags, row, col, opts = {}) {
  const planar = opts.planarConfig ?? 1;
  const band   = opts.bandIndex    ?? 0;

  if (tags.has(TAG.TileWidth)) {
    const tw = arrVal(tags, TAG.TileWidth)[0];
    const tl = arrVal(tags, TAG.TileLength)[0];
    const offsets = arrVal(tags, TAG.TileOffsets);
    const counts  = arrVal(tags, TAG.TileByteCounts);
    const W = arrVal(tags, TAG.ImageWidth)[0];
    const H = arrVal(tags, TAG.ImageLength)[0];
    const tilesAcross = Math.ceil(W / tw);
    const tilesDown   = Math.ceil(H / tl);
    const tileX = Math.floor(col / tw);
    const tileY = Math.floor(row / tl);
    const tilesPerPlane = tilesAcross * tilesDown;
    const idx = (planar === 2 ? band * tilesPerPlane : 0) + tileY * tilesAcross + tileX;
    return {
      layout: 'tile',
      offset: offsets[idx],
      length: counts[idx],
      blockWidth: tw,
      blockHeight: tl,
      rowInBlock: row - tileY * tl,
      colInBlock: col - tileX * tw,
    };
  }
  // strip
  const rps = arrVal(tags, TAG.RowsPerStrip)?.[0];
  if (rps == null) throw new Error('tile-index: strip layout but no RowsPerStrip');
  const H = arrVal(tags, TAG.ImageLength)[0];
  const stripsPerPlane = Math.ceil(H / rps);
  const stripIdx = (planar === 2 ? band * stripsPerPlane : 0) + Math.floor(row / rps);
  const offsets  = arrVal(tags, TAG.StripOffsets);
  const counts   = arrVal(tags, TAG.StripByteCounts);
  const W        = arrVal(tags, TAG.ImageWidth)[0];
  return {
    layout: 'strip',
    offset: offsets[stripIdx],
    length: counts[stripIdx],
    blockWidth: W,
    blockHeight: rps,
    rowInBlock: row - Math.floor(row / rps) * rps,
    colInBlock: col,
  };
}
