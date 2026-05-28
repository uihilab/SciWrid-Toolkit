/*
 * lib/slim/slimTiff.js
 *
 * slim() implementation for TIFF / GeoTIFF — v2 scope: band selection.
 *
 *   slim(tiff, { variables: ['B04_red'] })
 *     → re-emit the TIFF with only the requested bands.
 *
 * Supports v2 reader capabilities (single-IFD chunky `PlanarConfiguration=1`,
 * strip OR tile layout, no compression / Deflate / LZW / PackBits, predictor
 * 1 or 2 — predictor 3 is float-32-only and not used by multi-band fixtures).
 *
 * Returns { bytes, format, warnings, stats } per the slim() contract.
 */

import { parseIFDs }       from '../tiff/ifd-reader.js';
import { unpredict }       from '../tiff/predictors.js';
import { applyPredictor }  from '../tiff/encoders/predictor.js';
import { decode as decNone }     from '../tiff/decoders/none.js';
import { decode as decDeflate }  from '../tiff/decoders/deflate.js';
import { decode as decLzw }      from '../tiff/decoders/lzw.js';
import { decode as decPackbits } from '../tiff/decoders/packbits.js';
import { encode as encNone }     from '../tiff/encoders/none.js';
import { encode as encDeflate }  from '../tiff/encoders/deflate.js';
import { encode as encLzw }      from '../tiff/encoders/lzw.js';
import { encode as encPackbits } from '../tiff/encoders/packbits.js';
import { UnsupportedFormatError, VariableNotFoundError } from '../errors.js';
import { SlimError } from './errors.js';

const TAG = {
  NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258,
  Compression: 259, PhotometricInterpretation: 262, StripOffsets: 273,
  SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfiguration: 284, Predictor: 317,
  TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325,
  SampleFormat: 339, GdalMetadata: 42112,
  ModelPixelScale: 33550, ModelTiepoint: 33922,
  GeoKeyDirectory: 34735, GeoDoubleParams: 34736, GeoAsciiParams: 34737,
};

// Tag value type sizes (matches lib/tiff/ifd-reader.js TYPE_SIZE).
const TYPE_SIZE = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };
const COMPRESSION = { 1: 'none', 5: 'lzw', 8: 'deflate', 32773: 'packbits' };

function tagVal(tags, tag, def) {
  const t = tags.get(tag);
  if (!t) return def;
  return t.values.length === 1 ? t.values[0] : t.values;
}
function dtypeOf(bps, sf) {
  if (sf === 3 && bps === 32) return 'float32';
  if (sf === 1 && bps === 8)  return 'uint8';
  if (sf === 1 && bps === 16) return 'uint16';
  if (sf === 2 && bps === 16) return 'int16';
  throw new UnsupportedFormatError(`slim/tiff: unsupported sample (sampleFormat=${sf}, bps=${bps})`);
}
function bytesPerSample(dtype) {
  switch (dtype) {
    case 'uint8': case 'int8':   return 1;
    case 'uint16': case 'int16': return 2;
    case 'float32':              return 4;
    default: throw new Error(`bytesPerSample: unsupported ${dtype}`);
  }
}

function bandNamesFromGdalMetadata(tags, samplesPerPixel) {
  const t = tags.get(TAG.GdalMetadata);
  const names = Array.from({ length: samplesPerPixel }, (_, i) => `band_${i + 1}`);
  if (!t) return names;
  const xml = String.fromCharCode(...t.values).replace(/\0+$/, '');
  const re = /<Item\s+name="DESCRIPTION"\s+sample="(\d+)"\s*>([^<]+)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const i = Number(m[1]);
    if (i >= 0 && i < samplesPerPixel) names[i] = m[2].trim();
  }
  return names;
}

async function decodeBlock(rawBytes, compression) {
  if (compression === 'none')     return decNone(rawBytes);
  if (compression === 'deflate')  return decDeflate(rawBytes);
  if (compression === 'lzw')      return decLzw(rawBytes);
  if (compression === 'packbits') return decPackbits(rawBytes);
  throw new UnsupportedFormatError(`slim/tiff: compression ${compression} not supported`);
}
async function encodeBlock(rawBytes, compression) {
  if (compression === 'none')     return encNone(rawBytes);
  if (compression === 'deflate')  return encDeflate(rawBytes);
  if (compression === 'lzw')      return encLzw(rawBytes);
  if (compression === 'packbits') return encPackbits(rawBytes);
  throw new UnsupportedFormatError(`slim/tiff: cannot re-encode compression ${compression}`);
}

/**
 * Drop unwanted bands from a chunky (planar=1) block of pixels.
 * Input: decoded bytes, shape [blockH][blockW][SPP][bps] (interleaved).
 * Output: shape [blockH][blockW][KEPT][bps] in the same byte order.
 */
function dropBandsChunky(bytes, { blockW, blockH, spp, bps, keep }) {
  const stride    = spp * bps;
  const newStride = keep.length * bps;
  const out = new Uint8Array(blockW * blockH * newStride);
  let dstOff = 0;
  for (let p = 0; p < blockW * blockH; p++) {
    const srcOff = p * stride;
    for (const bandIdx of keep) {
      for (let k = 0; k < bps; k++) out[dstOff + k] = bytes[srcOff + bandIdx * bps + k];
      dstOff += bps;
    }
  }
  return out;
}

/** Emit a fresh GDAL_METADATA XML with only the kept band descriptions. */
function gdalMetadataForKept(originalNames, keepIdx) {
  const lines = ['<GDALMetadata>'];
  for (let i = 0; i < keepIdx.length; i++) {
    const name = originalNames[keepIdx[i]];
    lines.push(`  <Item name="DESCRIPTION" sample="${i}">${name}</Item>`);
  }
  lines.push('</GDALMetadata>');
  return lines.join('\n') + '\0';
}

/**
 * Re-emit a classic LE TIFF from a parsed IFD + freshly-encoded strips.
 *
 * Layout: [ header 8B | IFD | external values | strip/tile data ].
 * Sorts tags by tag-number (spec requirement). Caller passes pre-encoded
 * block bytes; this function patches StripOffsets/TileOffsets to point at
 * the right slots.
 */
function rewriteTiff(rewritten) {
  const { tags: tagsIn, blocks, isTile } = rewritten;
  const tags = [...tagsIn].sort((a, b) => a.tag - b.tag);

  // Identify offset/count tags (strip OR tile). They get patched after we
  // know where blocks land.
  const offsetTagId = isTile ? TAG.TileOffsets    : TAG.StripOffsets;
  const countTagId  = isTile ? TAG.TileByteCounts : TAG.StripByteCounts;
  const offsetTag = tags.find(t => t.tag === offsetTagId);
  const countTag  = tags.find(t => t.tag === countTagId);
  if (offsetTag) {
    offsetTag.values = new Array(blocks.length).fill(0);
    countTag.values  = new Array(blocks.length).fill(0);
  }

  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = 8 + ifdSize;

  // Reserve external storage for tags whose value bytes exceed the 4-byte slot.
  const externals = [];
  for (const t of tags) {
    const sz = (TYPE_SIZE[t.type] || 0) * t.values.length;
    if (sz > 4) {
      t._offset = cursor;
      externals.push({ tag: t, offset: cursor, size: sz });
      cursor += sz;
    } else {
      t._offset = null;
    }
  }

  // Reserve block data — patch offset/count tags to point at the right spots.
  if (offsetTag) {
    for (let i = 0; i < blocks.length; i++) {
      offsetTag.values[i] = cursor;
      countTag.values[i]  = blocks[i].length;
      cursor += blocks[i].length;
    }
  }

  const out = new Uint8Array(cursor);
  const dv  = new DataView(out.buffer);
  // Header (LE classic TIFF)
  out[0] = 0x49; out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8,  true);

  // IFD
  dv.setUint16(8, tags.length, true);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const p = 10 + i * 12;
    dv.setUint16(p,     t.tag,  true);
    dv.setUint16(p + 2, t.type, true);
    dv.setUint32(p + 4, t.values.length, true);
    const sz = (TYPE_SIZE[t.type] || 0) * t.values.length;
    if (sz <= 4) {
      writeValues(dv, p + 8, t.type, t.values);
    } else {
      dv.setUint32(p + 8, t._offset, true);
    }
  }
  dv.setUint32(10 + tags.length * 12, 0, true);  // nextIFD = 0

  for (const { tag, offset } of externals) writeValues(dv, offset, tag.type, tag.values);
  if (offsetTag) {
    for (let i = 0; i < blocks.length; i++) out.set(blocks[i], offsetTag.values[i]);
  }
  return out;
}

function writeValues(dv, offset, type, values) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    switch (type) {
      case 1: case 7:  dv.setUint8(offset + i, v); break;
      case 2:          dv.setUint8(offset + i, typeof v === 'string' ? v.charCodeAt(0) : v); break;
      case 6:          dv.setInt8(offset + i, v); break;
      case 3:          dv.setUint16(offset + i * 2, v, true); break;
      case 8:          dv.setInt16(offset + i * 2, v, true); break;
      case 4:          dv.setUint32(offset + i * 4, v, true); break;
      case 9:          dv.setInt32(offset + i * 4, v, true); break;
      case 11:         dv.setFloat32(offset + i * 4, v, true); break;
      case 12:         dv.setFloat64(offset + i * 8, v, true); break;
      case 5: case 10:
        dv.setUint32(offset + i * 8,     v[0] >>> 0, true);
        dv.setUint32(offset + i * 8 + 4, v[1] >>> 0, true);
        break;
    }
  }
}

export async function slim(byteSource, opts /*, ctx */) {
  const total = byteSource.size();
  const data  = await byteSource.read(0, total);

  const ifds = parseIFDs(data);
  if (ifds.length > 1)
    throw new SlimError('slim/tiff: multi-IFD (COG with overviews) not supported in v2 — strip the overviews first');
  const ifd  = ifds[0];
  if (ifd.bigtiff)
    throw new SlimError('slim/tiff: BigTIFF slim not supported in v2');
  if (ifd.le === false)
    throw new SlimError('slim/tiff: big-endian TIFF slim not supported in v2');
  const t    = ifd.tags;

  const planar = tagVal(t, TAG.PlanarConfiguration, 1);
  if (planar !== 1 && planar !== 2)
    throw new SlimError(`slim/tiff: PlanarConfiguration=${planar} not supported`);

  const width   = tagVal(t, TAG.ImageWidth);
  const height  = tagVal(t, TAG.ImageLength);
  const bpsRaw  = tagVal(t, TAG.BitsPerSample, 8);
  const sfRaw   = tagVal(t, TAG.SampleFormat, 1);
  const bps     = Array.isArray(bpsRaw) ? bpsRaw[0] : bpsRaw;
  const sf      = Array.isArray(sfRaw)  ? sfRaw[0]  : sfRaw;
  const dtype   = dtypeOf(bps, sf);
  const bpsBytes = bytesPerSample(dtype);
  const samplesPerPixel = tagVal(t, TAG.SamplesPerPixel, 1);
  const compId    = tagVal(t, TAG.Compression, 1);
  const compression = COMPRESSION[compId];
  if (!compression)
    throw new SlimError(`slim/tiff: compression code ${compId} not supported`);
  const predictor = tagVal(t, TAG.Predictor, 1);

  // ── Identify which bands to keep ─────────────────────────────────────
  const names = bandNamesFromGdalMetadata(t, samplesPerPixel);
  const keep  = [];
  for (const want of opts.variables) {
    const idx = names.indexOf(want);
    if (idx === -1)
      throw new VariableNotFoundError(`slim/tiff: unknown variable '${want}' (available: ${names.join(', ')})`);
    keep.push(idx);
  }

  // No-op fast path: keep every band, in original order → copy bytes unchanged.
  const noOp = keep.length === samplesPerPixel && keep.every((v, i) => v === i);
  if (noOp) {
    return {
      bytes: data,
      warnings: [],
      variablesKept:    samplesPerPixel,
      variablesDropped: 0,
    };
  }

  // ── Re-encode each block (strip or tile) ─────────────────────────────
  const isTile = t.has(TAG.TileWidth);
  const blockW = isTile ? tagVal(t, TAG.TileWidth)  : width;
  const blockH = isTile ? tagVal(t, TAG.TileLength) : tagVal(t, TAG.RowsPerStrip);
  const offsetTagId = isTile ? TAG.TileOffsets    : TAG.StripOffsets;
  const countTagId  = isTile ? TAG.TileByteCounts : TAG.StripByteCounts;
  const offsets = t.get(offsetTagId).values;
  const counts  = t.get(countTagId).values;
  const offsetsArr = Array.isArray(offsets) ? offsets : [offsets];
  const countsArr  = Array.isArray(counts)  ? counts  : [counts];

  const newBlocks = [];

  if (planar === 2) {
    // Separate planes: total blocks = SPP * blocksPerPlane.
    // For each kept band, copy its block group VERBATIM (no decode/re-encode).
    const blocksPerPlane = offsetsArr.length / samplesPerPixel;
    if (!Number.isInteger(blocksPerPlane))
      throw new SlimError(`slim/tiff: planar=2 offsets length ${offsetsArr.length} is not a multiple of SPP ${samplesPerPixel}`);
    for (const bandIdx of keep) {
      for (let i = 0; i < blocksPerPlane; i++) {
        const k = bandIdx * blocksPerPlane + i;
        newBlocks.push(data.subarray(offsetsArr[k], offsetsArr[k] + countsArr[k]));
      }
    }
  } else {
    // Chunky (planar=1): decode → drop bands → re-encode.
    for (let i = 0; i < offsetsArr.length; i++) {
      const raw = data.subarray(offsetsArr[i], offsetsArr[i] + countsArr[i]);
      let decoded = await decodeBlock(raw, compression);
      decoded = new Uint8Array(decoded);   // ensure a writable copy
      unpredict(decoded, { predictor, width: blockW, height: blockH, samplesPerPixel, dtype, le: true });
      const dropped = dropBandsChunky(decoded, {
        blockW, blockH, spp: samplesPerPixel, bps: bpsBytes, keep,
      });
      applyPredictor(dropped, { predictor, width: blockW, height: blockH, samplesPerPixel: keep.length, dtype, le: true });
      const enc = await encodeBlock(dropped, compression);
      newBlocks.push(enc);
    }
  }

  // ── Rebuild the IFD: rewrite per-band tags + GDAL_METADATA ───────────
  const newTags = [];
  for (const v of t.values()) newTags.push({ tag: v.tag, type: v.type, values: [...v.values] });
  // Rewrite per-band arrays (BitsPerSample, SampleFormat) to the kept subset.
  for (const tg of newTags) {
    if (tg.tag === TAG.SamplesPerPixel) tg.values = [keep.length];
    else if (tg.tag === TAG.BitsPerSample && Array.isArray(bpsRaw)) {
      tg.values = keep.map(i => bpsRaw[i]);
    }
    else if (tg.tag === TAG.SampleFormat && Array.isArray(sfRaw)) {
      tg.values = keep.map(i => sfRaw[i]);
    }
    else if (tg.tag === TAG.GdalMetadata) {
      const xml = gdalMetadataForKept(names, keep);
      tg.values = Array.from(xml, ch => ch.charCodeAt(0));
    }
  }
  // If BitsPerSample/SampleFormat were single-valued in the source but we
  // ended up with multiple kept bands, expand them (or leave single if 1 kept).
  for (const tagId of [TAG.BitsPerSample, TAG.SampleFormat]) {
    const tg = newTags.find(x => x.tag === tagId);
    if (!tg) continue;
    if (tg.values.length === 1 && keep.length > 1) {
      tg.values = new Array(keep.length).fill(tg.values[0]);
    }
  }

  const outBytes = rewriteTiff({
    tags: newTags,
    blocks: newBlocks,
    isTile,
  });

  return {
    bytes: outBytes,
    warnings: [],
    variablesKept:    keep.length,
    variablesDropped: samplesPerPixel - keep.length,
  };
}
