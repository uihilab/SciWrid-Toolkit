/**
 * Type definitions for the webparsers functional API.
 */

export type Format = 'grib2' | 'netcdf3' | 'netcdf4' | 'zarr';

export type Source =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | File
  | URL
  | string;

export interface CommonOptions {
  /** Optional Emscripten WASM factory override (for non-standard loaders). */
  wasmFactory?: () => Promise<any>;
  /** Override the URL/specifier used to load h5wasm (NetCDF4 only).
   *  Default: jsdelivr CDN in browsers, bare `h5wasm` import in Node. */
  h5wasmUrl?: string;
}

export interface VariableInfo {
  index: number;
  name: string;
  supported: boolean;
  /* GRIB2 fields */
  cat?: number;
  num?: number;
  grid_template?: number;
  data_template?: number;
  nx?: number;
  ny?: number;
  messages?: number;
  /* NetCDF fields */
  long_name?: string;
  units?: string;
  shape?: string;
  ndims?: number;
}

export interface ScanResult {
  format: Format;
  total_variables: number;
  supported_variables: number;
  variable_names: string[];
  /* GRIB2-specific */
  grid_templates?: number[];
  data_templates?: number[];
  /* NetCDF-specific */
  shapes?: string[];
  units?: string[];
  variables: VariableInfo[];
}

export interface ExtractOptions extends CommonOptions {
  /** Variable name, or array of names. If omitted, all supported vars are extracted. */
  variable?: string | string[];
  lat?: number;
  lon?: number;
  /** Time index range (inclusive). */
  t1?: number;
  t2?: number;
}

export interface TimeseriesPoint {
  time: number;
  value: number;
}

export interface ExtractResult {
  variable?: string;
  location?: { lat: number; lon: number };
  time?: number;
  value?: number;
  timeseries?: TimeseriesPoint[];
  /** Present when multiple variables were requested. */
  variables?: ExtractResult[];
  [extra: string]: unknown;
}

export type OutputFormat = 'json' | 'csv';

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface ExtractGridProgress {
  done: number;
  total: number;
  chunk?: number;
  totalChunks?: number;
}

export interface ExtractGridOptions extends CommonOptions {
  /** Variable name to extract. Required. */
  variable: string;
  /** Geographic bbox as [minLon, minLat, maxLon, maxLat]. Required. */
  bbox: BBox;
  /** Output grid columns. Required. */
  width: number;
  /** Output grid rows. Required. */
  height: number;
  /** Time index; defaults to 0. */
  time?: number;
  /** Worker pool size; defaults to 5. Pass 0 to force inline (single-threaded) extraction. */
  workers?: number;
  /** Optional abort signal. Aborting mid-flight rejects with AbortError. */
  signal?: AbortSignal;
  /** Optional progress callback fired after each chunk. */
  onProgress?: (p: ExtractGridProgress) => void;
}

export interface ExtractGridResult {
  /** Row-major Float32 grid of length width*height. Row 0 = maxLat (north-up). */
  data: Float32Array;
  width: number;
  height: number;
  bbox: BBox;
  variable: string;
  units?: string;
  /** Time index used. */
  time?: number;
}

/* ---- Error classes ---- */
export class WebparsersError extends Error {}
export class UnsupportedFormatError extends WebparsersError {}
export class VariableNotFoundError extends WebparsersError {}
export class SourceError extends WebparsersError {}
export class ExtractError extends WebparsersError {}

/* ---- Functions ---- */
export function detectFormat(source: Source): Promise<Format | null>;
export function scan(source: Source, opts?: CommonOptions): Promise<ScanResult>;
export function extract(source: Source, options?: ExtractOptions): Promise<ExtractResult>;
export function extractOutput(
  source: Source,
  options?: ExtractOptions,
  format?: OutputFormat,
): Promise<string>;
export function extractGrid(source: Source, options: ExtractGridOptions): Promise<ExtractGridResult>;

/** Output format for `extractGridOutput()`. */
export type GridOutputFormat = 'json' | 'geotiff' | 'tif' | 'tiff';

/** Run `extractGrid()` and serialize the result. */
export function extractGridOutput(
  source: Source,
  options: ExtractGridOptions & { pretty?: boolean },
  format?: 'json'
): Promise<string>;
export function extractGridOutput(
  source: Source,
  options: ExtractGridOptions,
  format: 'geotiff' | 'tif' | 'tiff'
): Promise<Uint8Array>;

/** Serialize an already-extracted grid to a JSON string. */
export function gridToJSON(grid: ExtractGridResult, opts?: { pretty?: boolean }): string;

/** Serialize an already-extracted grid to a single-band Float32 GeoTIFF (WGS84). */
export function gridToGeoTIFF(grid: ExtractGridResult): Uint8Array;

declare const _default: {
  detectFormat: typeof detectFormat;
  scan: typeof scan;
  extract: typeof extract;
  extractOutput: typeof extractOutput;
  extractGrid: typeof extractGrid;
  extractGridOutput: typeof extractGridOutput;
  gridToJSON: typeof gridToJSON;
  gridToGeoTIFF: typeof gridToGeoTIFF;
  WebparsersError: typeof WebparsersError;
  UnsupportedFormatError: typeof UnsupportedFormatError;
  VariableNotFoundError: typeof VariableNotFoundError;
  SourceError: typeof SourceError;
  ExtractError: typeof ExtractError;
};
export default _default;
