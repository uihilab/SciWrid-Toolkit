/*
 * lib/encode/parquet.js — write a Dataset as a Parquet table.
 *
 * Parquet is a table, not an array container, so the Dataset is flattened to
 * one row per sample:
 *
 *   grid    lat, lon, <variable>            one row per cell, row-major from
 *                                           the north-west corner
 *   series  time, lat, lon, <variable>      one row per timestep
 *
 * Those column names are what the reader's role heuristics look for
 * (lib/parquet/metadata.js: lat|latitude|y, lon|longitude|x,
 * time|datetime|date|timestamp|valid_time), and `time` is INT64 epoch
 * seconds, which is what lib/parquet/spatialize.js decodes back to ISO.
 * Everything not claimed as a coordinate becomes a value column, so the
 * variable's own name carries through.
 *
 * DEPENDENCY. Encoding Parquet means writing thrift-compact metadata, page
 * headers and column statistics; this delegates that to hyparquet-writer
 * rather than hand-rolling it. It is an OPTIONAL dependency, lazily imported,
 * which is the same contract the Parquet *reader* has with hyparquet
 * (lib/parquet/row-source.js) and the NetCDF-4 writer has with h5wasm. A
 * caller who never exports Parquet never loads it, and a caller who does gets
 * a message naming the install rather than a module-not-found stack.
 *
 * Missing values are written as IEEE NaN in a DOUBLE column, matching what
 * every other writer here does, so no null/definition-level handling is needed.
 */
import { UnsupportedExportError } from './errors.js';

const CDN = 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0.15.1/+esm';

let writerModule = null;

/* Same resolution order as lib/hdf5/load-h5wasm.js: the bare specifier first
 * in Node (where node_modules exists), the CDN first in a browser (where it
 * does not). Without the CDN leg this works in Node and fails in every
 * browser, which is not a writer you can ship to a web page. */
async function getWriter(overrideUrl) {
  if (writerModule) return writerModule;
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const candidates = overrideUrl ? [overrideUrl] : (isNode ? ['hyparquet-writer', CDN] : [CDN, 'hyparquet-writer']);

  let lastErr;
  for (const spec of candidates) {
    try { writerModule = await import(/* @vite-ignore */ spec); return writerModule; }
    catch (e) { lastErr = e; }
  }
  throw new UnsupportedExportError(
    'Parquet export needs the optional "hyparquet-writer" package — tried ' +
    candidates.join(', ') + '. In Node run: npm i hyparquet-writer. ' +
    'Underlying error: ' + (lastErr?.message || lastErr));
}

export async function encodeDatasetParquet(dataset, opts = {}) {
  const { parquetWriteBuffer } = await getWriter(opts.parquetWriterUrl);
  const { lat, lon, time } = dataset.coords;

  const columns = [];
  const latCol = [], lonCol = [], timeCol = [];
  const valueCols = dataset.vars.map(() => []);

  if (dataset.kind === 'series') {
    /* one row per timestep, at the single station cell */
    for (let t = 0; t < dataset.dims.time; t++) {
      timeCol.push(BigInt(Math.round(time[t])));
      latCol.push(lat[0]);
      lonCol.push(lon[0]);
      dataset.vars.forEach((v, k) => valueCols[k].push(v.data[t]));
    }
    columns.push({ name: 'time', data: timeCol, type: 'INT64' });
  } else {
    /* one row per cell, row-major from the north-west corner — the same order
     * the grid model stores, so no transposition is involved */
    for (let j = 0; j < dataset.dims.lat; j++) {
      for (let i = 0; i < dataset.dims.lon; i++) {
        latCol.push(lat[j]);
        lonCol.push(lon[i]);
        const idx = j * dataset.dims.lon + i;
        dataset.vars.forEach((v, k) => valueCols[k].push(v.data[idx]));
      }
    }
  }

  columns.push({ name: 'lat', data: latCol, type: 'DOUBLE' });
  columns.push({ name: 'lon', data: lonCol, type: 'DOUBLE' });
  dataset.vars.forEach((v, k) => {
    columns.push({ name: v.name, data: valueCols[k], type: 'DOUBLE' });
  });

  /* Units and provenance ride along as key/value file metadata — Parquet has
   * no per-column unit field, and the reader surfaces kv metadata. */
  const kv = [
    { key: 'Conventions', value: dataset.attrs.Conventions ?? 'CF-1.8' },
    { key: 'source', value: dataset.attrs.source ?? 'SciWrid Toolkit' },
  ];
  for (const v of dataset.vars) {
    if (v.units) kv.push({ key: `units:${v.name}`, value: String(v.units) });
  }
  if (dataset.attrs.title) kv.push({ key: 'title', value: String(dataset.attrs.title) });

  const buf = parquetWriteBuffer({
    columnData: columns,
    kvMetadata: kv,
    statistics: opts.statistics ?? true,
  });
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
