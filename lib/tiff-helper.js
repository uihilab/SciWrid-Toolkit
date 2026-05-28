// lib/tiff-helper.js
//
// Public entry point for the pure-JS TIFF / GeoTIFF reader.
// Mirrors zarr-helper.js: imports internal modules, exposes scan / extract / extractGrid.

import { parseIFDs }            from './tiff/ifd-reader.js';
import { resolveByteSource }    from './slim/byte-source.js';
import { locatePixel }          from './tiff/tile-index.js';
import { sampleValue }          from './tiff/sample-decoder.js';
import { decode as decNone }     from './tiff/decoders/none.js';
import { decode as decDeflate }  from './tiff/decoders/deflate.js';
import { decode as decLzw }      from './tiff/decoders/lzw.js';
import { decode as decPackbits } from './tiff/decoders/packbits.js';
import { decode as decJpeg }     from './tiff/decoders/jpeg.js';
import { decode as decWebp }     from './tiff/decoders/webp.js';
import { unpredict }            from './tiff/predictors.js';
import { parseGeoKeys }         from './tiff/geokeys.js';
import { latLonToNative, nativeBboxToWgs84 } from './tiff/projections.js';
import { UnsupportedFormatError, VariableNotFoundError } from './errors.js';

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

const COMPRESSION = { 1: 'none', 5: 'lzw', 7: 'jpeg', 8: 'deflate', 32773: 'packbits', 50001: 'webp' };

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

/**
 * Read enough of the file's prefix to parse all IFDs. Returns the buffer
 * (potentially the entire file for small inputs) along with the byte source
 * so callers can issue targeted reads for pixel data later.
 *
 * Range-aware sources (HTTP) only fetch what's needed; in-memory sources
 * just hand back a view.
 */
async function readIFDPrefix(bs) {
  const total = bs.size();
  let read = Math.min(total, 4096);
  let buf = await bs.read(0, read);
  // Keep extending until parseIFDs succeeds (the IFD chain or tag externals
  // may live past the initial chunk).
  while (true) {
    try {
      parseIFDs(buf);
      return buf;
    } catch (e) {
      const msg = String(e.message || e);
      if ((/past EOF/.test(msg) || /spans past EOF/.test(msg)) && read < total) {
        read = Math.min(total, read * 2);
        buf = await bs.read(0, read);
        continue;
      }
      throw e;
    }
  }
}

/** Skim a TIFF buffer and return scan metadata. No pixel decoding. */
export async function scan(source) {
  const bs = await resolveByteSource(source);
  const buf = await readIFDPrefix(bs);
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
  const dtype = dtypeOf(Array.isArray(bps) ? bps[0] : bps,
                        Array.isArray(sf)  ? sf[0]  : sf);

  // GeoKey + transform.
  const tiepoint = t.get(TAG.ModelTiepoint)?.values;
  const scale    = t.get(TAG.ModelPixelScale)?.values;
  if (!tiepoint || !scale)
    throw new UnsupportedFormatError('tiff: GeoTIFF missing ModelTiepoint or ModelPixelScale');
  const geo = parseGeoKeys(t);   // throws UnsupportedCRSError for non-v1 CRS
  const [, , , X0, Y0]  = tiepoint;
  const [sx, sy]        = scale;
  const nativeBbox = [X0, Y0 - sy * height, X0 + sx * width, Y0];
  const bbox = nativeBboxToWgs84(nativeBbox, geo);

  const variable_names = bandNamesFromGdalMetadata(t, samplesPerPixel);

  // Surface overview IFDs (smallest-first). Each overview reports its width,
  // height, IFD index, and resolution-reduction ratio relative to the main.
  const overviews = [];
  for (let i = 0; i < ifds.length; i++) {
    if (!isOverview(ifds[i])) continue;
    const ot = ifds[i].tags;
    const ow = tagVal(ot, TAG.ImageWidth);
    const oh = tagVal(ot, TAG.ImageLength);
    const ratio = Math.round(width / ow);
    overviews.push({ width: ow, height: oh, ifdIndex: i, ratio });
  }
  overviews.sort((a, b) => a.width - b.width);   // smallest first

  return {
    format: 'tiff',
    variable_names,
    width, height,
    bbox,
    crs:  { epsg: geo.epsg, name: geo.name },
    dtype,
    compression,
    layout,
    cog,
    overviews,
    warnings: [],
  };
}

function bandNamesFromGdalMetadata(tags, samplesPerPixel) {
  const t = tags.get(TAG.GdalMetadata);
  const names = Array.from({ length: samplesPerPixel }, (_, i) => `band_${i + 1}`);
  if (!t) return names;
  // ASCII tag values are byte codepoints; reassemble and trim trailing NULs.
  const xml = String.fromCharCode(...t.values).replace(/\0+$/, '');
  const re = /<Item\s+name="DESCRIPTION"\s+sample="(\d+)"\s*>([^<]+)<\/Item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const i = Number(m[1]);
    if (i >= 0 && i < samplesPerPixel) names[i] = m[2].trim();
  }
  return names;
}

function bandIndexFor(variable, names) {
  const i = names.indexOf(variable);
  if (i === -1) throw new VariableNotFoundError(
    `tiff: unknown variable '${variable}' (available: ${names.join(', ')})`);
  return i;
}

async function decodeBlock(rawBytes, compression, opts = {}) {
  if (compression === 'none')     return decNone(rawBytes);
  if (compression === 'deflate')  return decDeflate(rawBytes);
  if (compression === 'lzw')      return decLzw(rawBytes);
  if (compression === 'packbits') return decPackbits(rawBytes);
  if (compression === 'jpeg')     return decJpeg(rawBytes, { samplesPerPixel: opts.samplesPerPixel });
  if (compression === 'webp')     return decWebp(rawBytes, { samplesPerPixel: opts.samplesPerPixel });
  throw new UnsupportedFormatError(`tiff: compression ${compression} not handled`);
}

export async function extract(source, { variable, lat, lon } = {}) {
  const bs = await resolveByteSource(source);
  const buf = await readIFDPrefix(bs);
  const ifds = parseIFDs(buf);
  const full = ifds.find(i => !isOverview(i));
  const t = full.tags;

  const width  = tagVal(t, TAG.ImageWidth);
  const height = tagVal(t, TAG.ImageLength);
  const bps    = tagVal(t, TAG.BitsPerSample, 8);
  const sf     = tagVal(t, TAG.SampleFormat, 1);
  const dtype  = dtypeOf(Array.isArray(bps) ? bps[0] : bps,
                         Array.isArray(sf)  ? sf[0]  : sf);
  const compression = COMPRESSION[tagVal(t, TAG.Compression, 1)];
  const samplesPerPixel = tagVal(t, TAG.SamplesPerPixel, 1);
  const predictor = tagVal(t, TAG.Predictor, 1);
  const bandIdx = bandIndexFor(variable, bandNamesFromGdalMetadata(t, samplesPerPixel));

  // Geo transform: project lat/lon into the file's native CRS, then index.
  const geo = parseGeoKeys(t);
  const tiepoint = t.get(TAG.ModelTiepoint).values;
  const scale    = t.get(TAG.ModelPixelScale).values;
  const X0 = tiepoint[3], Y0 = tiepoint[4];
  const sx = scale[0],    sy = scale[1];
  const native = latLonToNative({ lat, lon }, geo);
  const col = Math.floor((native.x - X0) / sx);
  const row = Math.floor((Y0 - native.y) / sy);
  if (col < 0 || col >= width || row < 0 || row >= height)
    return { value: null, lat, lon, variable, units: null };

  const blk = locatePixel(t, row, col);
  // Targeted read: if the block bytes fit in our prefix buffer, slice from it;
  // otherwise issue a Range fetch via the byte source.
  const raw = (blk.offset + blk.length <= buf.length)
    ? buf.subarray(blk.offset, blk.offset + blk.length)
    : await bs.read(blk.offset, blk.length);
  const decoded = await decodeBlock(raw, compression, { samplesPerPixel });
  const le = full.le !== false;   // default LE if absent (legacy)
  unpredict(decoded, {
    predictor, width: blk.blockWidth, height: blk.blockHeight,
    samplesPerPixel, dtype, le,
  });
  const value = sampleValue(decoded, {
    rowInBlock: blk.rowInBlock, colInBlock: blk.colInBlock,
    blockWidth: blk.blockWidth, samplesPerPixel, bandIndex: bandIdx, dtype, le,
  });
  return { value, lat, lon, variable, units: null };
}

/**
 * Pick the smallest IFD whose dimensions still meet/exceed the requested
 * output (`requestedW` × `requestedH`). Falls back to the full-resolution
 * IFD if no overview is large enough. Returns the chosen IFD.
 */
function selectIfd(ifds, fullIfd, requestedW, requestedH) {
  if (requestedW == null || requestedH == null) return fullIfd;
  const candidates = ifds.map(ifd => {
    const w = ifd.tags.get(TAG.ImageWidth)?.values?.[0];
    const h = ifd.tags.get(TAG.ImageLength)?.values?.[0];
    return { ifd, w, h };
  }).filter(c => c.w != null && c.h != null);
  const usable = candidates.filter(c => c.w >= requestedW && c.h >= requestedH);
  if (usable.length === 0) return fullIfd;
  // Pick smallest sufficient — minimises bytes fetched / decoded.
  usable.sort((a, b) => (a.w * a.h) - (b.w * b.h));
  return usable[0].ifd;
}

export async function extractGrid(source, { variable, bbox, width: requestedW, height: requestedH, ifd: forcedIfdIndex } = {}) {
  const bs = await resolveByteSource(source);
  const buf = await readIFDPrefix(bs);
  const ifds = parseIFDs(buf);
  const fullIfd = ifds.find(i => !isOverview(i));
  // Auto-pick an overview IFD if `width`/`height` are smaller than full-res.
  // Caller can override by passing `ifd: <index>`.
  const chosen = (forcedIfdIndex != null && ifds[forcedIfdIndex])
    ? ifds[forcedIfdIndex]
    : selectIfd(ifds, fullIfd, requestedW, requestedH);
  const full = chosen;
  const t = full.tags;
  const usingOverview = chosen !== fullIfd;

  const width  = tagVal(t, TAG.ImageWidth);
  const height = tagVal(t, TAG.ImageLength);
  const bps    = tagVal(t, TAG.BitsPerSample, 8);
  const sf     = tagVal(t, TAG.SampleFormat, 1);
  const dtype  = dtypeOf(Array.isArray(bps) ? bps[0] : bps,
                         Array.isArray(sf)  ? sf[0]  : sf);
  const compression = COMPRESSION[tagVal(t, TAG.Compression, 1)];
  const samplesPerPixel = tagVal(t, TAG.SamplesPerPixel, 1);
  const predictor = tagVal(t, TAG.Predictor, 1);

  const geo = parseGeoKeys(t);
  const tiepoint = t.get(TAG.ModelTiepoint).values;
  const scale    = t.get(TAG.ModelPixelScale).values;
  const X0 = tiepoint[3], Y0 = tiepoint[4];
  const sx = scale[0],    sy = scale[1];
  const bandIdx = bandIndexFor(variable, bandNamesFromGdalMetadata(t, samplesPerPixel));
  const le = full.le !== false;

  let col0 = 0, row0 = 0, col1 = width, row1 = height;
  let outBbox = nativeBboxToWgs84([X0, Y0 - sy * height, X0 + sx * width, Y0], geo);
  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const sw = latLonToNative({ lat: minLat, lon: minLon }, geo);
    const ne = latLonToNative({ lat: maxLat, lon: maxLon }, geo);
    const nw = latLonToNative({ lat: maxLat, lon: minLon }, geo);
    const se = latLonToNative({ lat: minLat, lon: maxLon }, geo);
    const xs = [sw.x, ne.x, nw.x, se.x];
    const ys = [sw.y, ne.y, nw.y, se.y];
    const cx0 = Math.floor((Math.min(...xs) - X0) / sx);
    const cx1 = Math.ceil ((Math.max(...xs) - X0) / sx);
    const ry0 = Math.floor((Y0 - Math.max(...ys)) / sy);
    const ry1 = Math.ceil ((Y0 - Math.min(...ys)) / sy);
    col0 = Math.max(0, cx0); col1 = Math.min(width,  cx1);
    row0 = Math.max(0, ry0); row1 = Math.min(height, ry1);
    outBbox = [minLon, minLat, maxLon, maxLat];
  }
  const sourceW = col1 - col0, sourceH = row1 - row0;
  // Output size: caller's requested dims OR the source window if absent.
  const outW = (requestedW != null) ? requestedW : sourceW;
  const outH = (requestedH != null) ? requestedH : sourceH;
  const out = new Float32Array(outW * outH);

  // Enumerate blocks overlapping (row0..row1, col0..col1) and copy pixels.
  const isTile = t.has(TAG.TileWidth);
  const blockW = isTile ? tagVal(t, TAG.TileWidth)    : width;
  const blockH = isTile ? tagVal(t, TAG.TileLength)   : tagVal(t, TAG.RowsPerStrip);
  const cache = new Map(); // blockKey → decoded bytes

  // Nearest-neighbour mapping from output (oy, ox) to source (r, c).
  // When outW == sourceW (no resampling) this collapses to identity.
  const xScale = sourceW / outW;
  const yScale = sourceH / outH;

  for (let oy = 0; oy < outH; oy++) {
    const r = row0 + Math.floor((oy + 0.5) * yScale);
    for (let ox = 0; ox < outW; ox++) {
      const c = col0 + Math.floor((ox + 0.5) * xScale);
      const by = Math.floor(r / blockH), bx = Math.floor(c / blockW);
      const key = `${by},${bx}`;
      let decoded = cache.get(key);
      if (!decoded) {
        const blk = locatePixel(t, by * blockH, bx * blockW);
        const raw = (blk.offset + blk.length <= buf.length)
          ? buf.subarray(blk.offset, blk.offset + blk.length)
          : await bs.read(blk.offset, blk.length);
        decoded = await decodeBlock(raw, compression, { samplesPerPixel });
        unpredict(decoded, { predictor, width: blk.blockWidth, height: blk.blockHeight, samplesPerPixel, dtype, le });
        cache.set(key, decoded);
      }
      const v = sampleValue(decoded, {
        rowInBlock: r - by * blockH, colInBlock: c - bx * blockW,
        blockWidth: blockW, samplesPerPixel, bandIndex: bandIdx, dtype, le,
      });
      out[oy * outW + ox] = v;
    }
  }
  return { data: out, width: outW, height: outH, bbox: outBbox, variable, units: null, time: null,
           usedOverview: usingOverview };
}
