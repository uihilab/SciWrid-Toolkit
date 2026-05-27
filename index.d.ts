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
  ExtractOptions,
  ExtractResult,
  TimeseriesPoint,
  OutputFormat,
  BBox,
  ExtractGridOptions,
  ExtractGridResult,
  ExtractGridProgress,
  GridOutputFormat,
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
  detectFormat,
  slim,
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
  SlimError,
} from './lib/webparsers-api.js';

// Low-level class API
export { webparsers as WebParsers } from './lib/webparsers-lib.js';

import type { default as _default } from './lib/webparsers-lib.js';
export default _default;
