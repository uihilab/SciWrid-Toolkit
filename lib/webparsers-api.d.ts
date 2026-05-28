/**
 * Type definitions for the webparsers functional API.
 */

export type Format = 'grib2' | 'netcdf3' | 'netcdf4' | 'zarr' | 'tiff';

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

/**
 * CF-decoded time axis. Surfaced at top-level `ScanResult.times` when every
 * variable in the file shares the same axis; otherwise on each `VariableInfo`.
 */
export interface CFTimes {
  /** ISO-8601 timestamps, one per timestep. */
  values: string[];
  /** Original CF `units` attribute (e.g. `"hours since 2024-01-01"`). */
  unitsRaw: string;
  /** Normalised calendar identifier. */
  calendar: 'standard' | 'noleap' | '360_day';
}

export interface VariableInfo {
  index: number;
  name: string;
  supported: boolean;
  /** Per-variable time axis. Present only when this variable's axis differs
   *  from the file-level `ScanResult.times`, or when uniform-hoisting fails. */
  times?: CFTimes | null;
  /** Warnings produced while decoding this variable (e.g., unsupported calendar). */
  warnings?: string[];
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
  /** File-level time axis. Present only when every multi-dim variable shares it. */
  times?: CFTimes;
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

/** Thrown by the TIFF/GeoTIFF reader for CRS outside the v1 supported set. */
export class UnsupportedCRSError extends WebparsersError {
  /** EPSG code parsed from the GeoKey directory (null if unparseable). */
  epsg: number | null;
  /** Free-text CRS name when available. */
  crsName?: string;
}

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

/* =========================================================================
 * Map rendering — Float32 grid → colored RGBA / PNG
 * ======================================================================= */

/** An RGB triplet, each component 0..255. */
export type RGB = [r: number, g: number, b: number];

/** An RGBA quadruplet, each component 0..255. */
export type RGBA = [r: number, g: number, b: number, a: number];

/** A color-ramp stop: position t ∈ [0,1] paired with an RGB color. */
export type RampStop = [t: number, color: RGB];

/** A color ramp: an array of stops sorted by t. */
export type Ramp = RampStop[];

/** Names of the built-in color ramps. */
export type RampName = 'viridis' | 'plasma' | 'grayscale' | 'RdBu';

export interface RenderOptions {
  /** Built-in ramp name or a custom ramp array. Defaults to 'viridis'. */
  ramp?: RampName | Ramp;
  /** Lower bound of the value range. Defaults to the grid's finite minimum. */
  vmin?: number;
  /** Upper bound of the value range. Defaults to the grid's finite maximum. */
  vmax?: number;
  /** RGBA color for NaN / missing cells. Defaults to transparent [0,0,0,0]. */
  nodataColor?: RGBA;
}

/** RGBA image — wrap `data` in `new ImageData(data, width, height)` in a browser. */
export interface GridImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Built-in color ramps, keyed by name. */
export const RAMPS: Record<RampName, Ramp>;

/** Resolve a ramp name or custom array to a normalized ramp. */
export function resolveRamp(ramp: RampName | Ramp): Ramp;

/** Sample a ramp at t ∈ [0,1]. Non-finite t returns black [0,0,0]. */
export function sampleRamp(ramp: Ramp, t: number): RGB;

/** Color an ExtractGridResult into RGBA bytes for a canvas / ImageSource. */
export function gridToImageData(grid: ExtractGridResult, opts?: RenderOptions): GridImageData;

/* =========================================================================
 * slim — same-format file trimming
 * ======================================================================= */

export interface SlimOptions extends CommonOptions {
  /** Variable names to keep. Names from `scan().variable_names`. */
  variables: string[];
  /** Inclusive lower time index. Omit to start at 0. */
  t1?: number;
  /** Inclusive upper time index. Omit to keep all timesteps from t1. */
  t2?: number;
  /** Spatial bbox in WGS84 [minLon, minLat, maxLon, maxLat]. Per-format snapping rules apply. */
  bbox?: BBox;
}

export interface SlimResult {
  /** Slimmed file bytes, same format as input. */
  bytes: Uint8Array;
  format: Format;
  /** Human-readable warnings (e.g. Zarr time-range boundary widening). */
  warnings: string[];
  stats: {
    inputSize: number;
    outputSize: number;
    variablesKept: number;
    variablesDropped: number;
  };
}

/** Produce a smaller file in the same format containing only the selected variables/time range. */
export function slim(source: Source, opts: SlimOptions): Promise<SlimResult>;

export class SlimError extends WebparsersError {}

declare const _default: {
  detectFormat: typeof detectFormat;
  scan: typeof scan;
  extract: typeof extract;
  extractOutput: typeof extractOutput;
  extractGrid: typeof extractGrid;
  extractGridOutput: typeof extractGridOutput;
  gridToJSON: typeof gridToJSON;
  gridToGeoTIFF: typeof gridToGeoTIFF;
  gridToImageData: typeof gridToImageData;
  slim: typeof slim;
  WebparsersError: typeof WebparsersError;
  UnsupportedFormatError: typeof UnsupportedFormatError;
  VariableNotFoundError: typeof VariableNotFoundError;
  SourceError: typeof SourceError;
  ExtractError: typeof ExtractError;
  SlimError: typeof SlimError;
  UnsupportedCRSError: typeof UnsupportedCRSError;
};
export default _default;
