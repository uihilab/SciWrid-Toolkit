/**
 * Type definitions for the webparsers library.
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
  BBox,
  ExtractGridOptions,
  ExtractGridResult,
  ExtractGridProgress,
  GridOutputFormat,
  RGB,
  RGBA,
  RampStop,
  Ramp,
  RampName,
  RenderOptions,
  GridImageData,
  SlimOptions,
  SlimResult,
} from './lib/webparsers-api.js';

export {
  scan,
  extract,
  extractOutput,
  extractGrid,
  extractGridOutput,
  gridToJSON,
  gridToGeoTIFF,
  gridToImageData,
  detectFormat,
  slim,
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
  SlimError,
  UnsupportedCRSError,
} from './lib/webparsers-api.js';

// Low-level class API
export { webparsers as WebParsers } from './lib/webparsers-lib.js';

import type { default as _default } from './lib/webparsers-lib.js';
export default _default;
