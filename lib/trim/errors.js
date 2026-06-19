/*
 * lib/trim/errors.js
 *
 * Typed error for the trim pipeline. Extends SciWridError so callers
 * can `instanceof SciWridError`-check at the package boundary.
 */
import { SciWridError } from '../errors.js';

export class TrimError extends SciWridError {
  constructor(message) { super(message); this.name = 'TrimError'; }
}
