/**
 * webparsers — front-facing entry point
 *
 * Parses meteorological and geospatial data formats (GRIB2, NetCDF3,
 * NetCDF4/HDF5, Zarr v2, TIFF/GeoTIFF) in the browser, Web Workers, and
 * Node.js 18+. Powered by a C core compiled to WebAssembly via Emscripten.
 *
 * ── Quick-start (functional API) ────────────────────────────────────────────
 *
 *   import { scan, extract, extractGrid, slim, detectFormat } from 'webparsers';
 *
 *   // Scan a file — returns metadata + variable list
 *   const meta = await scan('https://example.com/forecast.grb2');
 *   console.log(meta.format, meta.variable_names);
 *
 *   // Extract data at a point
 *   const result = await extract(fileBytes, { variable: 'TMP', lat: 40.7, lon: -74.0 });
 *
 *   // Extract a bounding-box grid (parallel workers, abortable, progress)
 *   const grid = await extractGrid(fileBytes, { variable: 'TMP', bbox, width: 256, height: 256 });
 *
 *   // Trim a huge file in place — keep only what you need, same format out
 *   const { bytes } = await slim(fileBytes, { variables: ['TMP'], t1: 0, t2: 23 });
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
 *   GRIB2             (.grb2, .grib2)
 *   NetCDF3 Classic   (.nc3)
 *   NetCDF4 / HDF5    (.nc, .nc4)        — uses h5wasm under the hood
 *   Zarr v2 (zip)     (.zip, .zarr)      — null/gzip/zlib/blosc/zstd/lz4
 *   TIFF / GeoTIFF    (.tif, .tiff)      — incl. Cloud-Optimized GeoTIFF over HTTP Range
 *
 * ── Error types (all extend WebparsersError) ─────────────────────────────────
 *   WebparsersError, UnsupportedFormatError, VariableNotFoundError,
 *   SourceError, ExtractError, SlimError, UnsupportedCRSError
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
