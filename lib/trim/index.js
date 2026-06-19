/*
 * lib/trim/index.js
 *
 * Public trim() dispatcher.
 *
 *   trim(source, { variables, t1, t2, bbox }) → Promise<TrimResult>
 *
 * Per-format strategies (see docs/API.md and the design doc):
 *   GRIB2     — message stream filter + concat (byte-cut, no decode)
 *   NetCDF3   — header rewrite + data span copy (byte-cut)
 *   Zarr      — zip-entry filter + re-zip (chunk-granular time/bbox)
 *   NetCDF4   — h5wasm writer
 *   TIFF      — band/block copy or re-encode
 *
 * The per-format trim modules are lazy-loaded so the cold-start cost of a
 * GRIB2 trim doesn't pull in the Zarr / HDF5 paths.
 */

import { detectFormat } from '../sciwrid-api.js';
import { UnsupportedFormatError } from '../errors.js';
import { resolveByteSource } from './byte-source.js';
import { TrimError } from './errors.js';

export { TrimError } from './errors.js';

/**
 * @typedef {Object} TrimOptions
 * @property {string[]} variables  Variable names to keep (required, non-empty)
 * @property {number}  [t1]        Inclusive lower time index
 * @property {number}  [t2]        Inclusive upper time index
 * @property {[number, number, number, number]} [bbox] WGS84 [minLon, minLat, maxLon, maxLat]
 * @property {Object}  [wasmFactory] Optional WASM factory (Node/browser plumbing)
 *
 * @typedef {Object} TrimResult
 * @property {Uint8Array} bytes
 * @property {'grib2'|'netcdf3'|'netcdf4'|'zarr'|'tiff'} format
 * @property {string[]} warnings
 * @property {{inputSize:number, outputSize:number, variablesKept:number, variablesDropped:number}} stats
 */

function validateOpts(opts) {
  if (!opts || typeof opts !== 'object')
    throw new TrimError('trim: opts is required (got ' + typeof opts + ')');
  if (!Array.isArray(opts.variables) || opts.variables.length === 0)
    throw new TrimError('trim: opts.variables must be a non-empty string array');
  for (const v of opts.variables)
    if (typeof v !== 'string' || v.length === 0)
      throw new TrimError('trim: opts.variables entries must be non-empty strings');

  const { t1, t2 } = opts;
  if (t1 != null && (!Number.isInteger(t1) || t1 < 0))
    throw new TrimError('trim: opts.t1 must be a non-negative integer');
  if (t2 != null && (!Number.isInteger(t2) || t2 < 0))
    throw new TrimError('trim: opts.t2 must be a non-negative integer');
  if (t1 != null && t2 != null && t2 < t1)
    throw new TrimError(`trim: opts.t2 (${t2}) must be >= opts.t1 (${t1})`);

  if (opts.bbox != null) {
    if (!Array.isArray(opts.bbox) || opts.bbox.length !== 4)
      throw new TrimError('trim: opts.bbox must be [minLon, minLat, maxLon, maxLat]');
    const [minLon, minLat, maxLon, maxLat] = opts.bbox;
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite))
      throw new TrimError('trim: opts.bbox entries must be finite numbers');
    if (!(maxLon > minLon) || !(maxLat > minLat))
      throw new TrimError('trim: opts.bbox max values must be greater than min values');
  }
}

/**
 * @param {*} source  Uint8Array | ArrayBuffer | Blob | URL | string
 * @param {TrimOptions} opts
 * @returns {Promise<TrimResult>}
 */
export async function trim(source, opts) {
  validateOpts(opts);

  /* sniff format from the first few bytes via a tiny byte-source read */
  const byteSource = await resolveByteSource(source);
  const inputSize  = await byteSource.size();
  const head       = await byteSource.read(0, Math.min(16, inputSize));
  const fmt        = await detectFormat(head);
  if (fmt == null)
    throw new UnsupportedFormatError(
      'trim: could not detect format from leading bytes');
  if (opts.bbox != null && (fmt === 'grib2' || fmt === 'netcdf3')) {
    try { await byteSource.close?.(); } catch (_) {}
    throw new TrimError(
      `trim: bbox is not supported for ${fmt}; supported formats are zarr, netcdf4, and tiff`);
  }

  let mod;
  try {
    switch (fmt) {
      case 'grib2':   mod = await import('./trimGrib2.js');   break;
      case 'netcdf3': mod = await import('./trimNetCDF3.js'); break;
      case 'zarr':    mod = await import('./trimZarr.js');    break;
      case 'netcdf4': mod = await import('./trimNetCDF4.js'); break;
      case 'tiff':    mod = await import('./trimTiff.js');    break;
      default:
        throw new UnsupportedFormatError(`trim: format '${fmt}' not handled`);
    }
  } catch (e) {
    /* If the per-format module isn't published yet (e.g. Phase 5 not landed
     * for netcdf4), surface a clear error rather than a cryptic MODULE_NOT_FOUND. */
    if (e && e.code === 'ERR_MODULE_NOT_FOUND')
      throw new UnsupportedFormatError(
        `trim: ${fmt} support not yet implemented in this build`);
    throw e;
  }

  const result = await mod.trim(byteSource, opts, { format: fmt, inputSize });
  try { await byteSource.close?.(); } catch (_) {}

  return {
    bytes:    result.bytes,
    format:   fmt,
    warnings: result.warnings || [],
    stats: {
      inputSize,
      outputSize:        result.bytes.length,
      variablesKept:     result.variablesKept     ?? opts.variables.length,
      variablesDropped:  result.variablesDropped  ?? 0,
    },
  };
}
