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

export function pointValue(result) {
  const o = unwrap(result);
  if (!o) return undefined;
  if (typeof o.value === 'number') return o.value;
  if (Array.isArray(o.timeseries) && o.timeseries.length)
    return o.timeseries[0].value;
  if (Array.isArray(o.values) && o.values.length) return o.values[0];
  return undefined;
}

export function pointSeries(result) {
  const o = unwrap(result);
  if (!o) return [];
  if (Array.isArray(o.timeseries)) return o.timeseries;
  if (Array.isArray(o.values)) {
    const t = Array.isArray(o.times) ? o.times : [];
    return [...o.values].map((v, i) => ({ time: t[i] ?? null, value: v }));
  }
  if (typeof o.value === 'number') return [{ time: o.time ?? null, value: o.value }];
  return [];
}

export function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  console.log('wrote', path);
}
