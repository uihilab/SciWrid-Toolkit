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

/* ── Web-Mercator reprojection ─────────────────────────────────────────────
 * extractGrid() returns an EQUIRECTANGULAR grid (rows evenly spaced in
 * latitude). MapLibre's ImageSource drapes an image on the Web-Mercator
 * basemap by linearly stretching its four corners — it does NOT reproject per
 * row. So an equirectangular raster only lines up near the equator; the error
 * grows toward the poles (tens of degrees at full extent). We fix this by
 * resampling the grid's rows to be uniform in Mercator-Y over the clamped lat
 * range, so when MapLibre stretches the corners every row lands at its true
 * latitude. Longitude is untouched (already linear in both projections).
 * --------------------------------------------------------------------------- */

// MapLibre clamps Web-Mercator to ±this latitude; the display box is clamped to
// it (see clampMercatorLat in map-demo.js), so the warp must use the same bound.
export const MERCATOR_MAX_LAT = 85.05112878;

const _mercY    = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
const _invMercY = (y)   => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

/**
 * Reproject an equirectangular grid to Web-Mercator row spacing.
 *
 * @param {{data:Float32Array,width:number,height:number,bbox:[number,number,number,number]}} grid
 *        Equirectangular grid from extractGrid (row 0 = maxLat, north-up).
 * @returns {{data:Float32Array,width:number,height:number,bbox:[number,number,number,number]}}
 *          New grid (same width/height/bbox/lon) whose row r samples the source
 *          latitude that maps to a Mercator-uniform position over the clamped
 *          lat range [max(minLat,-MAX), min(maxLat,+MAX)]. The caller must place
 *          the image at that same clamped lat range (bboxToCoords already does).
 */
export function mercatorWarpGrid(grid) {
  const { data, width: w, height: h, bbox } = grid;
  const [, minLat, , maxLat] = bbox;
  const top = Math.min(maxLat, MERCATOR_MAX_LAT);
  const bot = Math.max(minLat, -MERCATOR_MAX_LAT);
  // Degenerate or already-thin span: nothing meaningful to reproject.
  if (!(top > bot) || !(maxLat > minLat)) return grid;

  const yTop = _mercY(top), yBot = _mercY(bot);
  const out  = new Float32Array(w * h);
  const span = maxLat - minLat;
  for (let r = 0; r < h; r++) {
    const my  = yTop + ((r + 0.5) / h) * (yBot - yTop); // Mercator-uniform row
    const lat = _invMercY(my);                          // its true latitude
    // Source row in the equirectangular grid (row 0 = maxLat).
    let sr = Math.round(((maxLat - lat) / span) * h - 0.5);
    if (sr < 0) sr = 0; else if (sr >= h) sr = h - 1;
    out.set(data.subarray(sr * w, sr * w + w), r * w);
  }
  return { data: out, width: w, height: h, bbox };
}
