#!/usr/bin/env node
// scripts/build-tiff-fixtures.js
//
// Dev-only: hand-assemble minimal valid GeoTIFFs for the test suite.
// Output → examples/testfile/tiff/*.tif (committed binaries).
//
// Run: node scripts/build-tiff-fixtures.js
//
// One fixture per function. Each function returns a Uint8Array; main()
// writes them to disk. We start with the simplest fixture and grow.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'examples', 'testfile', 'tiff');

// ── Tag-type constants (from TIFF 6.0 spec §2) ───────────────────────────
const T_BYTE      = 1;
const T_ASCII     = 2;
const T_SHORT     = 3;
const T_LONG      = 4;
const T_RATIONAL  = 5;
const T_SBYTE     = 6;
const T_UNDEFINED = 7;
const T_SSHORT    = 8;
const T_SLONG     = 9;
const T_SRATIONAL = 10;
const T_FLOAT     = 11;
const T_DOUBLE    = 12;

const TYPE_SIZE = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };

/**
 * Assemble a classic little-endian TIFF.
 *  - tags:  Array<{ tag, type, values: number[] | string }>
 *  - stripBytes: Array<Uint8Array>  (image data, one entry per strip)
 *
 * Returns Uint8Array of the full file. Tags are auto-sorted by tag number
 * (required by spec). Values > 4 bytes are written after the IFD.
 */
function buildTiff(tags, stripBytes, { le = true } = {}) {
  tags = [...tags].sort((a, b) => a.tag - b.tag);

  // Layout:  [ header 8B | IFD (2 + 12*N + 4) B | external values | strip data ]
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = 8 + ifdSize;

  // Pre-pass: expand StripOffsets / StripByteCounts to the actual strip count
  // so the externals allocation below sizes them correctly. Values are filled
  // with placeholders here and patched with real offsets after externals.
  const stripOffsetsTag = tags.find(t => t.tag === 273);   // StripOffsets
  const stripByteCountsTag = tags.find(t => t.tag === 279); // StripByteCounts
  if (stripOffsetsTag && stripBytes.length) {
    stripOffsetsTag.values    = new Array(stripBytes.length).fill(0);
    stripByteCountsTag.values = new Array(stripBytes.length).fill(0);
  }

  // Allocate space for external values
  const externals = [];
  for (const t of tags) {
    const sz = TYPE_SIZE[t.type] * t.values.length;
    if (sz > 4) {
      t._offset = cursor;
      externals.push({ tag: t, offset: cursor, size: sz });
      cursor += sz;
    } else {
      t._offset = null;
    }
  }

  // Now patch StripOffsets / StripByteCounts with the real offsets into the
  // strip-data region (which sits after all external values).
  if (stripOffsetsTag && stripBytes.length) {
    for (let i = 0; i < stripBytes.length; i++) {
      stripOffsetsTag.values[i]    = cursor;
      stripByteCountsTag.values[i] = stripBytes[i].length;
      cursor += stripBytes[i].length;
    }
  }

  const total = cursor;
  const out = new Uint8Array(total);
  const dv  = new DataView(out.buffer);

  // Header
  if (le) { out[0] = 0x49; out[1] = 0x49; }      // "II"
  else    { out[0] = 0x4D; out[1] = 0x4D; }      // "MM"
  dv.setUint16(2, 42,  le);                      // magic 42
  dv.setUint32(4,  8,  le);                      // first IFD at offset 8

  // IFD
  dv.setUint16(8, tags.length, le);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const p = 10 + i * 12;
    dv.setUint16(p,     t.tag,  le);
    dv.setUint16(p + 2, t.type, le);
    dv.setUint32(p + 4, t.values.length, le);

    const sz = TYPE_SIZE[t.type] * t.values.length;
    if (sz <= 4) {
      // Inline value (left-aligned in the 4-byte slot)
      writeValuesAt(dv, p + 8, t.type, t.values, le);
    } else {
      dv.setUint32(p + 8, t._offset, le);
    }
  }
  // Next-IFD offset (0 = none)
  dv.setUint32(10 + tags.length * 12, 0, le);

  // External values
  for (const { tag, offset } of externals) {
    writeValuesAt(dv, offset, tag.type, tag.values, le);
  }

  // Strip data
  if (stripOffsetsTag) {
    for (let i = 0; i < stripBytes.length; i++) {
      out.set(stripBytes[i], stripOffsetsTag.values[i]);
    }
  }
  return out;
}

function writeValuesAt(dv, offset, type, values, le = true) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    switch (type) {
      case T_BYTE:  case T_UNDEFINED:  dv.setUint8(offset + i, v); break;
      case T_SBYTE:                    dv.setInt8(offset + i, v); break;
      case T_ASCII: dv.setUint8(offset + i, typeof v === 'string' ? v.charCodeAt(0) : v); break;
      case T_SHORT: dv.setUint16(offset + i * 2, v, le); break;
      case T_SSHORT:dv.setInt16(offset + i * 2, v, le); break;
      case T_LONG:  dv.setUint32(offset + i * 4, v, le); break;
      case T_SLONG: dv.setInt32(offset + i * 4, v, le); break;
      case T_FLOAT: dv.setFloat32(offset + i * 4, v, le); break;
      case T_DOUBLE:dv.setFloat64(offset + i * 8, v, le); break;
      case T_RATIONAL:
      case T_SRATIONAL:
        // values come as pairs [num, den, num, den, ...]
        dv.setUint32(offset + i * 8, v[0] >>> 0, le);
        dv.setUint32(offset + i * 8 + 4, v[1] >>> 0, le);
        break;
    }
  }
}

// ── GeoKey directory builder (used by every geo fixture) ─────────────────
// modelTransform: { tiepoint: [x,y,z,X,Y,Z], scale: [sx,sy,sz] }
// geoKeys:        array of { keyId, tiffTag, count, valueOrOffset }
function geoKeyDirectoryTag(geoKeys) {
  const header = [1, 1, 0, geoKeys.length];           // (kvRevision, minor, count of keys)
  const flat = [...header];
  for (const k of geoKeys) flat.push(k.keyId, k.tiffTag, k.count, k.valueOrOffset);
  return { tag: 34735, type: T_SHORT, values: flat };
}

// ── Fixture 1: synthetic-u8-none-strip-wgs84.tif ─────────────────────────
function fixtureU8NoneStripWgs84() {
  // 8 cols × 4 rows, single band UInt8, no compression, one strip per row.
  // CRS: EPSG:4326, bbox [10, 20, 18, 24], pixel size 1×1 degrees.
  const W = 8, H = 4;
  const pixels = new Uint8Array(W * H);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + 3) & 0xff;
  const strips = [];
  for (let r = 0; r < H; r++) strips.push(pixels.subarray(r * W, (r + 1) * W));

  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },                // ImageWidth
    { tag: 257, type: T_SHORT, values: [H] },                // ImageLength
    { tag: 258, type: T_SHORT, values: [8] },                // BitsPerSample
    { tag: 259, type: T_SHORT, values: [1] },                // Compression = none
    { tag: 262, type: T_SHORT, values: [1] },                // PhotometricInterpretation = BlackIsZero
    { tag: 273, type: T_LONG,  values: [0] },                // StripOffsets   (patched)
    { tag: 277, type: T_SHORT, values: [1] },                // SamplesPerPixel
    { tag: 278, type: T_SHORT, values: [1] },                // RowsPerStrip
    { tag: 279, type: T_LONG,  values: [0] },                // StripByteCounts (patched)
    { tag: 284, type: T_SHORT, values: [1] },                // PlanarConfiguration = chunky
    { tag: 339, type: T_SHORT, values: [1] },                // SampleFormat = unsigned int
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },       // ModelPixelScale: 1°×1°
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },  // ModelTiepoint: pix(0,0) → (10°E, 24°N)
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0,     count: 1, valueOrOffset: 2 },     // GTModelTypeGeoKey = ModelTypeGeographic
      { keyId: 1025, tiffTag: 0,     count: 1, valueOrOffset: 1 },     // GTRasterTypeGeoKey = RasterPixelIsArea
      { keyId: 2048, tiffTag: 0,     count: 1, valueOrOffset: 4326 },  // GeographicTypeGeoKey = WGS 84
    ]),
  ];
  return { bytes: buildTiff(tags, strips), expected: { W, H, pixels } };
}

// ── Floating-point predictor (encoder side) ─────────────────────────────
function applyFloatingPointPredictor(bytes, { width, height, samplesPerPixel, bps }) {
  const rowBytes = width * samplesPerPixel * bps;
  const tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < height; r++) {
    const rowOff = r * rowBytes;
    // 1) Shuffle: byte (j*bps + i) -> position (i * samplesInRow + j)
    const samplesInRow = width * samplesPerPixel;
    for (let b = 0; b < bps; b++) {
      for (let s = 0; s < samplesInRow; s++) {
        tmp[b * samplesInRow + s] = bytes[rowOff + s * bps + b];
      }
    }
    // 2) Horizontal diff per byte
    for (let i = rowBytes - 1; i >= 1; i--) tmp[i] = (tmp[i] - tmp[i - 1]) & 0xff;
    bytes.set(tmp, rowOff);
  }
  return bytes;
}

// ── Fixture 2: synthetic-f32-deflate-fp-strip-wgs84.tif ──────────────────
function fixtureF32DeflateFpStripWgs84() {
  const W = 8, H = 4;
  const f32 = new Float32Array(W * H);
  for (let i = 0; i < f32.length; i++) f32[i] = (i % 7) * 0.5 + 1.25;
  // Build row strips: each row is one strip → one independent deflate
  const strips = [];
  for (let r = 0; r < H; r++) {
    const rowBytes = new Uint8Array(f32.buffer.slice(r * W * 4, (r + 1) * W * 4));
    applyFloatingPointPredictor(rowBytes, { width: W, height: 1, samplesPerPixel: 1, bps: 4 });
    strips.push(new Uint8Array(deflateRawSync(rowBytes)));
  }
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [32] },               // BitsPerSample
    { tag: 259, type: T_SHORT, values: [8] },                // Compression = Deflate
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 273, type: T_LONG,  values: [0] },                // StripOffsets (patched)
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 278, type: T_SHORT, values: [1] },                // RowsPerStrip = 1
    { tag: 279, type: T_LONG,  values: [0] },                // StripByteCounts (patched)
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 317, type: T_SHORT, values: [3] },                // Predictor = 3 (floating-point)
    { tag: 339, type: T_SHORT, values: [3] },                // SampleFormat = float
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
  ];
  return { bytes: buildTiff(tags, strips), expected: { W, H, f32 } };
}

// ── buildTiffWithTiles: like buildTiff but patches tile-offset tags ─────
//
// Trick: temporarily rename 324/325 → 273/279 so buildTiff treats them as
// strip-offset tags (and writes block bytes after the IFD). After the file
// is built, scan the IFD bytes and rename them back.
function buildTiffWithTiles(tags, tileBlocks) {
  tags = [...tags];
  const off = tags.find(t => t.tag === 324);
  const cnt = tags.find(t => t.tag === 325);
  off.tag = 273; cnt.tag = 279;
  const bytes = buildTiff(tags, tileBlocks);
  off.tag = 324; cnt.tag = 325;
  const dv = new DataView(bytes.buffer);
  const numTags = dv.getUint16(8, true);
  for (let i = 0; i < numTags; i++) {
    const p = 10 + i * 12;
    const id = dv.getUint16(p, true);
    if (id === 273) dv.setUint16(p, 324, true);
    if (id === 279) dv.setUint16(p, 325, true);
  }
  return bytes;
}

// ── Fixture 3: synthetic-f32-deflate-fp-tile-utm15n.tif ──────────────────
function fixtureF32DeflateFpTileUtm15N() {
  // 8×8 grid in UTM 15N, 4×4 tiles. Tiepoint at UTM (500000, 3320000), 1000m pixel.
  const W = 8, H = 8, TW = 4, TL = 4;
  const f32 = new Float32Array(W * H);
  for (let i = 0; i < f32.length; i++) f32[i] = i * 0.25 + 7;
  const tilesAcross = Math.ceil(W / TW), tilesDown = Math.ceil(H / TL);
  const tiles = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tileBytes = new Uint8Array(TW * TL * 4);
      const dv = new DataView(tileBytes.buffer);
      for (let r = 0; r < TL; r++) {
        for (let c = 0; c < TW; c++) {
          const gr = ty * TL + r, gc = tx * TW + c;
          dv.setFloat32((r * TW + c) * 4, f32[gr * W + gc], true);
        }
      }
      applyFloatingPointPredictor(tileBytes, { width: TW, height: TL, samplesPerPixel: 1, bps: 4 });
      tiles.push(new Uint8Array(deflateRawSync(tileBytes)));
    }
  }
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [32] },
    { tag: 259, type: T_SHORT, values: [8] },
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 317, type: T_SHORT, values: [3] },
    { tag: 322, type: T_SHORT, values: [TW] },
    { tag: 323, type: T_SHORT, values: [TL] },
    { tag: 324, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 325, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 339, type: T_SHORT, values: [3] },
    { tag: 33550, type: T_DOUBLE, values: [1000, 1000, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 500000, 3320000, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 1 },        // projected
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 3072, tiffTag: 0, count: 1, valueOrOffset: 32615 },    // UTM 15N
    ]),
  ];
  return { bytes: buildTiffWithTiles(tags, tiles), expected: { W, H, f32 } };
}

// ── Fixture 4: synthetic-f32-deflate-fp-tile-sinusoidal.tif ──────────────
function fixtureF32DeflateFpTileSinusoidal() {
  // 8×8 grid in MODIS sinusoidal (R=6371007.181). Tiepoint native (0,0), 1000m pixel.
  const W = 8, H = 8, TW = 4, TL = 4;
  const f32 = new Float32Array(W * H);
  for (let i = 0; i < f32.length; i++) f32[i] = i * 0.25 + 7;
  const tilesAcross = Math.ceil(W / TW), tilesDown = Math.ceil(H / TL);
  const tiles = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tileBytes = new Uint8Array(TW * TL * 4);
      const dv = new DataView(tileBytes.buffer);
      for (let r = 0; r < TL; r++) {
        for (let c = 0; c < TW; c++) {
          const gr = ty * TL + r, gc = tx * TW + c;
          dv.setFloat32((r * TW + c) * 4, f32[gr * W + gc], true);
        }
      }
      applyFloatingPointPredictor(tileBytes, { width: TW, height: TL, samplesPerPixel: 1, bps: 4 });
      tiles.push(new Uint8Array(deflateRawSync(tileBytes)));
    }
  }
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [32] },
    { tag: 259, type: T_SHORT, values: [8] },
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 317, type: T_SHORT, values: [3] },
    { tag: 322, type: T_SHORT, values: [TW] },
    { tag: 323, type: T_SHORT, values: [TL] },
    { tag: 324, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 325, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 339, type: T_SHORT, values: [3] },
    { tag: 33550, type: T_DOUBLE, values: [1000, 1000, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 0, 0, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 1 },        // projected
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 3072, tiffTag: 0, count: 1, valueOrOffset: 32767 },    // user-defined PCS
      { keyId: 3075, tiffTag: 0, count: 1, valueOrOffset: 24 },       // Sinusoidal
      { keyId: 3082, tiffTag: 0, count: 1, valueOrOffset: 0 },        // FalseEasting (integer slot)
      { keyId: 3083, tiffTag: 0, count: 1, valueOrOffset: 0 },        // FalseNorthing
      { keyId: 3088, tiffTag: 0, count: 1, valueOrOffset: 0 },        // CenterLong (integer slot)
    ]),
  ];
  return { bytes: buildTiffWithTiles(tags, tiles), expected: { W, H, f32 } };
}

// ── Fixture 5: synthetic-i16-none-strip-wgs84.tif ────────────────────────
function fixtureI16NoneStripWgs84() {
  const W = 8, H = 4;
  const buf = new Uint8Array(W * H * 2);
  const dv  = new DataView(buf.buffer);
  // Use values spanning negatives so the int16 path is genuinely exercised.
  for (let i = 0; i < W * H; i++) dv.setInt16(i * 2, (i - 16) * 13, true);
  const strips = [];
  for (let r = 0; r < H; r++) strips.push(buf.subarray(r * W * 2, (r + 1) * W * 2));
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [16] },               // BitsPerSample
    { tag: 259, type: T_SHORT, values: [1] },                // Compression = none
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 273, type: T_LONG,  values: [0] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 278, type: T_SHORT, values: [1] },
    { tag: 279, type: T_LONG,  values: [0] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 339, type: T_SHORT, values: [2] },                // SampleFormat = signed int
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
  ];
  return { bytes: buildTiff(tags, strips), expected: { W, H } };
}

// ── Fixture 6: synthetic-u8-none-tile-wgs84.tif ──────────────────────────
function fixtureU8NoneTileWgs84() {
  const W = 8, H = 8, TW = 4, TL = 4;
  const pixels = new Uint8Array(W * H);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 5 + 11) & 0xff;
  const tilesAcross = Math.ceil(W / TW), tilesDown = Math.ceil(H / TL);
  const tiles = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tile = new Uint8Array(TW * TL);
      for (let r = 0; r < TL; r++) for (let c = 0; c < TW; c++) {
        tile[r * TW + c] = pixels[(ty * TL + r) * W + (tx * TW + c)];
      }
      tiles.push(tile);
    }
  }
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [8] },
    { tag: 259, type: T_SHORT, values: [1] },
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 322, type: T_SHORT, values: [TW] },
    { tag: 323, type: T_SHORT, values: [TL] },
    { tag: 324, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 325, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 339, type: T_SHORT, values: [1] },
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
  ];
  return { bytes: buildTiffWithTiles(tags, tiles), expected: { W, H, pixels } };
}

// ── Fixture 7: COG-style tile fixture large enough to exercise Range fetching ─
// Single-IFD tile layout, Float32 uncompressed so the file is bulky and
// scan/extract reading << full file is meaningful.
function fixtureCogF32NoneTileWgs84() {
  const W = 64, H = 64, TW = 16, TL = 16;
  const f32 = new Float32Array(W * H);
  for (let i = 0; i < f32.length; i++) f32[i] = i * 0.5;
  const tilesAcross = Math.ceil(W / TW), tilesDown = Math.ceil(H / TL);
  const tiles = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tileBytes = new Uint8Array(TW * TL * 4);
      const dv = new DataView(tileBytes.buffer);
      for (let r = 0; r < TL; r++) {
        for (let c = 0; c < TW; c++) {
          const gr = ty * TL + r, gc = tx * TW + c;
          dv.setFloat32((r * TW + c) * 4, f32[gr * W + gc], true);
        }
      }
      tiles.push(tileBytes);
    }
  }
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [32] },
    { tag: 259, type: T_SHORT, values: [1] },     // Compression = none
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 322, type: T_SHORT, values: [TW] },
    { tag: 323, type: T_SHORT, values: [TL] },
    { tag: 324, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 325, type: T_LONG,  values: tiles.map(() => 0) },
    { tag: 339, type: T_SHORT, values: [3] },     // SampleFormat = float
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 0, 64, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
  ];
  return { bytes: buildTiffWithTiles(tags, tiles), expected: { W, H, f32 } };
}

// ── TIFF-LZW encoder (matches libtiff "early change") for fixture builder ─
function tiffLzwEncode(bytes) {
  const CLEAR = 256, EOI = 257;
  const table = new Map();
  let nextCode;
  let codeWidth = 9;
  function reset() {
    table.clear();
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
    nextCode = 258;
    codeWidth = 9;
  }
  const bits = [];
  function emit(code) {
    for (let i = codeWidth - 1; i >= 0; i--) bits.push((code >>> i) & 1);
  }
  reset();
  emit(CLEAR);
  let w = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = String.fromCharCode(bytes[i]);
    const wc = w + c;
    if (table.has(wc)) {
      w = wc;
    } else {
      emit(table.get(w));
      table.set(wc, nextCode++);
      if (nextCode === (1 << codeWidth) && codeWidth < 12) codeWidth++;
      w = c;
    }
  }
  if (w !== '') emit(table.get(w));
  emit(EOI);
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

// Horizontal predictor (encoder) — per-row, per-sample diff
function applyHorizontalPredictorU16(bytes, { width, height, samplesPerPixel }) {
  const rowBytes = width * samplesPerPixel * 2;
  for (let r = 0; r < height; r++) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + r * rowBytes, rowBytes);
    for (let i = width * samplesPerPixel - 1; i >= samplesPerPixel; i--) {
      const v  = dv.getUint16(i * 2, true);
      const pv = dv.getUint16((i - samplesPerPixel) * 2, true);
      dv.setUint16(i * 2, (v - pv) & 0xffff, true);
    }
  }
  return bytes;
}

// ── Fixture 8: synthetic-multiband-u16-lzw-h-strip-wgs84.tif ─────────────
function fixtureMultibandU16LzwHorizStripWgs84() {
  // 3 bands (R/G/B), UInt16, LZW + horizontal predictor, strip layout.
  const W = 8, H = 4, SPP = 3;
  const pixels = new Uint16Array(W * H * SPP);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      pixels[(r * W + c) * SPP + 0] = (r * 100 + c * 10) & 0xffff; // band 0
      pixels[(r * W + c) * SPP + 1] = (r * 200 + c * 20 + 5) & 0xffff;
      pixels[(r * W + c) * SPP + 2] = (r * 300 + c * 30 + 11) & 0xffff;
    }
  }
  const allBytes = new Uint8Array(pixels.buffer.slice());
  applyHorizontalPredictorU16(allBytes, { width: W, height: H, samplesPerPixel: SPP });
  // One strip per row, LZW-encoded
  const rowBytes = W * SPP * 2;
  const strips = [];
  for (let r = 0; r < H; r++) {
    const rowSlice = allBytes.subarray(r * rowBytes, (r + 1) * rowBytes);
    strips.push(tiffLzwEncode(rowSlice));
  }
  // GDAL_METADATA XML — band descriptions stored as ASCII (null-terminated)
  const xml =
    '<GDALMetadata>\n' +
    '  <Item name="DESCRIPTION" sample="0">B04_red</Item>\n' +
    '  <Item name="DESCRIPTION" sample="1">B03_green</Item>\n' +
    '  <Item name="DESCRIPTION" sample="2">B02_blue</Item>\n' +
    '</GDALMetadata>\0';
  const xmlBytes = Array.from(xml, ch => ch.charCodeAt(0));

  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [16, 16, 16] },        // BitsPerSample × 3
    { tag: 259, type: T_SHORT, values: [5] },                 // Compression = LZW
    { tag: 262, type: T_SHORT, values: [1] },                 // BlackIsZero
    { tag: 273, type: T_LONG,  values: [0] },                 // StripOffsets (patched)
    { tag: 277, type: T_SHORT, values: [SPP] },               // SamplesPerPixel = 3
    { tag: 278, type: T_SHORT, values: [1] },                 // RowsPerStrip = 1
    { tag: 279, type: T_LONG,  values: [0] },                 // StripByteCounts (patched)
    { tag: 284, type: T_SHORT, values: [1] },                 // PlanarConfiguration = chunky
    { tag: 317, type: T_SHORT, values: [2] },                 // Predictor = horizontal
    { tag: 339, type: T_SHORT, values: [1, 1, 1] },           // SampleFormat (uint) × 3
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
    { tag: 42112, type: T_ASCII, values: xmlBytes },          // GDAL_METADATA
  ];
  return { bytes: buildTiff(tags, strips), expected: { W, H, SPP, pixels } };
}

// ── Fixture 9: synthetic-unsupported-crs.tif ─────────────────────────────
// Tiny 2×2 Float32 strip with ProjectedCSTypeGeoKey=3413 (NSIDC polar
// stereographic) so the v1 reader throws UnsupportedCRSError.
function fixtureUnsupportedCrs() {
  const W = 2, H = 2;
  const buf = new Uint8Array(W * H * 4);
  const dv  = new DataView(buf.buffer);
  for (let i = 0; i < W * H; i++) dv.setFloat32(i * 4, i + 0.5, true);
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [32] },
    { tag: 259, type: T_SHORT, values: [1] },
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 273, type: T_LONG,  values: [0] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 278, type: T_SHORT, values: [H] },
    { tag: 279, type: T_LONG,  values: [0] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 339, type: T_SHORT, values: [3] },
    { tag: 33550, type: T_DOUBLE, values: [1000, 1000, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 0, 0, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 1 },        // projected
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 3072, tiffTag: 0, count: 1, valueOrOffset: 3413 },     // NSIDC polar stereographic
    ]),
  ];
  return { bytes: buildTiff(tags, [buf]) };
}

// ── Fixture (v2): big-endian classic TIFF — same content as the LE u8 fixture
function fixtureU8NoneStripWgs84BE() {
  const lhs = fixtureU8NoneStripWgs84();
  // Re-encode the same tags + strips in big-endian.
  // We need to re-derive `tags`/`strips` here because fixtureU8NoneStripWgs84
  // doesn't return them. Duplicate the tag block (kept small intentionally).
  const W = 8, H = 4;
  const pixels = new Uint8Array(W * H);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + 3) & 0xff;
  const strips = [];
  for (let r = 0; r < H; r++) strips.push(pixels.subarray(r * W, (r + 1) * W));
  const tags = [
    { tag: 256, type: T_SHORT, values: [W] },
    { tag: 257, type: T_SHORT, values: [H] },
    { tag: 258, type: T_SHORT, values: [8] },
    { tag: 259, type: T_SHORT, values: [1] },
    { tag: 262, type: T_SHORT, values: [1] },
    { tag: 273, type: T_LONG,  values: [0] },
    { tag: 277, type: T_SHORT, values: [1] },
    { tag: 278, type: T_SHORT, values: [1] },
    { tag: 279, type: T_LONG,  values: [0] },
    { tag: 284, type: T_SHORT, values: [1] },
    { tag: 339, type: T_SHORT, values: [1] },
    { tag: 33550, type: T_DOUBLE, values: [1, 1, 0] },
    { tag: 33922, type: T_DOUBLE, values: [0, 0, 0, 10, 24, 0] },
    geoKeyDirectoryTag([
      { keyId: 1024, tiffTag: 0, count: 1, valueOrOffset: 2 },
      { keyId: 1025, tiffTag: 0, count: 1, valueOrOffset: 1 },
      { keyId: 2048, tiffTag: 0, count: 1, valueOrOffset: 4326 },
    ]),
  ];
  return { bytes: buildTiff(tags, strips, { le: false }), expected: { W, H, pixels } };
}

// ── main: write every fixture ─────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const fixtures = {
  'synthetic-u8-none-strip-wgs84.tif': fixtureU8NoneStripWgs84(),
  'synthetic-u8-none-strip-be-wgs84.tif': fixtureU8NoneStripWgs84BE(),
  'synthetic-f32-deflate-fp-strip-wgs84.tif': fixtureF32DeflateFpStripWgs84(),
  'synthetic-f32-deflate-fp-tile-utm15n.tif': fixtureF32DeflateFpTileUtm15N(),
  'synthetic-f32-deflate-fp-tile-sinusoidal.tif': fixtureF32DeflateFpTileSinusoidal(),
  'synthetic-i16-none-strip-wgs84.tif': fixtureI16NoneStripWgs84(),
  'synthetic-u8-none-tile-wgs84.tif':  fixtureU8NoneTileWgs84(),
  'synthetic-f32-none-tile-cog-wgs84.tif': fixtureCogF32NoneTileWgs84(),
  'synthetic-multiband-u16-lzw-h-strip-wgs84.tif': fixtureMultibandU16LzwHorizStripWgs84(),
  'synthetic-unsupported-crs.tif': fixtureUnsupportedCrs(),
};
for (const [name, { bytes }] of Object.entries(fixtures)) {
  const out = resolve(outDir, name);
  writeFileSync(out, bytes);
  console.log(`wrote ${out}  (${bytes.length} bytes)`);
}
