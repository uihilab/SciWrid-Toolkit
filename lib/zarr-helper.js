/*
 * zarr-helper.js  --  Browser-side Zarr v2 + v3 reader for webparsers
 *
 * Public entry — internal logic lives in lib/zarr/* now.
 *
 * Pipeline mirrors GRIB2 / NetCDF3 / NetCDF4:
 *
 *   scan(uint8array)
 *     → list every Zarr array in a ZIP-of-zarr, with shape/dtype/chunks
 *
 *   scanGetVarsJson(scanResult)
 *     → JSON string in the same shape wp_scan_get_vars_json emits
 *
 *   normalize(scanResult, varIndex, wasm)
 *     → refs_dataset_t* pointer (use with wp_query, wp_nt, wp_close, …)
 *
 *   scanFree(scanResult)
 *
 * Why pure JS?
 *   Zarr is multi-file by design and almost always uses third-party
 *   compressors (zstd, blosc, gzip). Browsers ship DecompressionStream
 *   for gzip / deflate-raw, and we lazy-load `numcodecs` from jsdelivr
 *   for blosc / zstd / lz4 — no WASM bundling required here. The C
 *   engine receives a flat Float32 array via wp_open_from_float_arrays
 *   once everything's decoded.
 *
 * Supported v2 features
 *   - dtypes: <f4 <f8 <i1 <i2 <i4 <u1 <u2 <u4 |i1 |u1
 *   - compressors: null, gzip, zlib (built-in via DecompressionStream);
 *                  blosc, zstd, lz4 (lazy via numcodecs)
 *   - byte order: little-endian only (real-world default)
 *   - dimension_separator: '.' and '/'
 *   - fill_value: number, "NaN", "Infinity", "-Infinity"
 *
 * Supported v3 features
 *   - zarr.json metadata translated into the internal v2-like shape
 *   - codec pipeline: bytes, zstd, gzip, blosc, lz4, crc32c stripping
 *   - default c/... chunk keys and v2-style chunk-key encoding
 *   - sharding_indexed, big-endian numeric dtypes, float16, dimension_names
 *
 * Not yet:
 *   - filters (fixedscaleoffset, delta, …) — throws a clear error
 *   - directory stores, crc32c verification, complex dtypes
 */

import { findEOCD, readZip }       from './zarr/zip.js';
import { resolveCoordRefs }        from './zarr/metadata.js';
import { indexArrays }             from './zarr/metadata.js';
import { indexArraysV3 }           from './zarr/v3-metadata.js';
import { readArrayAsFloat32, readArrayAsFloat64, readArrayWindowed } from './zarr/chunk-grid.js';
import { decodeTimes }             from './time-decoder.js';

/* ====================================================================== */
/* detectFormat — quick magic check                                        */
/* ====================================================================== */

/**
 * Quick magic check (best-effort): a Zarr ZIP must contain at least one
 * `.zarray` or `.zgroup` entry.  This is heuristic — we only confirm by
 * actually parsing.
 */
function detectFormat(buf) {
  try {
    findEOCD(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    return 'zarr-zip';   /* could be zarr; scan() will confirm */
  } catch (_) {
    return null;
  }
}

/* ====================================================================== */
/* ChunkSource — abstracts where chunk bytes come from.                    */
/*                                                                         */
/* Today: ZipChunkSource (in-memory zip-of-zarr, browser + Node).          */
/* Tomorrow: KerchunkRefStore (kerchunk-parquet refs → local fs), defined  */
/* in lib/kerchunk/ref-store.js and consumed by the same pipeline below.   */
/*                                                                         */
/* Contract (informal — JS, no enforced interface):                        */
/*   listArrays():                  ArrayInfo[]                            */
/*   getChunkBytes(name, chunkKey): Promise<Uint8Array | null>             */
/*   close():                       Promise<void>  (optional)              */
/*                                                                         */
/* Returned bytes are the raw, still-compressed chunk payload. null means  */
/* the chunk is omitted (treat as fill_value).                             */
/* ====================================================================== */

class ZipChunkSource {
  constructor(entries, arrays) {
    this._entries = entries;
    this._arrays  = arrays;
  }
  listArrays() { return this._arrays; }
  async getChunkBytes(arrayName, chunkKey) {
    const a = this._arrays.find(x => x.name === arrayName);
    if (!a) throw new Error('ZipChunkSource: unknown array "' + arrayName + '"');
    const path = a.root + chunkKey;
    const buf  = this._entries[path];
    return buf || null;
  }
}

/**
 * scan(uint8array) — unzip + index every Zarr v2 array inside.
 * Returns an opaque scanResult object you pass to scanGetVarsJson /
 * normalize / scanFree.
 */
async function scan(buf) {
  const entries = await readZip(buf);
  let arrays = indexArrays(entries);
  if (arrays.length === 0) arrays = indexArraysV3(entries);
  if (arrays.length === 0)
    throw new Error('No Zarr arrays found (no .zarray or zarr.json array nodes in archive)');

  /* Sanity check zarr_format on each */
  for (const a of arrays) {
    const zf = a.meta.zarr_format;
    if (zf !== 2 && zf !== 3)
      throw new Error('Array "' + a.name + '" is zarr_format ' +
        zf + ' (only v2/v3 supported)');
  }

  const source = new ZipChunkSource(entries, arrays);
  /* Keep `entries` on the result for backward compat with any callers
   * that still read raw zip entries. New code paths use `source`. */
  const scanResult = { entries, source, arrays };

  /* Decode CF times per multi-dim variable. Cached on the scanResult so
   * scanGetVarsJson can stay synchronous. Failures are recorded as warnings
   * — the rest of the scan must still succeed. */
  scanResult._timesByVar = new Map();   // arrayName → { values, unitsRaw, calendar }
  scanResult._timesWarnings = new Map();// arrayName → [warning strings]
  for (const a of arrays) {
    const shape = (a.meta && a.meta.shape) || [];
    if (shape.length < 3) continue;   // No time axis to decode
    const refs = resolveCoordRefs(scanResult, a);
    if (!refs.timeRef || !refs.timeRef.attrs || !refs.timeRef.attrs.units) continue;
    try {
      const raw = await readArrayAsFloat64(scanResult, refs.timeRef);
      const decoded = decodeTimes(
        raw,
        refs.timeRef.attrs.units,
        refs.timeRef.attrs.calendar || 'standard',
      );
      scanResult._timesByVar.set(a.name, decoded);
    } catch (e) {
      const msg = `Could not decode times for "${a.name}": ${e.message}. ` +
                  `Raw values still available via extract({time: n}).`;
      const list = scanResult._timesWarnings.get(a.name) || [];
      list.push(msg);
      scanResult._timesWarnings.set(a.name, list);
    }
  }

  return scanResult;
}

/**
 * Emit the same JSON shape as wp_scan_get_vars_json so callers can render
 * the variables table without special-casing zarr.
 */
function scanGetVarsJson(scanResult) {
  const out = scanResult.arrays.map((a, i) => {
    const shape  = a.meta.shape  || [];
    const chunks = a.meta.chunks || [];
    /* Pretend the last two dims are (ny, nx) to match the existing UI; if
     * the array has fewer dims, fall back to (length, 1). */
    const ny = shape.length >= 2 ? shape[shape.length - 2] : (shape[0] ?? 0);
    const nx = shape.length >= 1 ? shape[shape.length - 1] : 1;
    const messages = shape.length >= 3 ? shape[0] : 1;  /* outermost dim */

    /* Coord resolution only makes sense for multi-dim data vars; 1-D coord
     * arrays themselves get coord_source='n/a'. */
    let coord_source = 'n/a';
    let warnings = [];
    if (shape.length >= 2) {
      const refs = resolveCoordRefs(scanResult, a);
      coord_source = refs.source;
      warnings = refs.warnings;
    }

    const times = scanResult._timesByVar ? scanResult._timesByVar.get(a.name) || null : null;
    const timeWarnings = scanResult._timesWarnings ? scanResult._timesWarnings.get(a.name) || [] : [];

    return {
      index:    i,
      name:     a.name,
      cat:      0,
      num:      0,
      grid_template: 0,
      data_template: 0,
      nx, ny,
      messages,
      shape,
      chunks,
      dtype:        a.meta.dtype,
      compressor:   a.meta.compressor ? a.meta.compressor.id : null,
      attrs:        a.attrs,
      supported:    true,
      coord_source,
      times,
      warnings:     [...warnings, ...timeWarnings],
    };
  });
  return JSON.stringify(out);
}

/* ====================================================================== */
/* normalize — hand a refs_dataset_t back to the C query engine.           */
/* Mirrors how _normalizeNetCDF4 in webparsers-lib.js works.               */
/* ====================================================================== */

/**
 * Build a refs_dataset_t* from a Zarr array, ready for wp_query / wp_nt /
 * wp_find_nearest_lat / wp_close.
 *
 *   scanResult: result of scan()
 *   varIndex:   index into scanResult.arrays
 *   wasm:       the loaded WebParsers WASM module
 *
 * Coord strategy: try real lat/lon/time arrays from the store first
 * (xarray's `_ARRAY_DIMENSIONS` or name aliases like 'latitude'/'lat').
 * Fall back to synthetic indices when the store has no coordinate arrays.
 * See resolveCoordRefs() for the full resolution order.
 */
async function normalize(scanResult, varIndex, wasm, opts = {}) {
  const a = scanResult.arrays[varIndex];
  if (!a) throw new Error('varIndex out of range');

  const shape = a.meta.shape;
  const ndim  = shape.length;

  let nt, ny, nx;
  if (ndim === 1)      { nt = 1;          ny = 1;          nx = shape[0]; }
  else if (ndim === 2) { nt = 1;          ny = shape[0];   nx = shape[1]; }
  else if (ndim === 3) { nt = shape[0];   ny = shape[1];   nx = shape[2]; }
  else                 { nt = shape[0];   ny = shape[ndim-2]; nx = shape[ndim-1]; }

  let data, winStart = 0;
  const tr = opts.timeIndexRange;
  if (tr && ndim >= 3) {
    const chunks0 = a.meta.chunks[0];
    const i0 = Math.max(0, tr[0] | 0);
    const i1 = Math.min(shape[0] - 1, tr[1] | 0);
    if (i1 < i0)
      throw new Error('normalize: empty timeIndexRange [' + tr[0] + ',' + tr[1] + ']');
    const c0 = Math.floor(i0 / chunks0);
    const c1 = Math.floor(i1 / chunks0);
    const win = await readArrayWindowed(scanResult, a, c0, c1);
    data = win.data;
    nt = win.winLen;
    winStart = win.winStart;
  } else {
    data = await readArrayAsFloat32(scanResult, a);
  }

  const refs = ndim >= 2 ? resolveCoordRefs(scanResult, a) : null;

  let lats, lons, times_s;

  /* Read a coordinate array, but never let one unsupported coordinate dtype
   * (e.g. a <U3 string axis) sink the whole query - fall back to a synthetic
   * index axis and warn. The DATA variable read above is intentionally NOT
   * wrapped: a bad data dtype must still surface a clear error. */
  async function readCoordOrIndex(ref, len, axisLabel) {
    if (!ref) {
      const a = new Float32Array(len);
      for (let i = 0; i < len; i++) a[i] = i;
      return a;
    }
    try {
      return await readArrayAsFloat32(scanResult, ref);
    } catch (e) {
      const a = new Float32Array(len);
      for (let i = 0; i < len; i++) a[i] = i;
      const msg = `Zarr: ${axisLabel} axis "${ref.name}" dtype ` +
        `${ref.meta && ref.meta.dtype} unsupported (${e.message}); ` +
        `using synthetic index axis.`;
      (scanResult._coordWarnings || (scanResult._coordWarnings = [])).push(msg);
      return a;
    }
  }

  lats = await readCoordOrIndex(refs && refs.latRef, ny, 'lat');
  lons = await readCoordOrIndex(refs && refs.lonRef, nx, 'lon');

  /* readArrayAsFloat32 widens to Float32; widen again to Float64 for the
   * times buffer the C engine expects. Precision loss matters for real
   * unix-epoch seconds (>2^24); the C path treats values as raw seconds.
   * For now we accept this; a Float64-preserving reader is a follow-up. */
  times_s = new Float64Array(nt);
  if (refs && refs.timeRef) {
    const rawFull = await readCoordOrIndex(refs.timeRef, shape[0], 'time');
    for (let t = 0; t < nt; t++) times_s[t] = rawFull[winStart + t];
  } else {
    for (let t = 0; t < nt; t++) times_s[t] = (winStart + t) * 86400;
  }

  /* Hand all four buffers + the float data to wp_open_from_float_arrays.
   * That C function copies them, so we can let GC reclaim the JS originals. */
  const nameLenU8 = wasm.lengthBytesUTF8(a.name) + 1;
  const namePtr   = wasm.ccall('wp_malloc', 'number', ['number'], [nameLenU8]);
  wasm.stringToUTF8(a.name, namePtr, nameLenU8);

  const latsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [ny * 4]);
  const lonsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [nx * 4]);
  const tsPtr   = wasm.ccall('wp_malloc', 'number', ['number'], [nt * 8]);
  const dataPtr = wasm.ccall('wp_malloc', 'number', ['number'], [data.byteLength]);

  wasm.HEAPF32.set(lats, latsPtr / 4);
  wasm.HEAPF32.set(lons, lonsPtr / 4);
  wasm.HEAPF64.set(times_s, tsPtr / 8);
  wasm.HEAPF32.set(data, dataPtr / 4);

  const ds = wasm.ccall('wp_open_from_float_arrays', 'number',
    ['number','number','number','number','number','number','number','number'],
    [namePtr, nx, ny, nt, latsPtr, lonsPtr, tsPtr, dataPtr]);

  /* wp_open_from_float_arrays copies the buffers internally — free ours. */
  wasm.ccall('wp_free', null, ['number'], [namePtr]);
  wasm.ccall('wp_free', null, ['number'], [latsPtr]);
  wasm.ccall('wp_free', null, ['number'], [lonsPtr]);
  wasm.ccall('wp_free', null, ['number'], [tsPtr]);
  wasm.ccall('wp_free', null, ['number'], [dataPtr]);

  return ds;
}

/** Free anything held by scan() — close any ChunkSource and drop refs. */
async function scanFree(scanResult) {
  if (!scanResult) return;
  if (scanResult.source && typeof scanResult.source.close === 'function') {
    await scanResult.source.close();
  }
  scanResult.entries = null;
  scanResult.source  = null;
  scanResult.arrays  = null;
}

/* ====================================================================== */
/* Exports                                                                 */
/* ====================================================================== */

export {
  detectFormat,
  scan,
  scanGetVarsJson,
  normalize,
  scanFree,
  ZipChunkSource,
  /* Lower-level helper, exposed for tests */
  readArrayAsFloat32 as _readArrayAsFloat32,
};

export default {
  detectFormat, scan, scanGetVarsJson, normalize, scanFree, ZipChunkSource,
  _readArrayAsFloat32: readArrayAsFloat32,
};
