// lib/zarr/metadata.js
//
// Zarr v2 metadata parsing: .zarray dtype/fill, .zattrs CRS reading,
// and coordinate-array resolution for variables that declare _ARRAY_DIMENSIONS.

/* ====================================================================== */
/* dtype parsing — Zarr v2 uses NumPy typestrings, e.g. "<f4", "|u1"       */
/* ====================================================================== */

/**
 * Returns { byteOrder, kind, bytes, view(buf, off, n) → typed array }.
 * Throws on unsupported dtypes.
 */
export function parseDtype(dtype) {
  const m = /^([<>|])([fiuUS])(\d+)$/.exec(String(dtype));
  if (!m) throw new Error('Unsupported dtype: ' + dtype);
  const [, order, kind, sizeStr] = m;
  const size = parseInt(sizeStr, 10);
  const stringLike = kind === 'U' || kind === 'S';
  const bytes = kind === 'U' ? size * 4 : size;
  const bigEndian = order === '>';

  const map = {
    'f4': Float32Array, 'f8': Float64Array,
    'i1': Int8Array,    'i2': Int16Array,   'i4': Int32Array,
    'u1': Uint8Array,   'u2': Uint16Array,  'u4': Uint32Array,
  };
  /* 64-bit integers: JS has no Number-typed array for these, so we read them
   * as BigInt arrays and narrow each element to Number (Float64) below. */
  const bigMap = { 'i8': BigInt64Array, 'u8': BigUint64Array };

  const key     = kind + bytes;
  const isHalf  = key === 'f2';
  const Ctor    = map[key]    || null;
  const BigCtor = bigMap[key] || null;
  if (!Ctor && !BigCtor && !isHalf && !stringLike) throw new Error('Unsupported dtype: ' + dtype);

  function maybeSwap(u8, elemBytes) {
    if (!bigEndian || elemBytes < 2) return u8;
    const out = u8.slice();
    for (let i = 0; i < out.length; i += elemBytes) {
      for (let a = 0, b = elemBytes - 1; a < b; a++, b--) {
        const t = out[i + a];
        out[i + a] = out[i + b];
        out[i + b] = t;
      }
    }
    return out;
  }

  function half2float(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  return {
    byteOrder: order === '|' ? 'na' : (bigEndian ? 'be' : 'le'),
    kind, bytes, Ctor, stringLike,
    /* view raw bytes as the typed array. Chunk bytes can land at any byte
     * offset in their parent ZIP buffer, so the absolute offset is not
     * guaranteed to be a multiple of `bytes`. When misaligned, copy into
     * a fresh aligned buffer (rare path; only ever costs us once per chunk).
     * For 64-bit ints we always return a numeric Float64Array (BigInt ->
     * Number) so the downstream Float32/Float64 placement path is unchanged;
     * values beyond 2^53 lose low-order precision (fine for time/id axes).
     * Fixed-width strings are exposed as synthetic numeric positions; the
     * public extract path is numeric and cannot return string labels yet. */
    view: (buf, byteOff, count) => {
      if (stringLike) {
        const out = new Float64Array(count);
        for (let i = 0; i < count; i++) out[i] = i;
        return out;
      }
      const slice = buf.subarray(byteOff, byteOff + count * bytes);
      const u8 = maybeSwap(slice, bytes);
      const abs = u8.byteOffset;
      if (isHalf) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = half2float(dv.getUint16(i * 2, true));
        return out;
      }
      if (BigCtor) {
        let big;
        if (abs % bytes === 0) {
          big = new BigCtor(u8.buffer, abs, count);
        } else {
          big = new BigCtor(u8.slice().buffer);
        }
        const out = new Float64Array(count);
        for (let i = 0; i < count; i++) out[i] = Number(big[i]);
        return out;
      }
      if (abs % bytes === 0) return new Ctor(u8.buffer, abs, count);
      const copy = new Uint8Array(count * bytes);
      copy.set(u8.subarray(0, count * bytes));
      return new Ctor(copy.buffer);
    },
  };
}

/* ====================================================================== */
/* fill_value parsing — JSON allows numbers, "NaN", "Infinity", -Infinity */
/* ====================================================================== */

export function parseFillValue(fv) {
  if (fv === null || fv === undefined) return NaN;
  if (typeof fv === 'number') return fv;
  if (typeof fv === 'string') {
    if (fv === 'NaN')         return NaN;
    if (fv === 'Infinity')    return Infinity;
    if (fv === '-Infinity')   return -Infinity;
    const n = Number(fv);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/* ====================================================================== */
/* Zarr v2 store walking                                                   */
/* ====================================================================== */

/**
 * Group entries from the flat zip map into per-array bundles.
 * For each path that contains a `.zarray`, collect:
 *   { name, meta (parsed JSON), attrs (parsed .zattrs or null), chunkPaths }
 */
export function indexArrays(entries) {
  const decoder = new TextDecoder();
  const arrays  = [];

  /* Find every .zarray and treat its parent path as the array root */
  for (const path of Object.keys(entries)) {
    if (!path.endsWith('/.zarray') && path !== '.zarray') continue;

    const root = path === '.zarray' ? '' : path.slice(0, -'.zarray'.length);
    const meta = JSON.parse(decoder.decode(entries[path]));

    const attrsPath = root + '.zattrs';
    const attrs = entries[attrsPath]
      ? JSON.parse(decoder.decode(entries[attrsPath]))
      : null;

    /* Display name: trim trailing slash; root array = '/' */
    const name = root.endsWith('/') ? root.slice(0, -1) : (root || '/');

    arrays.push({ name: name || '/', root, meta, attrs });
  }

  return arrays;
}

/* ====================================================================== */
/* Coordinate-axis resolution                                              */
/*                                                                         */
/* Real-world zarr stores carry their own 1-D lat/lon/time arrays — either */
/* linked explicitly via xarray's `_ARRAY_DIMENSIONS` attr, or by          */
/* convention (sibling arrays named `latitude`/`lat`/`y` etc.).            */
/* This helper is pure-metadata (cheap) so it can run during scan(),       */
/* before any chunk bytes are decoded.                                     */
/* ====================================================================== */

const LAT_ALIASES  = ['latitude',  'lat', 'y'];
const LON_ALIASES  = ['longitude', 'lon', 'x'];
const TIME_ALIASES = ['time',      't',   'valid_time'];

/** Find a 1-D array in scanResult.arrays by name and required length. */
export function find1DArray(arrays, name, expectedLen) {
  if (!name) return null;
  const got = arrays.find(x => x.name === name);
  if (!got || !got.meta || !Array.isArray(got.meta.shape)) return null;
  if (got.meta.shape.length !== 1) return null;
  if (got.meta.shape[0] !== expectedLen) return null;
  return got;
}

/**
 * Resolve coordinate references for a multi-dim data var.
 * Returns { latRef, lonRef, timeRef, nt, ny, nx, source, warnings }.
 *
 *   source: 'explicit' | 'fallback' | 'synthetic'
 *     - explicit:   matched via _ARRAY_DIMENSIONS
 *     - fallback:   matched by alias name + length
 *     - synthetic:  no lat/lon arrays found; caller must use index axes
 *
 * Cheap — only inspects .zarray/.zattrs already parsed by indexArrays().
 * No chunk bytes are read here.
 */
export function resolveCoordRefs(scanResult, arrayInfo) {
  const shape   = (arrayInfo.meta && arrayInfo.meta.shape) || [];
  const ndim    = shape.length;
  const arrays  = scanResult.arrays;
  const warnings = [];

  let nt, ny, nx;
  if (ndim === 1)      { nt = 1;        ny = 1;             nx = shape[0]; }
  else if (ndim === 2) { nt = 1;        ny = shape[0];      nx = shape[1]; }
  else if (ndim === 3) { nt = shape[0]; ny = shape[1];      nx = shape[2]; }
  else                 { nt = shape[0]; ny = shape[ndim-2]; nx = shape[ndim-1]; }

  let latRef = null, lonRef = null, timeRef = null;
  let source = 'synthetic';

  /* 1. Explicit xarray-style _ARRAY_DIMENSIONS linkage. */
  const attrs = arrayInfo.attrs || null;
  const dims  = attrs && Array.isArray(attrs._ARRAY_DIMENSIONS)
    ? attrs._ARRAY_DIMENSIONS : null;

  if (dims && dims.length === ndim) {
    const latDim  = dims[ndim - 2];
    const lonDim  = dims[ndim - 1];
    const timeDim = ndim >= 3 ? dims[0] : null;
    latRef  = find1DArray(arrays, latDim, ny);
    lonRef  = find1DArray(arrays, lonDim, nx);
    timeRef = timeDim ? find1DArray(arrays, timeDim, nt) : null;
    if (latRef && lonRef) source = 'explicit';
  }

  /* 2. Name-alias fallback. */
  if (source !== 'explicit') {
    if (!latRef)  for (const a of LAT_ALIASES)  { const g = find1DArray(arrays, a, ny); if (g) { latRef  = g; break; } }
    if (!lonRef)  for (const a of LON_ALIASES)  { const g = find1DArray(arrays, a, nx); if (g) { lonRef  = g; break; } }
    if (!timeRef && ndim >= 3)
      for (const a of TIME_ALIASES) { const g = find1DArray(arrays, a, nt); if (g) { timeRef = g; break; } }
    if (latRef && lonRef) source = 'fallback';
  }

  if (!latRef || !lonRef) {
    warnings.push(
      'No coordinate arrays found for variable "' + arrayInfo.name +
      '" — using synthetic axes (lats[j]=j, lons[i]=i). ' +
      'extractGrid bbox is in index space, not degrees.'
    );
  }

  return { latRef, lonRef, timeRef, nt, ny, nx, source, warnings };
}
