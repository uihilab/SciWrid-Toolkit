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
} from './wasm/webparsers-api.js';

export {
  scan,
  extract,
  extractOutput,
  extractGrid,
  detectFormat,
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from './wasm/webparsers-api.js';

// Low-level class API
export { webparsers as WebParsers } from './wasm/webparsers-lib.js';

import type { default as _default } from './wasm/webparsers-lib.js';
export default _default;
