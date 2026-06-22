/*
 * Shared nearest-neighbor sampling helpers for grid extraction.
 */

export function nearestIdx(coords, target, ascending) {
  const n = coords.length;
  if (n === 1) return 0;
  const first = coords[0];
  const last = coords[n - 1];
  if (ascending) {
    if (target <= first) return 0;
    if (target >= last) return n - 1;
  } else {
    if (target >= first) return 0;
    if (target <= last) return n - 1;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const v = coords[mid];
    if ((ascending && v < target) || (!ascending && v > target)) lo = mid;
    else hi = mid;
  }
  return Math.abs(coords[lo] - target) <= Math.abs(coords[hi] - target) ? lo : hi;
}

export function normalizeLon(lon, lonRange) {
  const [min, max] = lonRange;
  if (lon >= min && lon <= max) return lon;
  if (lon + 360 >= min && lon + 360 <= max) return lon + 360;
  if (lon - 360 >= min && lon - 360 <= max) return lon - 360;
  return lon;
}

export function isOutsideLonRange(lon, lonRange) {
  const [min, max] = lonRange;
  return lon < min || lon > max;
}

export function isOutsideCoverage(coords, target) {
  const n = coords.length;
  if (n === 0) return true;
  if (n === 1) return target !== coords[0];

  const first = coords[0];
  const last = coords[n - 1];
  const ascending = first <= last;
  const low = ascending ? first : last;
  const high = ascending ? last : first;
  const lowStep = ascending
    ? Math.abs(coords[1] - coords[0])
    : Math.abs(coords[n - 1] - coords[n - 2]);
  const highStep = ascending
    ? Math.abs(coords[n - 1] - coords[n - 2])
    : Math.abs(coords[1] - coords[0]);

  return target < low - lowStep / 2 || target > high + highStep / 2;
}
