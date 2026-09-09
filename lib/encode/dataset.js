/*
 * lib/encode/dataset.js — the only place that knows CF conventions.
 *
 * Turns either extract result shape into one small dataset that every writer
 * consumes, so no writer ever parses an extract result:
 *
 *   { dims:    { time?, lat?, lon? },          // sizes, only those present
 *     coords:  { time?: Float64Array,          // seconds since 1970-01-01
 *                lat: Float32Array, lon: Float32Array },
 *     vars:    [ { name, units, data: Float32Array, dims: string[] } ],
 *     attrs:   { Conventions, title, source, featureType? },
 *     kind:    'grid' | 'series' }
 */
import { UnsupportedExportError } from './errors.js';

const SOURCE = 'SciWrid Toolkit';

export const TIME_UNITS = 'seconds since 1970-01-01T00:00:00Z';
export const FILL_F32 = 9.969209968386869e36;   /* CF default float fill */

export function gridToDataset(grid) {
  if (!grid || typeof grid !== 'object')
    throw new UnsupportedExportError('encodeGrid: expected an extractGrid result object.');
  const { width, height, bbox } = grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new UnsupportedExportError('encodeGrid: grid needs integer width and height.');
  if (!Array.isArray(bbox) || bbox.length !== 4)
    throw new UnsupportedExportError('encodeGrid: grid needs bbox [minLon,minLat,maxLon,maxLat].');

  const bands = Array.isArray(grid.data) ? grid.data : [grid.data];
  for (const band of bands) {
    if (!band || band.length !== width * height)
      throw new UnsupportedExportError(
        `encodeGrid: band length ${band ? band.length : 0} !== width*height (${width * height}).`);
  }

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLon = (maxLon - minLon) / width;
  const dLat = (maxLat - minLat) / height;
  const lon = new Float32Array(width);
  for (let i = 0; i < width; i++) lon[i] = minLon + (i + 0.5) * dLon;
  const lat = new Float32Array(height);
  /* row 0 is at maxLat (north-up), so lat descends. Do not flip the data. */
  for (let j = 0; j < height; j++) lat[j] = maxLat - (j + 0.5) * dLat;

  const names = grid.variable_names
    || bands.map((_, i) => (bands.length === 1
      ? (grid.variable || 'data')
      : `${grid.variable || 'band'}_${i + 1}`));

  return {
    kind: 'grid',
    dims:   { lat: height, lon: width },
    coords: { lat, lon },
    vars: bands.map((data, i) => ({
      name: String(names[i]),
      units: grid.units ?? null,
      data: data instanceof Float32Array ? data : Float32Array.from(data),
      dims: ['lat', 'lon'],
    })),
    attrs: {
      Conventions: 'CF-1.8',
      title: `${grid.variable ?? 'data'} extracted by ${SOURCE}`,
      source: SOURCE,
      ...(grid.time ? { time_coverage_start: String(grid.time) } : {}),
    },
  };
}

/* A point/series result becomes a real time axis over one cell:
 *   <var>(time, lat=1, lon=1), time(time) in seconds since the epoch.
 * Not a stack of bands — the time dimension carries CF time metadata — and
 * still readable by this library's own gridded readers, which is what makes
 * the round-trip test a real check rather than a formality. */
export function seriesToDataset(result) {
  if (!result || typeof result !== 'object')
    throw new UnsupportedExportError('encodeSeries: expected an extract result object.');
  if (Array.isArray(result.variables))
    throw new UnsupportedExportError(
      'encodeSeries: multi-variable results are not encodable yet. Use json or csv.');
  if (Array.isArray(result.results))
    throw new UnsupportedExportError(
      'encodeSeries: whole-cube results (extract without lat/lon) are not encodable. Use json or csv.');
  const ts = result.timeseries;
  if (!Array.isArray(ts) || ts.length === 0)
    throw new UnsupportedExportError(
      'encodeSeries: result has no timeseries[]. Use json or csv.');
  if (!result.location || !Number.isFinite(result.location.lat)
      || !Number.isFinite(result.location.lon))
    throw new UnsupportedExportError('encodeSeries: result has no numeric location {lat,lon}.');

  const time = new Float64Array(ts.length);
  for (let i = 0; i < ts.length; i++) {
    const ms = Date.parse(ts[i].time);
    if (!Number.isFinite(ms))
      throw new UnsupportedExportError(`encodeSeries: unparseable time '${ts[i].time}'.`);
    time[i] = ms / 1000;
  }
  const data = Float32Array.from(ts, (p) => (Number.isFinite(p.value) ? p.value : NaN));

  return {
    kind: 'series',
    dims:   { time: ts.length, lat: 1, lon: 1 },
    coords: {
      time,
      lat: Float32Array.of(result.location.lat),
      lon: Float32Array.of(result.location.lon),
    },
    vars: [{
      name: String(result.variable ?? 'data'),
      units: result.units ?? null,
      data,
      dims: ['time', 'lat', 'lon'],
    }],
    attrs: {
      Conventions: 'CF-1.8',
      featureType: 'timeSeries',
      title: `${result.variable ?? 'data'} at ${result.location.lat}, ${result.location.lon}`,
      source: SOURCE,
    },
  };
}
