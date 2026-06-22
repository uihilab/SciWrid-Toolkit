/*
 * lib/grid-output.js  --  Serializers for extractGrid() results.
 *
 * Public helpers:
 *   gridToJSON(grid)               → string             portable, human-readable
 *   gridToGeoTIFF(grid, opts?)     → Uint8Array         GeoTIFF
 *
 * Both consume the result returned by extractGrid:
 *   { data: Float32Array | Float32Array[], width, height,
 *     bbox: [minLon,minLat,maxLon,maxLat], variable, units?, time?,
 *     variable_names? }
 *
 * GeoTIFF writer features (v2):
 *   - Single-band OR multi-band (chunky planar=1)
 *   - Dtype: float32 (default), uint8, uint16, int16
 *   - Compression: none (default), deflate
 *   - Predictor: 1 (default), 2 (horizontal), 3 (floating-point)
 *   - CRS: geographic (WGS84 default), UTM, sinusoidal, LCC, polar stereo, Albers
 *   - Band names from grid.variable_names → GDAL_METADATA tag
 *
 * Row 0 is at maxLat (north-up), matching extractGrid's convention.
 */

import { applyPredictor }  from './tiff/encoders/predictor.js';
import { encode as encDeflate } from './tiff/encoders/deflate.js';
import { latLonToNative }  from './tiff/projections.js';

/* ========================================================================
 * JSON
 * ====================================================================== */
export function gridToJSON(grid, { pretty = false } = {}) {
  _validateGrid(grid);
  const dataOut = Array.isArray(grid.data)
    ? grid.data.map(band => Array.from(band, (v) => (Number.isFinite(v) ? v : null)))
    : Array.from(grid.data, (v) => (Number.isFinite(v) ? v : null));
  const payload = {
    variable: grid.variable,
    variable_names: grid.variable_names ?? null,
    width:    grid.width,
    height:   grid.height,
    bbox:     grid.bbox,
    units:    grid.units ?? null,
    time:     grid.time ?? null,
    data:     dataOut,
  };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

/* ========================================================================
 * GeoTIFF
 * ====================================================================== */

// Dtype info — bytes per sample, SampleFormat tag value (1=uint, 2=int, 3=float).
const DTYPE = {
  float32: { bytes: 4, sf: 3, bps: 32, typedArray: Float32Array },
  uint8:   { bytes: 1, sf: 1, bps: 8,  typedArray: Uint8Array },
  uint16:  { bytes: 2, sf: 1, bps: 16, typedArray: Uint16Array },
  int16:   { bytes: 2, sf: 2, bps: 16, typedArray: Int16Array },
};

const COMP_CODE = { 'none': 1, 'deflate': 8 };

export async function gridToGeoTIFF(grid, opts = {}) {
  _validateGrid(grid);

  const dtype = opts.dtype ?? 'float32';
  const dinfo = DTYPE[dtype];
  if (!dinfo) throw new Error(`gridToGeoTIFF: unsupported dtype '${dtype}'`);

  const compression = opts.compression ?? 'none';
  const compCode    = COMP_CODE[compression];
  if (compCode == null)
    throw new Error(`gridToGeoTIFF: unsupported compression '${compression}'`);

  // predictor: 1 (none), 2 (horizontal), 3 (floating-point)
  let predictor = opts.predictor ?? 1;
  if (predictor === 'floating-point') predictor = 3;
  if (predictor === 'horizontal')     predictor = 2;
  if (![1, 2, 3].includes(predictor))
    throw new Error(`gridToGeoTIFF: unsupported predictor '${opts.predictor}'`);

  const { width, height, bbox } = grid;

  // Normalize data to an array-of-bands shape (multi-band uniformly).
  const isMulti = Array.isArray(grid.data);
  const bands = isMulti ? grid.data : [grid.data];
  const SPP = bands.length;
  // Variable names → GDAL_METADATA. Length must match SPP for explicit names.
  const variable_names = Array.isArray(grid.variable_names) && grid.variable_names.length === SPP
    ? grid.variable_names
    : Array.from({ length: SPP }, (_, i) => `band_${i + 1}`);

  // Convert each band to the target dtype if necessary (caller may pass
  // Float32 always; we down-cast as a convenience).
  const bandsTyped = bands.map(b => {
    if (b instanceof dinfo.typedArray) return b;
    // Re-cast: copy values through the target typed array (NaN → 0 for ints).
    const out = new dinfo.typedArray(b.length);
    if (dtype === 'float32') {
      for (let i = 0; i < b.length; i++) out[i] = b[i];
    } else {
      for (let i = 0; i < b.length; i++) out[i] = Number.isFinite(b[i]) ? b[i] : 0;
    }
    return out;
  });

  // Interleave bands into chunky pixel bytes.
  const totalPx = width * height;
  const rowBytes = width * SPP * dinfo.bytes;
  const rawPixels = new Uint8Array(totalPx * SPP * dinfo.bytes);
  if (SPP === 1) {
    // Fast path: single band, copy bytes directly.
    rawPixels.set(new Uint8Array(bandsTyped[0].buffer, bandsTyped[0].byteOffset, bandsTyped[0].byteLength));
  } else {
    const dv = new DataView(rawPixels.buffer);
    for (let p = 0; p < totalPx; p++) {
      for (let b = 0; b < SPP; b++) {
        const off = (p * SPP + b) * dinfo.bytes;
        const v   = bandsTyped[b][p];
        if (dtype === 'float32') dv.setFloat32(off, v, true);
        else if (dtype === 'uint8')  rawPixels[off] = v;
        else if (dtype === 'uint16') dv.setUint16(off, v, true);
        else if (dtype === 'int16')  dv.setInt16(off, v, true);
      }
    }
  }

  // Apply predictor in place (if any).
  if (predictor !== 1) {
    applyPredictor(rawPixels, {
      predictor, width, height, samplesPerPixel: SPP, dtype, le: true,
    });
  }

  // Compress (if requested).
  let stripData = rawPixels;
  if (compression === 'deflate') stripData = await encDeflate(rawPixels);

  // ── CRS / projection setup ─────────────────────────────────────────
  // Default: WGS84 geographic.  When opts.crs.kind is non-geographic, we
  // project the bbox corners to native coords for the tiepoint + pixel scale.
  const crs = opts.crs ?? { kind: 'geographic' };
  const [minLon, minLat, maxLon, maxLat] = bbox;
  let X0, Y0, dx, dy;
  let geoKeyEntries;
  if (crs.kind === 'geographic') {
    X0 = minLon; Y0 = maxLat;
    dx = (maxLon - minLon) / width;
    dy = (maxLat - minLat) / height;
    geoKeyEntries = [
      [1024, 0, 1, 2],                  // GTModelType = geographic
      [1025, 0, 1, 1],                  // RasterPixelIsArea
      [2048, 0, 1, crs.epsg ?? 4326],   // GeographicTypeGeoKey
    ];
  } else {
    // Project bbox corners to native units.
    const corners = [
      latLonToNative({ lat: minLat, lon: minLon }, crs),
      latLonToNative({ lat: maxLat, lon: minLon }, crs),
      latLonToNative({ lat: minLat, lon: maxLon }, crs),
      latLonToNative({ lat: maxLat, lon: maxLon }, crs),
    ];
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    const nMinX = Math.min(...xs), nMaxX = Math.max(...xs);
    const nMinY = Math.min(...ys), nMaxY = Math.max(...ys);
    X0 = nMinX; Y0 = nMaxY;
    dx = (nMaxX - nMinX) / width;
    dy = (nMaxY - nMinY) / height;
    geoKeyEntries = [
      [1024, 0, 1, 1],                  // GTModelType = projected
      [1025, 0, 1, 1],
      [3072, 0, 1, crs.epsg ?? 32767],  // ProjectedCSTypeGeoKey
    ];
  }

  // Build the GeoKeyDirectory tag values (header + numKeys × 4 SHORTs).
  const geoKeyDir = [1, 1, 0, geoKeyEntries.length];
  for (const k of geoKeyEntries) geoKeyDir.push(...k);
  const geoKeyDirArr = new Uint16Array(geoKeyDir);

  // ── Build the IFD ──────────────────────────────────────────────────
  const modelPixelScale = new Float64Array([dx, dy, 0]);
  const modelTiepoint   = new Float64Array([0, 0, 0, X0, Y0, 0]);
  const gdalMeta = bandNamesToGdalMetadata(variable_names);
  const gdalMetaBytes = new Uint8Array(Array.from(gdalMeta, ch => ch.charCodeAt(0)));
  const gdalNoDataBytes = new Uint8Array([0x6e, 0x61, 0x6e, 0x00]);

  const tags = [
    { id: 256, type: 4,  count: 1,        value: width },              // ImageWidth
    { id: 257, type: 4,  count: 1,        value: height },             // ImageLength
    { id: 258, type: 3,  count: SPP,      values: Array(SPP).fill(dinfo.bps) },     // BitsPerSample
    { id: 259, type: 3,  count: 1,        value: compCode },           // Compression
    { id: 262, type: 3,  count: 1,        value: 1 },                  // PhotometricInterpretation
    { id: 273, type: 4,  count: 1,        valueRef: 'stripOffset' },   // StripOffsets
    { id: 277, type: 3,  count: 1,        value: SPP },                // SamplesPerPixel
    { id: 278, type: 4,  count: 1,        value: height },             // RowsPerStrip
    { id: 279, type: 4,  count: 1,        value: stripData.length },   // StripByteCounts
    { id: 284, type: 3,  count: 1,        value: 1 },                  // PlanarConfiguration = chunky
    ...(predictor !== 1 ? [{ id: 317, type: 3, count: 1, value: predictor }] : []),
    { id: 339, type: 3,  count: SPP,      values: Array(SPP).fill(dinfo.sf) },     // SampleFormat
    { id: 33550, type: 12, count: 3, externalBytes: new Uint8Array(modelPixelScale.buffer) },
    { id: 33922, type: 12, count: 6, externalBytes: new Uint8Array(modelTiepoint.buffer) },
    { id: 34735, type: 3,  count: geoKeyDirArr.length, externalBytes: new Uint8Array(geoKeyDirArr.buffer) },
    ...(SPP > 1 ? [{ id: 42112, type: 2, count: gdalMetaBytes.length, externalBytes: gdalMetaBytes }] : []),
    ...(dtype === 'float32' ? [{ id: 42113, type: 2, count: gdalNoDataBytes.length, externalBytes: gdalNoDataBytes }] : []),
  ];

  // For tags with `values` (array but small), inline if total ≤ 4 bytes.
  // Otherwise, hoist to external bytes.
  const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
  for (const tag of tags) {
    if (tag.values) {
      const tb = TYPE_BYTES[tag.type] || 0;
      const sz = tb * tag.values.length;
      if (sz > 4) {
        const buf = new Uint8Array(sz);
        const dv = new DataView(buf.buffer);
        for (let i = 0; i < tag.values.length; i++) {
          if (tag.type === 3) dv.setUint16(i * 2, tag.values[i], true);
          else if (tag.type === 4) dv.setUint32(i * 4, tag.values[i], true);
        }
        tag.externalBytes = buf;
      }
    }
  }

  // Sort tags by id (TIFF spec requires ascending tag order).
  tags.sort((a, b) => a.id - b.id);

  // Layout: header (8) + IFD (2+N*12+4) + externals + strip data
  const numEntries = tags.length;
  const ifdSize    = 2 + numEntries * 12 + 4;
  const ifdOffset  = 8;
  let cursor = ifdOffset + ifdSize;
  for (const tag of tags) {
    if (tag.externalBytes) {
      tag.offset = cursor;
      cursor += tag.externalBytes.length;
      if (cursor & 1) cursor++;     // word-align
    }
  }
  const stripOffset = cursor;
  const totalSize   = stripOffset + stripData.length;

  const out = new Uint8Array(totalSize);
  const dv  = new DataView(out.buffer);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42,     true);
  dv.setUint32(4, ifdOffset, true);

  dv.setUint16(ifdOffset, numEntries, true);
  let p = ifdOffset + 2;
  for (const tag of tags) {
    dv.setUint16(p,     tag.id,    true);
    dv.setUint16(p + 2, tag.type,  true);
    dv.setUint32(p + 4, tag.count, true);
    if (tag.externalBytes) {
      dv.setUint32(p + 8, tag.offset, true);
    } else if (tag.valueRef === 'stripOffset') {
      dv.setUint32(p + 8, stripOffset, true);
    } else if (tag.values) {
      // Small inline array (≤ 4 bytes total).
      for (let i = 0; i < tag.values.length; i++) {
        if (tag.type === 3) dv.setUint16(p + 8 + i * 2, tag.values[i], true);
        else if (tag.type === 4) dv.setUint32(p + 8 + i * 4, tag.values[i], true);
      }
    } else {
      if (tag.type === 4)      dv.setUint32(p + 8, tag.value, true);
      else if (tag.type === 3) dv.setUint16(p + 8, tag.value, true);
      else throw new Error('gridToGeoTIFF: unhandled inline tag type ' + tag.type);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true);   // nextIFD = 0

  for (const tag of tags) {
    if (tag.externalBytes) out.set(tag.externalBytes, tag.offset);
  }
  out.set(stripData, stripOffset);

  return out;
}

function bandNamesToGdalMetadata(names) {
  const lines = ['<GDALMetadata>'];
  for (let i = 0; i < names.length; i++) {
    lines.push(`  <Item name="DESCRIPTION" sample="${i}">${names[i]}</Item>`);
  }
  lines.push('</GDALMetadata>');
  return lines.join('\n') + '\0';
}

/* ========================================================================
 * helpers
 * ====================================================================== */
function _validateGrid(g) {
  if (!g || typeof g !== 'object')
    throw new Error('grid must be an object returned by extractGrid()');
  if (!Number.isInteger(g.width) || g.width <= 0 ||
      !Number.isInteger(g.height) || g.height <= 0)
    throw new Error('grid.width and grid.height must be positive integers');
  if (!Array.isArray(g.bbox) || g.bbox.length !== 4)
    throw new Error('grid.bbox must be [minLon, minLat, maxLon, maxLat]');

  // Accept either a single typed array or an array of typed arrays.
  if (Array.isArray(g.data)) {
    if (g.data.length === 0) throw new Error('grid.data: empty band array');
    for (const band of g.data) {
      if (!ArrayBuffer.isView(band))
        throw new Error('grid.data[*] must be a typed array (e.g. Float32Array)');
      if (band.length !== g.width * g.height)
        throw new Error(`grid.data[*].length (${band.length}) != width*height (${g.width * g.height})`);
    }
  } else if (ArrayBuffer.isView(g.data)) {
    if (g.data.length !== g.width * g.height)
      throw new Error(`grid.data.length (${g.data.length}) != width*height (${g.width * g.height})`);
  } else {
    throw new Error('grid.data must be a typed array or an array of typed arrays');
  }
}
