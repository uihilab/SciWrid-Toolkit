/**
 * SciWrid Toolkit — front-facing entry point
 *
 * Parses meteorological and geospatial data formats (GRIB2, NetCDF3,
 * NetCDF4/HDF5, Zarr v2, TIFF/GeoTIFF) in the browser, Web Workers, and
 * Node.js 18+. Powered by a C core compiled to WebAssembly via Emscripten.
 *
 * ── Quick-start (functional API) ────────────────────────────────────────────
 *
 *   import { scan, extract, extractGrid, trim, detectFormat } from 'sciwrid-toolkit';
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
 *   const { bytes } = await trim(fileBytes, { variables: ['TMP'], t1: 0, t2: 23 });
 *
 * ── Class-based API (advanced) ───────────────────────────────────────────────
 *
 *   import { SciWridToolkit } from 'sciwrid-toolkit';
 *
 *   const parser = new SciWridToolkit();
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
 * ── Error types (all extend SciWridError) ─────────────────────────────────
 *   SciWridError, UnsupportedFormatError, VariableNotFoundError,
 *   SourceError, ExtractError, TrimError, UnsupportedCRSError
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
  trim,
} from './lib/sciwrid-api.js';

// ── Typed error classes ───────────────────────────────────────────────────────
export {
  SciWridError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
  TrimError,
  UnsupportedCRSError,
} from './lib/sciwrid-api.js';

// ── Low-level class API ───────────────────────────────────────────────────────
// The main toolkit class, for reusing one loaded file across many queries.
export { SciWridToolkit } from './lib/sciwrid-lib.js';

// ── Default export — the class, for convenience ───────────────────────────────
export { default } from './lib/sciwrid-lib.js';
