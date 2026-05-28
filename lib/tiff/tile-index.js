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

export function locatePixel(tags, row, col) {
  if (tags.has(TAG.TileWidth)) {
    const tw = arrVal(tags, TAG.TileWidth)[0];
    const tl = arrVal(tags, TAG.TileLength)[0];
    const offsets = arrVal(tags, TAG.TileOffsets);
    const counts  = arrVal(tags, TAG.TileByteCounts);
    const W = arrVal(tags, TAG.ImageWidth)[0];
    const tilesAcross = Math.ceil(W / tw);
    const tileX = Math.floor(col / tw);
    const tileY = Math.floor(row / tl);
    const idx   = tileY * tilesAcross + tileX;
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
  const stripIdx = Math.floor(row / rps);
  const offsets  = arrVal(tags, TAG.StripOffsets);
  const counts   = arrVal(tags, TAG.StripByteCounts);
  const W        = arrVal(tags, TAG.ImageWidth)[0];
  return {
    layout: 'strip',
    offset: offsets[stripIdx],
    length: counts[stripIdx],
    blockWidth: W,
    blockHeight: rps,
    rowInBlock: row - stripIdx * rps,
    colInBlock: col,
  };
}
