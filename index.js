/**
 * webparsers — front-facing entry point
 *
 * Parses meteorological data formats (GRIB2, NetCDF3, NetCDF4/HDF5) in the
 * browser, Web Workers, and Node.js 18+. Powered by a C core compiled to
 * WebAssembly via Emscripten.
 *
 * ── Quick-start (functional API) ────────────────────────────────────────────
 *
 *   import { scan, extract, extractOutput, detectFormat } from 'webparsers';
 *
 *   // Scan a file — returns metadata + variable list
 *   const meta = await scan('https://example.com/forecast.grb2');
 *   console.log(meta.format, meta.variable_names);
 *
 *   // Extract data at a point
 *   const result = await extract(fileBytes, { variable: 'TMP', lat: 40.7, lon: -74.0 });
 *
 *   // Serialise to JSON or CSV string
 *   const csv = await extractOutput(fileBytes, { variable: 'TMP' }, 'csv');
 *
 * ── Class-based API (advanced) ───────────────────────────────────────────────
 *
 *   import { WebParsers } from 'webparsers';
 *
 *   const parser = new WebParsers();
 *   await parser.read(fileBytes);
 *   const vars = parser.getvariables();
 *   const data = await parser.extract({ variable: 'TMP', lat: 40.7, lon: -74.0 });
 *   parser.close();
 *
 * ── Sources accepted ─────────────────────────────────────────────────────────
 *   Uint8Array | ArrayBuffer | File | Blob | URL | string (URL)
 *
 * ── Supported formats ────────────────────────────────────────────────────────
 *   GRIB2     (.grb2, .grib2)
 *   NetCDF3   (.nc3)
 *   NetCDF4   (.nc, .nc4)   — uses h5wasm under the hood
 *
 * ── Error types ──────────────────────────────────────────────────────────────
 *   WebparsersError, UnsupportedFormatError, VariableNotFoundError,
 *   SourceError, ExtractError
 */

// ── Functional API (recommended) ─────────────────────────────────────────────
export {
  scan,
  extract,
  extractOutput,
  extractGrid,
  extractGridOutput,
  gridToJSON,
  gridToGeoTIFF,
  gridToImageData,
  gridToPNG,
  RAMPS,
  resolveRamp,
  sampleRamp,
  detectFormat,
  slim,
} from './lib/webparsers-api.js';

// ── Typed error classes ───────────────────────────────────────────────────────
export {
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
  SlimError,
  UnsupportedCRSError,
} from './lib/webparsers-api.js';

// ── Low-level class API ───────────────────────────────────────────────────────
// Import the class as `WebParsers` (capital W, capital P) for a clear
// public-facing name. The internal file still uses lowercase `webparsers`.
export { webparsers as WebParsers } from './lib/webparsers-lib.js';

// ── Default export — the class, for convenience ───────────────────────────────
export { default } from './lib/webparsers-lib.js';
