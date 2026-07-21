/**
 * scripts/study/io.mjs — file loading and result-shape normalisation for the
 * comparison study.
 *
 * extract() result shapes vary by path (see scripts/test-grid.js:139-140):
 * a scalar `value`, a `timeseries[]`, or a `variables[]` wrapper. Every study
 * script goes through these helpers so the shapes are handled in one place.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Read a path into a File. The basename matters: format detection is
 *  extension- and magic-driven. */
export async function loadFile(path) {
  return new File([readFileSync(path)], basename(path));
}

function unwrap(result) {
  if (Array.isArray(result)) return result[0];
  if (result && Array.isArray(result.variables)) return result.variables[0];
  return result;
}

/* The parquet path returns `values` as a Float32Array, for which
 * Array.isArray() is false — check for typed arrays too or parquet silently
 * reads as "no value". */
const isList = (v) => Array.isArray(v) || ArrayBuffer.isView(v);

export function pointValue(result) {
  const o = unwrap(result);
  if (!o) return undefined;
  if (typeof o.value === 'number') return o.value;
  if (isList(o.timeseries) && o.timeseries.length)
    return o.timeseries[0].value;
  if (isList(o.values) && o.values.length) return o.values[0];
  return undefined;
}

export function pointSeries(result) {
  const o = unwrap(result);
  if (!o) return [];
  if (isList(o.timeseries)) return [...o.timeseries];
  if (isList(o.values)) {
    const t = isList(o.times) ? [...o.times] : [];
    return [...o.values].map((v, i) => ({ time: t[i] ?? null, value: v }));
  }
  if (typeof o.value === 'number') return [{ time: o.time ?? null, value: o.value }];
  return [];
}

/**
 * Resolve the variable name to query for a given source.
 *
 * Containers differ in whether they carry variable names at all: NetCDF/Zarr/
 * Parquet name their variables, but a GeoTIFF is a bare raster whose bands are
 * synthesised as `band_1`, `band_2`, ... So the study asks the file what it
 * has rather than assuming the source variable name survives transcoding.
 *
 * Coordinate arrays (lat/lon/time) are excluded so a Zarr store that lists its
 * coordinates alongside its data variables does not resolve to `lat`.
 *
 * Note the scan() shape is not uniform across formats: netcdf/zarr/parquet
 * return `variables: [{name, ...}]` while tiff returns `variable_names: [str]`.
 * Both are handled here.
 */
const COORD_NAMES = /^(lat|latitude|lon|long|longitude|time|t|x|y|crs|spatial_ref)$/i;

export function variableNames(scanResult) {
  if (Array.isArray(scanResult.variables) && scanResult.variables.length)
    return scanResult.variables.map((v) => (typeof v === 'string' ? v : v.name));
  if (Array.isArray(scanResult.variable_names)) return [...scanResult.variable_names];
  return [];
}

export function resolveVariable(scanResult, preferred) {
  const names = variableNames(scanResult);
  if (preferred && names.includes(preferred)) return preferred;
  const dataVars = names.filter((n) => !COORD_NAMES.test(n));
  if (dataVars.length) return dataVars[0];
  return names[0];
}

export function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  console.log('wrote', path);
}
