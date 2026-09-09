/*
 * lib/encode/index.js — the encoder layer's front door.
 *
 * EXPORT_FORMATS is the single source of truth for what can be written and
 * for which result kind. Validation reads it, and so does the API demo's
 * format chooser, so the UI can never offer a writer that does not exist.
 * A stage that adds a writer adds its row here and nothing else changes.
 */
import { UnsupportedExportError } from './errors.js';
import { gridToDataset, seriesToDataset } from './dataset.js';
import { encodeGridJSON, encodeSeriesJSON } from './json.js';
import { encodeGridCSV, encodeSeriesCSV } from './csv.js';
import { encodeGridGeoTIFF } from './geotiff.js';
import { encodeDatasetNetCDF3 } from './netcdf3.js';

export { UnsupportedExportError } from './errors.js';
export { gridToDataset, seriesToDataset } from './dataset.js';

export const EXPORT_FORMATS = Object.freeze([
  { id: 'json',    label: 'JSON',             ext: 'json', mime: 'application/json',
    grid: true, series: true,  binary: false },
  { id: 'csv',     label: 'CSV',              ext: 'csv',  mime: 'text/csv',
    grid: true, series: true,  binary: false },
  { id: 'geotiff', label: 'GeoTIFF',          ext: 'tif',  mime: 'image/tiff',
    grid: true, series: false, binary: true },
  { id: 'netcdf3', label: 'NetCDF-3 classic',  ext: 'nc3',  mime: 'application/x-netcdf',
    grid: true, series: true,  binary: true },
].map(Object.freeze));

const ALIASES = { tif: 'geotiff', tiff: 'geotiff',
                  nc: 'netcdf3', netcdf: 'netcdf3', nc3: 'netcdf3' };

export function resolveFormat(format) {
  const key = String(format ?? '').trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  const row = EXPORT_FORMATS.find(f => f.id === id);
  if (!row)
    throw new UnsupportedExportError(
      `Unknown output format '${format}'. Available: ${EXPORT_FORMATS.map(f => f.id).join(', ')}.`);
  return row;
}

function requireKind(row, kind) {
  if (row[kind]) return;
  const ok = EXPORT_FORMATS.filter(f => f[kind]).map(f => f.id).join(', ');
  const what = kind === 'series' ? 'a point/series result' : 'a grid';
  throw new UnsupportedExportError(
    `Format '${row.id}' cannot represent ${what}. Use one of: ${ok}.`);
}

export async function encodeGrid(grid, format = 'json', opts = {}) {
  const row = resolveFormat(format);
  requireKind(row, 'grid');
  if (row.id === 'json')    return encodeGridJSON(grid, opts);
  if (row.id === 'geotiff') return await encodeGridGeoTIFF(grid, opts);
  const dataset = gridToDataset(grid);
  if (row.id === 'csv')     return encodeGridCSV(dataset, opts);
  if (row.id === 'netcdf3') return encodeDatasetNetCDF3(dataset);
  throw new UnsupportedExportError(`No writer wired for '${row.id}'.`);
}

export async function encodeSeries(result, format = 'json', opts = {}) {
  const row = resolveFormat(format);
  requireKind(row, 'series');
  if (row.id === 'json') return encodeSeriesJSON(result, opts);
  /* Normalise first even for csv, so a rejected shape (whole cube,
   * multi-variable, empty series) throws the same typed error on every path. */
  const dataset = seriesToDataset(result);
  if (row.id === 'csv') return encodeSeriesCSV(result, opts);
  if (row.id === 'netcdf3') return encodeDatasetNetCDF3(dataset);
  throw new UnsupportedExportError(`No writer wired for '${row.id}'.`);
}
