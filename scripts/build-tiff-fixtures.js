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
function buildTiff(tags, stripBytes) {
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
  out[0] = 0x49; out[1] = 0x49;                  // "II"
  dv.setUint16(2, 42,  true);                    // magic 42
  dv.setUint32(4,  8,  true);                    // first IFD at offset 8

  // IFD
  dv.setUint16(8, tags.length, true);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const p = 10 + i * 12;
    dv.setUint16(p,     t.tag,  true);
    dv.setUint16(p + 2, t.type, true);
    dv.setUint32(p + 4, t.values.length, true);

    const sz = TYPE_SIZE[t.type] * t.values.length;
    if (sz <= 4) {
      // Inline value (left-aligned in the 4-byte slot)
      writeValuesAt(dv, p + 8, t.type, t.values);
    } else {
      dv.setUint32(p + 8, t._offset, true);
    }
  }
  // Next-IFD offset (0 = none)
  dv.setUint32(10 + tags.length * 12, 0, true);

  // External values
  for (const { tag, offset } of externals) {
    writeValuesAt(dv, offset, tag.type, tag.values);
  }

  // Strip data
  if (stripOffsetsTag) {
    for (let i = 0; i < stripBytes.length; i++) {
      out.set(stripBytes[i], stripOffsetsTag.values[i]);
    }
  }
  return out;
}

function writeValuesAt(dv, offset, type, values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    switch (type) {
      case T_BYTE:  case T_UNDEFINED:  dv.setUint8(offset + i, v); break;
      case T_SBYTE:                    dv.setInt8(offset + i, v); break;
      case T_ASCII: dv.setUint8(offset + i, typeof v === 'string' ? v.charCodeAt(0) : v); break;
      case T_SHORT: dv.setUint16(offset + i * 2, v, true); break;
      case T_SSHORT:dv.setInt16(offset + i * 2, v, true); break;
      case T_LONG:  dv.setUint32(offset + i * 4, v, true); break;
      case T_SLONG: dv.setInt32(offset + i * 4, v, true); break;
      case T_FLOAT: dv.setFloat32(offset + i * 4, v, true); break;
      case T_DOUBLE:dv.setFloat64(offset + i * 8, v, true); break;
      case T_RATIONAL:
      case T_SRATIONAL:
        // values come as pairs [num, den, num, den, ...]
        dv.setUint32(offset + i * 8, v[0] >>> 0, true);
        dv.setUint32(offset + i * 8 + 4, v[1] >>> 0, true);
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

// ── main: write every fixture ─────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const fixtures = {
  'synthetic-u8-none-strip-wgs84.tif': fixtureU8NoneStripWgs84(),
  'synthetic-f32-deflate-fp-strip-wgs84.tif': fixtureF32DeflateFpStripWgs84(),
};
for (const [name, { bytes }] of Object.entries(fixtures)) {
  const out = resolve(outDir, name);
  writeFileSync(out, bytes);
  console.log(`wrote ${out}  (${bytes.length} bytes)`);
}
