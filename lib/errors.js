/*
 * lib/errors.js
 *
 * Base typed errors for the webparsers package. Lives in its own module
 * (no further imports) so submodules can extend WebparsersError without
 * creating circular imports through webparsers-api.js.
 */

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
