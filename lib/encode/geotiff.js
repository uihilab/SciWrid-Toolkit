import { gridToGeoTIFF } from '../grid-output.js';

/* Grid only — a station time series is not a raster, so the registry marks
 * geotiff series:false and encodeSeries never reaches this file. */
export function encodeGridGeoTIFF(grid, opts = {}) {
  return gridToGeoTIFF(grid, opts);
}
