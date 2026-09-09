import { normaliseSamples } from './dataset.js';

/* One row per sample. The series header matches the documented shape of
 * extractOutput('csv'): variable,time,value,lat,lon
 *
 * Samples come through normaliseSamples because extract() returns two
 * different point-series shapes depending on which reader ran. */
function cell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function encodeSeriesCSV(result) {
  const rows = ['variable,time,value,lat,lon'];
  const { lat, lon } = result.location;
  for (const p of normaliseSamples(result))
    rows.push([cell(result.variable), cell(p.time), cell(p.value), cell(lat), cell(lon)].join(','));
  return rows.join('\n') + '\n';
}

/* Grid CSV is one row per cell, in row-major order from the north-west corner. */
export function encodeGridCSV(dataset) {
  const { lat, lon } = dataset.coords;
  const rows = ['variable,lat,lon,value'];
  for (const v of dataset.vars) {
    for (let j = 0; j < lat.length; j++)
      for (let i = 0; i < lon.length; i++)
        rows.push([cell(v.name), cell(lat[j]), cell(lon[i]),
          cell(v.data[j * lon.length + i])].join(','));
  }
  return rows.join('\n') + '\n';
}
