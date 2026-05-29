/**
 * time-select.js — resolve a date/time to a timestep index.
 *
 * Pure functions, no I/O. Used by extract/extractGrid to accept `date` /
 * `dateRange` options in addition to integer t1/t2/time indices.
 */

/** Parse an ISO string, Date, or epoch-ms number into epoch milliseconds. */
export function toEpochMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new Error('Invalid Date');
    return ms;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid epoch number: ${value}`);
    return value; // bare number = epoch milliseconds (JS Date convention)
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`Unparseable date string: "${value}"`);
    return ms;
  }
  throw new Error('date must be an ISO string, Date, or epoch-ms number');
}

/**
 * Return the index of the nearest axis value to reqMs. Ties go to the lower
 * index. `axisMs` is a non-empty array of epoch-ms numbers (ascending or not).
 */
export function resolveTimeIndex(axisMs, reqMs) {
  if (!Array.isArray(axisMs) || axisMs.length === 0)
    throw new Error('resolveTimeIndex: empty time axis');
  let best = 0, bestDiff = Math.abs(axisMs[0] - reqMs);
  for (let i = 1; i < axisMs.length; i++) {
    const d = Math.abs(axisMs[i] - reqMs);
    if (d < bestDiff) { best = i; bestDiff = d; }
  }
  return best;
}
