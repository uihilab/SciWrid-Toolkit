/**
 * normalize.js — map arbitrary Float32 grid ranges into [0, 1] for ramp lookup.
 *
 * Two modes: auto (min/max from the data, ignoring NaN) and explicit
 * (caller supplies vmin/vmax).
 */

/**
 * Compute (vmin, vmax) for a Float32 grid, ignoring NaN and Infinity.
 * Returns null if the entire grid is non-finite.
 */
export function autoRange(data) {
  let vmin = Infinity, vmax = -Infinity, anyFinite = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    anyFinite = true;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  if (!anyFinite) return null;
  if (vmin === vmax) return { vmin: vmin - 0.5, vmax: vmax + 0.5 }; // avoid /0
  return { vmin, vmax };
}

/** Linear normalisation into [0, 1]. NaN passes through. */
export function normalize(v, vmin, vmax) {
  if (!Number.isFinite(v)) return NaN;
  const t = (v - vmin) / (vmax - vmin);
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}
