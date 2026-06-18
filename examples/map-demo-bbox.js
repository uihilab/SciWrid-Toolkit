// examples/map-demo-bbox.js - pure, DOM-free helpers for the map-demo bbox
// selection UI. Kept free of document / maplibregl so it can be unit-tested
// under Node (scripts/test-map-bbox.js). All map/DOM wiring lives in
// map-demo.js.

const EPS = 1e-9;

/**
 * Validate a user-entered bbox against the file's coverage.
 *
 * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} inputs
 *        Raw numbers from the four inputs (may be NaN if blank/invalid).
 * @param {[number,number,number,number]} coverage
 *        File coverage as [minLon, minLat, maxLon, maxLat].
 * @returns {{ bbox: [number,number,number,number]|null, error: string|null }}
 *          On success, bbox is [minLon, minLat, maxLon, maxLat] clamped into
 *          coverage. On failure, bbox is null and error explains why.
 */
export function validateBbox(inputs, coverage) {
  const { minLat, maxLat, minLon, maxLon } = inputs;
  const [covMinLon, covMinLat, covMaxLon, covMaxLat] = coverage;

  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite))
    return { bbox: null, error: 'Enter all four numbers.' };

  if (minLat >= maxLat)
    return { bbox: null, error: 'Min Lat must be less than Max Lat.' };
  if (minLon >= maxLon)
    return { bbox: null, error: 'Min Lon must be less than Max Lon.' };

  if (minLat < covMinLat - EPS || maxLat > covMaxLat + EPS)
    return { bbox: null, error: `Lat must be within ${covMinLat} ... ${covMaxLat}.` };
  if (minLon < covMinLon - EPS || maxLon > covMaxLon + EPS)
    return { bbox: null, error: `Lon must be within ${covMinLon} ... ${covMaxLon}.` };

  // Clamp to coverage to absorb float epsilon at the edges.
  return {
    bbox: [
      Math.max(minLon, covMinLon),
      Math.max(minLat, covMinLat),
      Math.min(maxLon, covMaxLon),
      Math.min(maxLat, covMaxLat),
    ],
    error: null,
  };
}

/**
 * Bucket a pixel dimension so sub-pixel pan/zoom jitter doesn't trigger
 * needless re-extracts. Rounds px to the nearest step.
 */
export function resolutionBucket(px, step = 32) {
  return Math.round(px / step) * step;
}
