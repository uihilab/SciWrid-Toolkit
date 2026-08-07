/*
 * lib/errors.js
 *
 * Base typed errors for the SciWrid Toolkit package. Lives in its own module
 * (no further imports) so submodules can extend SciWridError without
 * creating circular imports through sciwrid-api.js.
 */

export class SciWridError extends Error {
  constructor(message) { super(message); this.name = 'SciWridError'; }
}
export class UnsupportedFormatError extends SciWridError {
  constructor(message) { super(message); this.name = 'UnsupportedFormatError'; }
}
export class VariableNotFoundError extends SciWridError {
  constructor(message) { super(message); this.name = 'VariableNotFoundError'; }
}
export class SourceError extends SciWridError {
  constructor(message) { super(message); this.name = 'SourceError'; }
}
export class ExtractError extends SciWridError {
  constructor(message) { super(message); this.name = 'ExtractError'; }
}
