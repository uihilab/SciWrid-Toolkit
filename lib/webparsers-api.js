/**
 * webparsers-api.js — functional façade over the webparsers class.
 *
 * Exposes scan / extract / extractOutput as plain async functions so
 * consumers can:
 *
 *   import { scan, extract, extractOutput } from 'webparsers/api';
 *
 *   const meta = await scan('https://example.com/file.grb2');
 *   const arr  = await extract(file, { variable: 'TMP', lat: 40.7, lon: -74 });
 *   const csv  = await extractOutput(file, { variable: 'TMP' }, 'csv');
 *
 * Sources accepted: Uint8Array, ArrayBuffer, File/Blob, URL or string URL.
 * URLs are downloaded fully (no range requests in this sprint).
 *
 * Errors: typed subclasses of WebparsersError so callers can `instanceof`-check.
 */

import { webparsers } from './webparsers-lib.js';
import { toEpochMs, resolveTimeIndex, axisFromMeta } from './time-select.js';
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
 * like lib/slim/* can extend WebparsersError without a circular import
 * through this file.
 * ======================================================================= */
import {
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from './errors.js';
export {
  WebparsersError,
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
 * Internal: open a webparsers instance, run a callback, always close
 * ======================================================================= */
async function withInstance(source, opts, fn) {
  const lib = new webparsers({
    wasmFactory: opts?.wasmFactory,
    h5wasmUrl:   opts?.h5wasmUrl,
  });
  try {
    const data = await resolveSource(source);
    try { await lib.read(data); }
    catch (e) {
      if (/not yet supported/i.test(e.message) || /Cannot detect/i.test(e.message))
        throw new UnsupportedFormatError(e.message);
      throw new WebparsersError(e.message);
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
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x52 && data[2] === 0x49 && data[3] === 0x42)
    return 'grib2';
  if (data.length >= 4 && data[0] === 0x43 && data[1] === 0x44 && data[2] === 0x46 &&
      (data[3] === 0x01 || data[3] === 0x02))
    return 'netcdf3';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x48 && data[2] === 0x44 && data[3] === 0x46 &&
      data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A)
    return 'netcdf4';
  // ZIP / Zarr-zip: 'PK\x03\x04' (we tentatively call this 'zarr'; webparsers-lib
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

export async function scan(source, opts = {}) {
  if (await detectFormat(source) === 'tiff') {
    const { scan: tiffScan } = await import('./tiff-helper.js');
    return tiffScan(source);
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
    return meta;
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
    throw new WebparsersError('Use either `date` or `dateRange`, not both.');
  if ((hasDate || hasRange) && hasIdx)
    throw new WebparsersError('Use either date options or integer time indices, not both.');
  if (hasRange && kind === 'single')
    throw new WebparsersError('extractGrid takes a single `date`, not `dateRange`.');

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
    const [start, end] = options.dateRange;
    let a = resolveTimeIndex(axis.ms, toEpochMs(start));
    let b = resolveTimeIndex(axis.ms, toEpochMs(end));
    if (a > b) { const tmp = a; a = b; b = tmp; }
    out.t1 = a; out.t2 = b;
  }
  return out;
}

/* =========================================================================
 * extract — decode one or more variables, return raw structured result
 *
 *   extract(source, { variable: 'TMP', lat: 40.7, lon: -74 })
 *   extract(source, { variable: ['TMP', 'UGRD'], t1: 0, t2: 5 })
 * ======================================================================= */
export async function extract(source, options = {}) {
  options = await resolveDateOptions(source, options, 'range');
  if (await detectFormat(source) === 'tiff') {
    const { extract: tiffExtract } = await import('./tiff-helper.js');
    return tiffExtract(source, options);
  }
  return withInstance(source, options, async (lib) => {
    try {
      // delegate to the class — it returns plain JS objects already
      return await lib.extract({ ...options, type: 'json' });
    } catch (e) {
      if (/not found/i.test(e.message) || /not supported/i.test(e.message))
        throw new VariableNotFoundError(e.message);
      throw new ExtractError(e.message);
    }
  });
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
    throw new WebparsersError(`Unsupported output format '${format}'. Use 'json' or 'csv'.`);

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
export async function extractGrid(source, options = {}) {
  options = await resolveDateOptions(source, options, 'single');
  if (await detectFormat(source) === 'tiff') {
    const { extractGrid: tiffExtractGrid } = await import('./tiff-helper.js');
    return tiffExtractGrid(source, options);
  }
  return withInstance(source, options, async (lib) => {
    try {
      return await lib.extractGrid(options);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e instanceof WebparsersError)) throw e;
      if (/not found/i.test(e.message))      throw new VariableNotFoundError(e.message);
      if (/not supported/i.test(e.message))  throw new VariableNotFoundError(e.message);
      const wrapped = new ExtractError(e.message);
      wrapped.cause = e;
      wrapped.stack = e.stack;
      throw wrapped;
    }
  });
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
    throw new WebparsersError(`Unsupported grid output format '${format}'. Use 'json', 'geotiff', 'imagedata', or 'png'.`);

  const grid = await extractGrid(source, options);
  if (fmt === 'json')      return gridToJSON(grid, { pretty: options.pretty });
  if (fmt === 'imagedata') return gridToImageData(grid, options);
  if (fmt === 'png')       return await gridToPNG(grid, options);
  /* geotiff / tif / tiff */            return gridToGeoTIFF(grid, options);
}

/* =========================================================================
 * slim — produce a smaller file in the same format with only the selected
 * variables (and optional time range). See lib/slim/* for per-format logic.
 * ======================================================================= */
export { slim, SlimError } from './slim/index.js';

/* =========================================================================
 * Default export — bundle everything for `import api from 'webparsers/api'`
 * ======================================================================= */
import { slim, SlimError } from './slim/index.js';
import { UnsupportedCRSError } from './tiff/errors.js';
export default {
  detectFormat, scan, extract, extractOutput, extractGrid, extractGridOutput,
  gridToJSON, gridToGeoTIFF, gridToImageData, gridToPNG,
  RAMPS, resolveRamp, sampleRamp, slim,
  WebparsersError, UnsupportedFormatError, VariableNotFoundError, SourceError, ExtractError,
  SlimError, UnsupportedCRSError,
};
