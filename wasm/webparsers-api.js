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

/* =========================================================================
 * Typed errors
 * ======================================================================= */
export class WebparsersError extends Error {
  constructor(message) { super(message); this.name = 'WebparsersError'; }
}
export class UnsupportedFormatError extends WebparsersError {
  constructor(message) { super(message); this.name = 'UnsupportedFormatError'; }
}
export class VariableNotFoundError extends WebparsersError {
  constructor(message) { super(message); this.name = 'VariableNotFoundError'; }
}
export class SourceError extends WebparsersError {
  constructor(message) { super(message); this.name = 'SourceError'; }
}
export class ExtractError extends WebparsersError {
  constructor(message) { super(message); this.name = 'ExtractError'; }
}

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
  const lib = new webparsers(opts?.wasmFactory ? { wasmFactory: opts.wasmFactory } : {});
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
 * detectFormat — sniff magic bytes, no WASM init required
 * ======================================================================= */
export async function detectFormat(source) {
  const data = await resolveSource(source);
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
  return null;
}

/* =========================================================================
 * scan — return metadata + variable list
 * ======================================================================= */
export async function scan(source, opts = {}) {
  return withInstance(source, opts, (lib) => ({
    ...lib.metadata(),
    variables: lib.getvariables().map(v => {
      // strip private fields (leading underscore) from netcdf4 entries
      const out = {};
      for (const k of Object.keys(v)) if (!k.startsWith('_')) out[k] = v[k];
      return out;
    }),
  }));
}

/* =========================================================================
 * extract — decode one or more variables, return raw structured result
 *
 *   extract(source, { variable: 'TMP', lat: 40.7, lon: -74 })
 *   extract(source, { variable: ['TMP', 'UGRD'], t1: 0, t2: 5 })
 * ======================================================================= */
export async function extract(source, options = {}) {
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
 * Default export — bundle everything for `import api from 'webparsers/api'`
 * ======================================================================= */
export default {
  detectFormat, scan, extract, extractOutput,
  WebparsersError, UnsupportedFormatError, VariableNotFoundError, SourceError, ExtractError,
};
