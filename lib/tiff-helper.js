// lib/tiff-helper.js
//
// Public entry point for the pure-JS TIFF / GeoTIFF reader.
// Mirrors zarr-helper.js: imports internal modules, exposes scan / extract / extractGrid.

import { parseIFDs }            from './tiff/ifd-reader.js';
import { resolveByteSource }    from './slim/byte-source.js';
import { UnsupportedFormatError } from './errors.js';

// ── TIFF tag constants we use here ──────────────────────────────────────
const TAG = {
  ImageWidth:           256,
  ImageLength:          257,
  BitsPerSample:        258,
  Compression:          259,
  StripOffsets:         273,
  SamplesPerPixel:      277,
  RowsPerStrip:         278,
  StripByteCounts:      279,
  PlanarConfiguration:  284,
  Predictor:            317,
  TileWidth:            322,
  TileLength:           323,
  TileOffsets:          324,
  TileByteCounts:       325,
  SampleFormat:         339,
  NewSubfileType:       254,
  GdalMetadata:         42112,
  ModelPixelScale:      33550,
  ModelTiepoint:        33922,
  GeoKeyDirectory:      34735,
  GeoDoubleParams:      34736,
  GeoAsciiParams:       34737,
};

const COMPRESSION = { 1: 'none', 5: 'lzw', 8: 'deflate' };

function dtypeOf(bps, sf) {
  // sf: 1=uint, 2=int, 3=float
  if (sf === 3 && bps === 32) return 'float32';
  if (sf === 1 && bps === 8)  return 'uint8';
  if (sf === 1 && bps === 16) return 'uint16';
  if (sf === 2 && bps === 16) return 'int16';
  throw new UnsupportedFormatError(`tiff: unsupported sample (sampleFormat=${sf}, bps=${bps}) in v1`);
}

function tagVal(tags, tag, def) {
  const t = tags.get(tag);
  if (!t) return def;
  return t.values.length === 1 ? t.values[0] : t.values;
}

function isOverview(ifd) {
  const t = ifd.tags.get(TAG.NewSubfileType);
  return t && (t.values[0] & 0x01) === 1;
}

/** Skim a TIFF buffer and return scan metadata. No pixel decoding. */
export async function scan(source) {
  const bs = await resolveByteSource(source);
  // Read full buffer for now; range-aware scan is added in Phase 7.
  const buf = await bs.read(0, bs.size());
  const ifds = parseIFDs(buf);
  const full = ifds.find(i => !isOverview(i));
  if (!full) throw new UnsupportedFormatError('tiff: no full-resolution IFD found');

  const t = full.tags;
  const width  = tagVal(t, TAG.ImageWidth);
  const height = tagVal(t, TAG.ImageLength);
  const bps    = tagVal(t, TAG.BitsPerSample, 8);
  const sf     = tagVal(t, TAG.SampleFormat, 1);
  const compId = tagVal(t, TAG.Compression, 1);
  const compression = COMPRESSION[compId];
  if (!compression)
    throw new UnsupportedFormatError(`tiff: unsupported compression ${compId} in v1`);

  const samplesPerPixel = tagVal(t, TAG.SamplesPerPixel, 1);
  const layout = t.has(TAG.TileWidth) ? 'tile' : 'strip';
  const cog = layout === 'tile' && ifds.some(isOverview);
  const dtype = dtypeOf(Array.isArray(bps) ? bps[0] : bps, sf);

  // GeoKey + transform (full impl arrives in Phase 5; here we accept WGS84 only).
  const tiepoint = t.get(TAG.ModelTiepoint)?.values;
  const scale    = t.get(TAG.ModelPixelScale)?.values;
  if (!tiepoint || !scale)
    throw new UnsupportedFormatError('tiff: GeoTIFF missing ModelTiepoint or ModelPixelScale');
  const [, , , X0, Y0]  = tiepoint;
  const [sx, sy]        = scale;
  const minLon = X0;
  const maxLat = Y0;
  const maxLon = X0 + sx * width;
  const minLat = Y0 - sy * height;

  return {
    format: 'tiff',
    variable_names: Array.from({ length: samplesPerPixel }, (_, i) => `band_${i + 1}`),
    width, height,
    bbox: [minLon, minLat, maxLon, maxLat],
    crs:  { epsg: 4326, name: 'WGS 84' },   // Phase 5 reads real GeoKeys
    dtype,
    compression,
    layout,
    cog,
    warnings: cog ? ['COG overviews present; using full-resolution IFD 0'] : [],
  };
}
