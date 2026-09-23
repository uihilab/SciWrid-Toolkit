/*
 * lib/hdf5/jsfive-errors.js
 *
 * jsfive throws bare strings, not Errors:
 *
 *   throw "InvalidHDF5File('unknown Data Object Header')"
 *
 * Every decline in hdf5-range.js was built with `String((e && e.message) || e)`,
 * which is correct for an Error and prints the value for a string -- but
 * `e.__fallback` is also undefined on a string, so a layout complaint and a
 * truncated read became indistinguishable. During investigation the message
 * surfaced as "undefined" and was read as a bad variable name.
 *
 * One boundary, one shape: everything jsfive throws leaves here as an Error.
 */

/** Whatever jsfive threw, as an Error. Errors pass through untouched. */
export function normalizeJsfiveError(value) {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.length > 0) {
    const e = new Error(value);
    /* Marks the throw as jsfive's own rather than ours, so a caller can say
       so in a decline without matching on message text. */
    e.__jsfive = true;
    return e;
  }
  const e = new Error(
    value == null ? 'jsfive threw no value' : `jsfive threw ${typeof value}: ${String(value)}`);
  e.__jsfive = true;
  return e;
}
