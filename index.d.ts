/**
 * Type definitions for the SciWrid Toolkit library.
 */

// Re-export all types and function signatures from the internal API module.
export type {
  Format,
  Source,
  CommonOptions,
  VariableInfo,
  ScanResult,
  CFTimes,
  ExtractOptions,
  ExtractResult,
  TimeseriesPoint,
  OutputFormat,
  ExportFormat,
  BBox,
  ExtractGridOptions,
  ExtractGridResult,
  ExtractGridProgress,
  DateInput,
  GridOutputFormat,
  RGB,
  RGBA,
  RampStop,
  Ramp,
  RampName,
  RenderOptions,
  GridImageData,
  TrimOptions,
  TrimResult,
} from './lib/sciwrid-api.js';

export {
  encodeGrid,
  encodeSeries,
  EXPORT_FORMATS,
  UnsupportedExportError,
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
  SciWridError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
  TrimError,
  UnsupportedCRSError,
} from './lib/sciwrid-api.js';

// Low-level class API
export { SciWridToolkit } from './lib/sciwrid-lib.js';

import type { default as _default } from './lib/sciwrid-lib.js';
export default _default;
