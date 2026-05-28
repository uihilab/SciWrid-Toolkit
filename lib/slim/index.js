/*
 * lib/slim/index.js
 *
 * Public slim() dispatcher.
 *
 *   slim(source, { variables, t1, t2 }) → Promise<SlimResult>
 *
 * Per-format strategies (see docs/API.md and the design doc):
 *   GRIB2     — message stream filter + concat (byte-cut, no decode)
 *   NetCDF3   — header rewrite + data span copy (byte-cut)
 *   Zarr      — zip-entry filter + re-zip (byte-cut; chunk-granular along
 *               time axis, with boundary widening warnings)
 *   NetCDF4   — h5wasm writer (deferred to Phase 5)
 *
 * The per-format slim modules are lazy-loaded so the cold-start cost of a
 * GRIB2 slim doesn't pull in the Zarr / HDF5 paths.
 */

import { detectFormat } from '../webparsers-api.js';
import { UnsupportedFormatError } from '../errors.js';
import { resolveByteSource } from './byte-source.js';
import { SlimError } from './errors.js';

export { SlimError } from './errors.js';

/**
 * @typedef {Object} SlimOptions
 * @property {string[]} variables  Variable names to keep (required, non-empty)
 * @property {number}  [t1]        Inclusive lower time index
 * @property {number}  [t2]        Inclusive upper time index
 * @property {Object}  [wasmFactory] Optional WASM factory (Node/browser plumbing)
 *
 * @typedef {Object} SlimResult
 * @property {Uint8Array} bytes
 * @property {'grib2'|'netcdf3'|'netcdf4'|'zarr'} format
 * @property {string[]} warnings
 * @property {{inputSize:number, outputSize:number, variablesKept:number, variablesDropped:number}} stats
 */

function validateOpts(opts) {
  if (!opts || typeof opts !== 'object')
    throw new SlimError('slim: opts is required (got ' + typeof opts + ')');
  if (!Array.isArray(opts.variables) || opts.variables.length === 0)
    throw new SlimError('slim: opts.variables must be a non-empty string array');
  for (const v of opts.variables)
    if (typeof v !== 'string' || v.length === 0)
      throw new SlimError('slim: opts.variables entries must be non-empty strings');

  const { t1, t2 } = opts;
  if (t1 != null && (!Number.isInteger(t1) || t1 < 0))
    throw new SlimError('slim: opts.t1 must be a non-negative integer');
  if (t2 != null && (!Number.isInteger(t2) || t2 < 0))
    throw new SlimError('slim: opts.t2 must be a non-negative integer');
  if (t1 != null && t2 != null && t2 < t1)
    throw new SlimError(`slim: opts.t2 (${t2}) must be >= opts.t1 (${t1})`);
}

/**
 * @param {*} source  Uint8Array | ArrayBuffer | Blob | URL | string
 * @param {SlimOptions} opts
 * @returns {Promise<SlimResult>}
 */
export async function slim(source, opts) {
  validateOpts(opts);

  /* sniff format from the first few bytes via a tiny byte-source read */
  const byteSource = await resolveByteSource(source);
  const inputSize  = await byteSource.size();
  const head       = await byteSource.read(0, Math.min(16, inputSize));
  const fmt        = await detectFormat(head);
  if (fmt == null)
    throw new UnsupportedFormatError(
      'slim: could not detect format from leading bytes');
  if (fmt === 'tiff')
    throw new UnsupportedFormatError(
      'slim() does not support TIFF in v1 (read-only). Tracked for a follow-up sprint.');

  let mod;
  try {
    switch (fmt) {
      case 'grib2':   mod = await import('./slimGrib2.js');   break;
      case 'netcdf3': mod = await import('./slimNetCDF3.js'); break;
      case 'zarr':    mod = await import('./slimZarr.js');    break;
      case 'netcdf4': mod = await import('./slimNetCDF4.js'); break;
      default:
        throw new UnsupportedFormatError(`slim: format '${fmt}' not handled`);
    }
  } catch (e) {
    /* If the per-format module isn't published yet (e.g. Phase 5 not landed
     * for netcdf4), surface a clear error rather than a cryptic MODULE_NOT_FOUND. */
    if (e && e.code === 'ERR_MODULE_NOT_FOUND')
      throw new UnsupportedFormatError(
        `slim: ${fmt} support not yet implemented in this build`);
    throw e;
  }

  const result = await mod.slim(byteSource, opts, { format: fmt, inputSize });
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
