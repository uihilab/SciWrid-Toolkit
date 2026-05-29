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

/**
 * Build the time axis (epoch-ms) for a variable from scan() metadata.
 * Returns { kind, ms } where kind is:
 *   'real'      — CF timestamps from variable.times.values or meta.times.values
 *   'synthetic' — Zarr arrays with no CF time metadata: ms[t] = t*86400*1000
 *   'none'      — no resolvable multi-step time axis (single timestep)
 * `ms` is null when kind === 'none'.
 */
export function axisFromMeta(meta, variable) {
  const v = Array.isArray(meta?.variables)
    ? meta.variables.find(x => x.name === variable)
    : null;

  // 1. Real CF times — per-variable first, then file-level.
  const values = v?.times?.values ?? meta?.times?.values;
  if (Array.isArray(values) && values.length > 0)
    return { kind: 'real', ms: values.map(s => toEpochMs(s)) };

  // 2. Synthetic Zarr axis from the variable's leading dimension.
  if (meta?.format === 'zarr' && v) {
    const shape = Array.isArray(v.shape)
      ? v.shape
      : (typeof v.shape === 'string' ? v.shape.split(/[,\sx]+/).filter(Boolean).map(Number) : null);
    const nt = shape && shape.length >= 3 ? shape[0] : null;
    if (nt && nt > 0) {
      const ms = new Array(nt);
      for (let t = 0; t < nt; t++) ms[t] = t * 86400 * 1000;
      return { kind: 'synthetic', ms };
    }
  }

  // 3. No resolvable axis.
  return { kind: 'none', ms: null };
}
