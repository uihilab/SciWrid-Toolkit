/*
 * lib/slim/errors.js
 *
 * Typed error for the slim pipeline. Extends WebparsersError so callers
 * can `instanceof WebparsersError`-check at the package boundary.
 */
import { WebparsersError } from '../errors.js';

export class SlimError extends WebparsersError {
  constructor(message) { super(message); this.name = 'SlimError'; }
}
