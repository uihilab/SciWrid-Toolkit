/**
 * sciwrid-api.js — functional façade over the SciWrid Toolkit class.
 *
 * Exposes scan / extract / extractOutput as plain async functions so
 * consumers can:
 *
 *   import { scan, extract, extractOutput } from 'sciwrid-toolkit/api';
 *
 *   const meta = await scan('https://example.com/file.grb2');
 *   const arr  = await extract(file, { variable: 'TMP', lat: 40.7, lon: -74 });
 *   const csv  = await extractOutput(file, { variable: 'TMP' }, 'csv');
 *
 * Sources accepted: Uint8Array, ArrayBuffer, File/Blob, URL or string URL.
 * URLs are downloaded fully (no range requests in this sprint).
 *
 * Errors: typed subclasses of SciWridError so callers can `instanceof`-check.
 */

import { SciWridToolkit } from './sciwrid-lib.js';
import { toEpochMs, toEpochMsBound, resolveTimeIndex, resolveRangeIndices, axisFromMeta } from './time-select.js';
import { gridToJSON, gridToGeoTIFF } from './grid-output.js';
export { gridToJSON, gridToGeoTIFF } from './grid-output.js';
import { gridToImageData } from './render/to-imagedata.js';
export { gridToImageData } from './render/to-imagedata.js';
import { gridToPNG } from './render/to-png.js';
export { gridToPNG } from './render/to-png.js';
import { RAMPS, resolveRamp, sampleRamp } from './render/colorramps.js';
export { RAMPS, resolveRamp, sampleRamp } from './render/colorramps.js';

/* =========================================================================
 * Typed errors — defined in lib/errors.js (no further imports) so submodules
 * like lib/trim/* can extend SciWridError without a circular import
 * through this file.
 * ======================================================================= */
import {
  SciWridError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from './errors.js';
export {
  SciWridError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
};
export { UnsupportedCRSError } from './tiff/errors.js';

/* =========================================================================
 * Source resolution — download then parse (URL fully fetched into memory)
 * ======================================================================= */
async function resolveSource(source) {
  if (source instanceof Uint8Array)  return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof Blob !== 'undefined' && source instanceof Blob)
    return new Uint8Array(await source.arrayBuffer());

  const url = source instanceof URL ? source.href : source;
  if (typeof url !== 'string')
    throw new SourceError('Unsupported source type. Use Uint8Array, ArrayBuffer, File/Blob, URL, or string URL.');

  // string URL: works for http(s):// in browser & Node 18+, and file:// in Node
  let resp;
  try { resp = await fetch(url); }
  catch (e) { throw new SourceError(`Failed to fetch ${url}: ${e.message}`); }
  if (!resp.ok) throw new SourceError(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  return new Uint8Array(await resp.arrayBuffer());
}

/* =========================================================================
 * Internal: open a SciWrid Toolkit instance, run a callback, always close
 * ======================================================================= */
async function withInstance(source, opts, fn) {
  const lib = new SciWridToolkit({
    wasmFactory: opts?.wasmFactory,
    h5wasmUrl:   opts?.h5wasmUrl,
  });
  try {
    const data = await resolveSource(source);
    try { await lib.read(data); }
    catch (e) {
      if (/not yet supported/i.test(e.message) || /Cannot detect/i.test(e.message))
        throw new UnsupportedFormatError(e.message);
      throw new SciWridError(e.message);
    }
    return await fn(lib);
  } finally {
    try { lib.close(); } catch (_) {}
  }
}

/* =========================================================================
 * sniffMagicBytes — read just enough bytes to identify the format. For URLs
 * we use a Range request so detectFormat doesn't pull the whole file down.
 * Returns a Uint8Array of at least 8 bytes (or the entire source if smaller).
 * ======================================================================= */
const MAGIC_PROBE_BYTES = 16;
async function sniffMagicBytes(source) {
  if (source instanceof Uint8Array)  return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const ab = await source.slice(0, MAGIC_PROBE_BYTES).arrayBuffer();
    return new Uint8Array(ab);
  }
  const url = source instanceof URL ? source.href : source;
  if (typeof url !== 'string')
    throw new SourceError('Unsupported source type. Use Uint8Array, ArrayBuffer, File/Blob, URL, or string URL.');
  if (/^https?:\/\//i.test(url)) {
    // Tiny Range request for the magic bytes. Falls back to full-body if the
    // server doesn't honor Range (status 200 instead of 206).
    let resp;
    try { resp = await fetch(url, { headers: { Range: `bytes=0-${MAGIC_PROBE_BYTES - 1}` } }); }
    catch (e) { throw new SourceError(`Failed to fetch ${url}: ${e.message}`); }
    if (!resp.ok && resp.status !== 206)
      throw new SourceError(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    return buf.subarray(0, Math.min(buf.length, MAGIC_PROBE_BYTES));
  }
  return resolveSource(source);
}

/* =========================================================================
 * detectFormat — sniff magic bytes, no WASM init required
 * ======================================================================= */
export async function detectFormat(source) {
  const data = await sniffMagicBytes(source);
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x41 && data[2] === 0x52 && data[3] === 0x31) {
    const parquet = await import('./parquet-helper.js');
    if (await parquet.detectFormat(source)) return 'parquet';
  }
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x52 && data[2] === 0x49 && data[3] === 0x42)
    return 'grib2';
  if (data.length >= 4 && data[0] === 0x43 && data[1] === 0x44 && data[2] === 0x46 &&
      (data[3] === 0x01 || data[3] === 0x02))
    return 'netcdf3';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x48 && data[2] === 0x44 && data[3] === 0x46 &&
      data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A)
    return 'netcdf4';
  // ZIP / Zarr-zip: 'PK\x03\x04' (we tentatively call this 'zarr'; sciwrid-lib
  // confirms by parsing for .zarray entries and throws if the zip isn't Zarr).
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B && data[2] === 0x03 && data[3] === 0x04)
    return 'zarr';
  // TIFF: little-endian II*\0, big-endian MM\0*, or BigTIFF (II/MM + magic 43)
  if (data.length >= 4) {
    if (data[0] === 0x49 && data[1] === 0x49) {
      if (data[2] === 0x2A && data[3] === 0x00) return 'tiff';        // LE classic
      if (data[2] === 0x2B && data[3] === 0x00) return 'tiff';        // LE BigTIFF (43=0x2B)
    } else if (data[0] === 0x4D && data[1] === 0x4D) {
      if (data[2] === 0x00 && data[3] === 0x2A) return 'tiff';        // BE classic
      if (data[2] === 0x00 && data[3] === 0x2B) return 'tiff';        // BE BigTIFF
    }
  }
  return null;
}

/* =========================================================================
 * scan — return metadata + variable list
 * ======================================================================= */
/**
 * If every multi-dim variable shares an identical `times` array, hoist it
 * to the top level and strip the per-variable copies. Mixed/empty cases
 * leave per-variable times untouched.
 */
function hoistUniformTimes(variables) {
  const haveTimes = variables.filter(v => v.times && Array.isArray(v.times.values));
  if (haveTimes.length === 0) return null;
  const first = haveTimes[0].times;
  const allSame = haveTimes.every(v =>
    v.times.unitsRaw === first.unitsRaw &&
    v.times.calendar === first.calendar &&
    v.times.values.length === first.values.length &&
    v.times.values.every((s, i) => s === first.values[i])
  );
  if (!allSame) return null;
  for (const v of haveTimes) delete v.times;
  return first;
}

/**
 * Annotate scan metadata with time-range convenience fields:
 *  - each time axis (file-level `meta.times` and per-variable `v.times`) gets
 *    `start` (first timestamp) and `end` (last).
 *  - `meta.timeRange = { start, end }` spans the whole file — earliest start
 *    and latest end across every time axis. Absent when the file has no time
 *    axis at all.
 * ISO-8601 strings sort chronologically, so min/max is a lexical compare.
 */
function annotateTimeRange(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const addSE = (t) => {
    if (t && Array.isArray(t.values) && t.values.length) {
      t.start = t.values[0];
      t.end   = t.values[t.values.length - 1];
    }
  };
  addSE(meta.times);
  if (Array.isArray(meta.variables)) for (const v of meta.variables) addSE(v.times);

  let start = null, end = null;
  const collect = (t) => {
    if (t && t.start) {
      if (start === null || t.start < start) start = t.start;
      if (end   === null || t.end   > end)   end   = t.end;
    }
  };
  collect(meta.times);
  if (Array.isArray(meta.variables)) for (const v of meta.variables) collect(v.times);
  if (start !== null) meta.timeRange = { start, end };
  return meta;
}

export async function scan(source, opts = {}) {
  const fmt = await detectFormat(source);
  if (fmt === 'parquet') {
    const parquet = await import('./parquet-helper.js');
    const scanResult = await parquet.scan(source, opts);
    try {
      const variables = JSON.parse(parquet.scanGetVarsJson(scanResult));
      const meta = { format: 'parquet', total_variables: variables.length, supported_variables: variables.length, variable_names: variables.map(v => v.name), variables, bbox: parquet.geoBbox(scanResult) };
      if (scanResult.timesInfo) meta.times = scanResult.timesInfo;
      return annotateTimeRange(meta);
    } finally { await parquet.scanFree(scanResult); }
  }
  if (fmt === 'tiff') {
    const { scan: tiffScan } = await import('./tiff-helper.js');
    return annotateTimeRange(await tiffScan(source));
  }
  return withInstance(source, opts, (lib) => {
    const variables = lib.getvariables().map(v => {
      // strip private fields (leading underscore) from netcdf4 entries
      const out = {};
      for (const k of Object.keys(v)) if (!k.startsWith('_')) out[k] = v[k];
      return out;
    });
    const meta = { ...lib.metadata(), variables };
    const uniformTimes = hoistUniformTimes(variables);
    if (uniformTimes) meta.times = uniformTimes;
    return annotateTimeRange(meta);
  });
}

/* =========================================================================
 * resolveDateOptions — turn `date` / `dateRange` into integer indices.
 *
 * Mutates a shallow copy of options and returns it. `kind` is 'range' (sets
 * t1/t2 for extract) or 'single' (sets time for extractGrid). Runs one scan()
 * to obtain the variable's time axis; nearest-match against it.
 * ======================================================================= */
async function resolveDateOptions(source, options, kind) {
  const hasDate  = options.date !== undefined;
  const hasRange = options.dateRange !== undefined;
  if (!hasDate && !hasRange) return options;

  const hasIdx = kind === 'range'
    ? (options.t1 !== undefined || options.t2 !== undefined)
    : (options.time !== undefined);
  if (hasDate && hasRange)
    throw new SciWridError('Use either `date` or `dateRange`, not both.');
  if ((hasDate || hasRange) && hasIdx)
    throw new SciWridError('Use either date options or integer time indices, not both.');
  if (hasRange && kind === 'single')
    throw new SciWridError('extractGrid takes a single `date`, not `dateRange`.');

  const variable = Array.isArray(options.variable) ? options.variable[0] : options.variable;
  const meta = await scan(source, options);
  const axis = axisFromMeta(meta, variable);

  const out = { ...options };
  delete out.date; delete out.dateRange;

  if (axis.kind === 'none') {
    // Single-timestep / no time axis: any date maps to index 0.
    if (kind === 'range') { out.t1 = 0; out.t2 = 0; } else { out.time = 0; }
    return out;
  }

  if (kind === 'single') {
    out.time = resolveTimeIndex(axis.ms, toEpochMs(options.date));
    return out;
  }
  // range
  if (hasDate) {
    const i = resolveTimeIndex(axis.ms, toEpochMs(options.date));
    out.t1 = i; out.t2 = i;
  } else {
    // dateRange: date-only bounds expand to whole-day [00:00:00, 23:59:59.999]
    // and we keep every timestep within the window.
    const [start, end] = options.dateRange;
    const { t1, t2 } = resolveRangeIndices(
      axis.ms, toEpochMsBound(start, 'start'), toEpochMsBound(end, 'end'));
    out.t1 = t1; out.t2 = t2;
  }
  return out;
}

/* =========================================================================
 * extract — decode one or more variables, return raw structured result
 *
 *   extract(source, { variable: 'TMP', lat: 40.7, lon: -74 })
 *   extract(source, { variable: ['TMP', 'UGRD'], t1: 0, t2: 5 })
 * ======================================================================= */
/* Range-native fast path for NetCDF4/HDF5 point queries over a URL: pulls only
 * the target variable's chunk(s) instead of the whole file. Returns null (so the
 * caller falls back to the whole-file path) for anything it does not handle:
 * non-URL sources, non-NetCDF4, multi-variable / bbox / time-subset queries, or
 * any unsupported HDF5 layout. Never throws. */
async function tryHdf5RangePoint(source, options, diag) {
  /* `attempted` separates DECLINING from FAILING. Returning null because the
   * query is a bbox, or the file is not NetCDF4, is the fast path declining by
   * design and must stay silent. Only a failure after the preconditions passed
   * is worth reporting -- otherwise the diagnostic is noise nobody reads. */
  let attempted = false;
  try {
    const url = source instanceof URL ? source.href : source;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    if (options.variable == null || options.lat == null || options.lon == null) return null;
    if (options.bbox || options.width || options.height) return null;
    if (options.date != null || options.dateRange != null ||
        options.t1 != null || options.t2 != null) return null;   // time subset -> whole-file
    if (await detectFormat(source) !== 'netcdf4') return null;
    attempted = true;
    const { hdf5RangePointExtract } = await import('./hdf5/hdf5-range.js');
    const before = diag.length;
    const out = await hdf5RangePointExtract(url,
      { variable: options.variable, lat: options.lat, lon: options.lon },
      { fetchImpl: options.fetchImpl, diag, forceRange: options.forceRange === true });
    if (!out && diag.length === before)
      diag.push({ path: 'hdf5-range', reason: 'range extractor returned no result' });
    return out;
  } catch (e) {
    if (attempted) diag.push({ path: 'hdf5-range', reason: String((e && e.message) || e) });
    return null;
  }
}

/* Resolve a Node local-filesystem path to a GRIB2 file (bare path or file://),
 * checking the magic bytes via fs so we never slurp the whole file. Returns the
 * path or null (browser, non-file, or non-GRIB2). */
async function resolveLocalGribPath(source) {
  try {
    if (typeof process === 'undefined' || !(process.versions && process.versions.node)) return null;
    const s = source instanceof URL ? source.href : source;
    if (typeof s !== 'string' || /^https?:\/\//i.test(s)) return null;
    const fs = await import('node:fs');
    let path = s;
    if (/^file:\/\//i.test(s)) { const { fileURLToPath } = await import('node:url'); path = fileURLToPath(s); }
    if (!fs.existsSync(path) || !fs.statSync(path).isFile()) return null;
    const fd = fs.openSync(path, 'r');
    const b = Buffer.allocUnsafe(8);
    fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd);
    if (!(b[0] === 0x47 && b[1] === 0x52 && b[2] === 0x49 && b[3] === 0x42) || b[7] !== 2) return null; // "GRIB" ed2
    return path;
  } catch (_) { return null; }
}

async function tryGrib2RangePoint(source, options, diag) {
  let attempted = false;
  try {
    if (options.variable == null || options.lat == null || options.lon == null) return null;
    if (options.bbox || options.width || options.height) return null;   // grid -> whole-file
    const query = {
      variable: options.variable, lat: options.lat, lon: options.lon,
      t1: options.t1, t2: options.t2,
    };
    const url = source instanceof URL ? source.href : source;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      if (await detectFormat(source) !== 'grib2') return null;
      attempted = true;
      const { grib2RangePointExtract } = await import('./grib2/grib2-range.js');
      const before = diag.length;
      const out = await grib2RangePointExtract(url, query, { fetchImpl: options.fetchImpl, diag });
      /* Only fill in the generic reason when the extractor supplied none --
       * otherwise the placeholder overwrites the real cause. */
      if (!out && diag.length === before)
        diag.push({ path: 'grib2-range', reason: 'range extractor returned no result' });
      return out;
    }
    const localPath = await resolveLocalGribPath(source);           // Node local file
    if (localPath) {
      attempted = true;
      const { grib2RangePointExtractFile } = await import('./grib2/grib2-range.js');
      const before = diag.length;
      const out = await grib2RangePointExtractFile(localPath, query, { diag });
      if (!out && diag.length === before)
        diag.push({ path: 'grib2-range', reason: 'range extractor returned no result' });
      return out;
    }
    return null;
  } catch (e) {
    if (attempted) diag.push({ path: 'grib2-range', reason: String((e && e.message) || e) });
    return null;
  }
}

/* options.forceRange (boolean, internal): bypass the range path's profitability
 * gate. The gate refuses to run when the range path would move at least as many
 * bytes as the whole file, which is correct for callers and useless for tests
 * that need to exercise the range path on exactly such a file. Not part of the
 * documented public API; see .testkit/test-range-parity.js. */
export async function extract(source, options = {}) {
  /* A range fast path that fails must not vanish. It falls back — that is
   * correct — but the caller gets told, because a correct answer is not
   * evidence that the cheap path ran. Measured 2026-07-30: a GOES-18 point
   * query returned the right value after fetching 148.6% of the file. */
  const diag = [];
  const fast = await tryHdf5RangePoint(source, options, diag);
  if (fast) return fast;
  const fastGrib = await tryGrib2RangePoint(source, options, diag);
  if (fastGrib) return fastGrib;
  options = await resolveDateOptions(source, options, 'range');
  const fmt = await detectFormat(source);

  const tag = (out) => {
    if (diag.length && out && typeof out === 'object') out._fastPathSkipped = diag;
    return out;
  };

  if (fmt === 'parquet') {
    const { extract: parquetExtract } = await import('./parquet-helper.js');
    return tag(await parquetExtract(source, options));
  }
  if (fmt === 'tiff') {
    const { extract: tiffExtract } = await import('./tiff-helper.js');
    return tag(await tiffExtract(source, options));
  }
  return tag(await withInstance(source, options, async (lib) => {
    try {
      // delegate to the class — it returns plain JS objects already
      return await lib.extract({ ...options, type: 'json' });
    } catch (e) {
      if (/not found/i.test(e.message) || /not supported/i.test(e.message))
        throw new VariableNotFoundError(e.message);
      throw new ExtractError(e.message);
    }
  }));
}

/* =========================================================================
 * extractOutput — same as extract, but serialised
 *
 *   const json = await extractOutput(src, opts, 'json');   // string
 *   const csv  = await extractOutput(src, opts, 'csv');    // string
 *
 * Writes nothing to disk — caller decides what to do with the string.
 * ======================================================================= */
export async function extractOutput(source, options = {}, format = 'json') {
  const fmt = String(format).toLowerCase();
  if (fmt !== 'json' && fmt !== 'csv')
    throw new SciWridError(`Unsupported output format '${format}'. Use 'json' or 'csv'.`);

  options = await resolveDateOptions(source, options, 'range');
  return withInstance(source, options, async (lib) => {
    let result;
    try {
      result = await lib.extract({ ...options, type: fmt === 'csv' ? 'csv' : 'json' });
    } catch (e) {
      if (/not found/i.test(e.message) || /not supported/i.test(e.message))
        throw new VariableNotFoundError(e.message);
      throw new ExtractError(e.message);
    }
    return fmt === 'csv' ? result : JSON.stringify(result, null, 2);
  });
}

/* =========================================================================
 * extractGrid — parallel bbox grid export
 *
 *   const result = await extractGrid(source, {
 *     variable: 'TMP',
 *     bbox:    [minLon, minLat, maxLon, maxLat],
 *     width:   256, height: 256,
 *     time:    0,           // optional, default 0
 *     workers: 5,           // optional, default 5; 0 forces inline
 *     signal:  abortCtrl.signal,    // optional
 *     onProgress: ({done,total}) => {},
 *   });
 *
 * Returns { data: Float32Array(W*H), width, height, bbox, variable, units, time }
 * where row 0 is at maxLat (north-up) and cells are row-major.
 * ======================================================================= */
/* Range-native fast path for NetCDF4/HDF5 window (bbox) grids over a URL: fetches
 * only the selected timestep's spatial chunks and resamples with the same code as
 * the whole-file path. Returns null (fall back) for non-URL, non-NetCDF4, missing
 * bbox/size, or date-based time selection (handled by the whole-file path). */
async function tryHdf5RangeGrid(source, options, diag) {
  /* Same declining-vs-failing distinction as the point helpers: a non-URL or
   * non-NetCDF4 source is the fast path declining by design and stays silent;
   * a failure after the preconditions passed is reported. */
  let attempted = false;
  try {
    const url = source instanceof URL ? source.href : source;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    if (!options.variable || !Array.isArray(options.bbox) || options.bbox.length !== 4) return null;
    if (!Number.isInteger(options.width) || !Number.isInteger(options.height)) return null;
    if (options.date != null || options.dateRange != null) return null;   // time index only
    if (await detectFormat(source) !== 'netcdf4') return null;
    attempted = true;
    const { hdf5RangeGridExtract } = await import('./hdf5/hdf5-range.js');
    const before = diag.length;
    const out = await hdf5RangeGridExtract(url, {
      variable: options.variable, bbox: options.bbox,
      width: options.width, height: options.height, time: options.time || 0,
    }, { fetchImpl: options.fetchImpl, diag, forceRange: options.forceRange === true });
    if (!out && diag.length === before)
      diag.push({ path: 'hdf5-range-grid', reason: 'range extractor returned no result' });
    return out;
  } catch (e) {
    if (attempted) diag.push({ path: 'hdf5-range-grid', reason: String((e && e.message) || e) });
    return null;
  }
}

export async function extractGrid(source, options = {}) {
  const diag = [];
  const fastGrid = await tryHdf5RangeGrid(source, options, diag);
  if (fastGrid) return fastGrid;
  const tagGrid = (out) => {
    if (diag.length && out && typeof out === 'object') out._fastPathSkipped = diag;
    return out;
  };
  options = await resolveDateOptions(source, options, 'single');
  const fmt = await detectFormat(source);
  if (fmt === 'parquet') {
    const { extractGrid: parquetExtractGrid } = await import('./parquet-helper.js');
    return tagGrid(await parquetExtractGrid(source, options));
  }
  if (fmt === 'tiff') {
    const { extractGrid: tiffExtractGrid } = await import('./tiff-helper.js');
    return tagGrid(await tiffExtractGrid(source, options));
  }
  return tagGrid(await withInstance(source, options, async (lib) => {
    try {
      return await lib.extractGrid(options);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e instanceof SciWridError)) throw e;
      if (/not found/i.test(e.message))      throw new VariableNotFoundError(e.message);
      if (/not supported/i.test(e.message))  throw new VariableNotFoundError(e.message);
      const wrapped = new ExtractError(e.message);
      wrapped.cause = e;
      wrapped.stack = e.stack;
      throw wrapped;
    }
  }));
}

/* =========================================================================
 * extractGridOutput — same as extractGrid, but serialised
 *
 *   const json = await extractGridOutput(src, opts, 'json');     // string
 *   const tiff = await extractGridOutput(src, opts, 'geotiff');  // Uint8Array
 *
 * Other projects can save the result anywhere (fs, fetch, Blob, etc).
 * For just the in-memory grid use extractGrid() — this wrapper exists for
 * one-shot "give me a file-ready blob" callers.
 * ======================================================================= */
export async function extractGridOutput(source, options = {}, format = 'json') {
  const fmt = String(format).toLowerCase();
  if (!['json', 'geotiff', 'tif', 'tiff', 'imagedata', 'png'].includes(fmt))
    throw new SciWridError(`Unsupported grid output format '${format}'. Use 'json', 'geotiff', 'imagedata', or 'png'.`);

  const grid = await extractGrid(source, options);
  if (fmt === 'json')      return gridToJSON(grid, { pretty: options.pretty });
  if (fmt === 'imagedata') return gridToImageData(grid, options);
  if (fmt === 'png')       return await gridToPNG(grid, options);
  /* geotiff / tif / tiff */            return gridToGeoTIFF(grid, options);
}

/* =========================================================================
 * trim — produce a smaller file in the same format with only the selected
 * variables (and optional time range). See lib/trim/* for per-format logic.
 * ======================================================================= */
export { trim, TrimError } from './trim/index.js';

/* =========================================================================
 * Default export — bundle everything for `import api from 'sciwrid-toolkit/api'`
 * ======================================================================= */
import { trim, TrimError } from './trim/index.js';
import { UnsupportedCRSError } from './tiff/errors.js';
export default {
  detectFormat, scan, extract, extractOutput, extractGrid, extractGridOutput,
  gridToJSON, gridToGeoTIFF, gridToImageData, gridToPNG,
  RAMPS, resolveRamp, sampleRamp, trim,
  SciWridError, UnsupportedFormatError, VariableNotFoundError, SourceError, ExtractError,
  TrimError, UnsupportedCRSError,
};

