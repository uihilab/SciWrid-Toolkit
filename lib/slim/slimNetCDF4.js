/*
 * lib/slim/netcdf4.js
 *
 * NetCDF-4 / HDF5 slim, via h5wasm.
 *
 * Unlike GRIB2 / NetCDF3 / Zarr, HDF5 is not a stream-of-records or
 * zip-of-files format — it's an object/B-tree store, so there's no byte
 * cut. We open the source with h5wasm, create a new file in WASM heap,
 * and copy the selected datasets (with optional time slice on axis 0)
 * plus their attributes.
 *
 * v1 scope and limitations
 * ------------------------
 *   * Top-level datasets only. Datasets inside groups are NOT walked
 *     in v1 (a NetCDF4 file using only the root group — the common case
 *     for our existing scan/extract path — works fine).
 *   * Time slice (t1/t2) treats axis 0 as the time axis. Document this in
 *     SlimResult.warnings when t1/t2 is given.
 *   * Output is materialized in WASM heap before being returned, so the
 *     practical output cap is ~1–2 GB. Documented in docs/API.md.
 *   * Chunked datasets: chunking is preserved when the chunk shape still
 *     divides the (sliced) dataset shape; otherwise the dataset is
 *     written contiguous. Compression is dropped in v1 (h5wasm requires
 *     chunks for compression, and re-chunking heuristics get complicated).
 */

import { SlimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';

/* Mirror the h5wasm resolution from lib/webparsers-lib.js so consumers
 * don't have to install h5wasm separately. */
async function loadH5wasm(opts) {
  const override = opts?.h5wasmUrl;
  const isNode = typeof process !== 'undefined' &&
                 !!(process.versions && process.versions.node);
  const candidates = override
    ? [override]
    : isNode
      ? ['h5wasm', 'https://cdn.jsdelivr.net/npm/h5wasm@0.7.7/+esm']
      : ['https://cdn.jsdelivr.net/npm/h5wasm@0.7.7/+esm', 'h5wasm'];

  let mod, lastErr;
  for (const spec of candidates) {
    try { mod = await import(/* @vite-ignore */ spec); break; }
    catch (e) { lastErr = e; }
  }
  if (!mod)
    throw new SlimError(
      'NetCDF4 slim: failed to load h5wasm — tried ' + candidates.join(', ') +
      '. Last error: ' + (lastErr?.message || lastErr));

  const h5 = mod.default ?? mod;
  const { FS } = await h5.ready;
  return { h5, FS };
}

async function loadAll(byteSource) {
  const size = await byteSource.size();
  return byteSource.read(0, size);
}

// Slice a multi-dim typed array along an arbitrary axis [lo, hi] (inclusive).
function sliceAxis(data, shape, axis, lo, hi) {
  const newCount = hi - lo + 1;
  const newShape = shape.slice();
  newShape[axis] = newCount;
  // Compute strides (row-major / C order).
  const strides = new Array(shape.length);
  strides[shape.length - 1] = 1;
  for (let i = shape.length - 2; i >= 0; i--) strides[i] = strides[i + 1] * shape[i + 1];
  const Ctor = data.constructor;
  const totalOut = newShape.reduce((a, b) => a * b, 1);
  const out = new Ctor(totalOut);
  // Iterate over the output index space and copy from src.
  const idx = new Array(shape.length).fill(0);
  for (let oi = 0; oi < totalOut; oi++) {
    let srcOff = 0;
    for (let d = 0; d < shape.length; d++) {
      srcOff += (d === axis ? idx[d] + lo : idx[d]) * strides[d];
    }
    out[oi] = data[srcOff];
    // Increment idx in C order over newShape.
    for (let d = shape.length - 1; d >= 0; d--) {
      idx[d]++;
      if (idx[d] < newShape[d]) break;
      idx[d] = 0;
    }
  }
  return { data: out, shape: newShape };
}

// Find the inclusive [lo, hi] index range in a monotonic 1-D coord array.
function coordIndicesCovering(coord, valLo, valHi) {
  if (!coord || coord.length === 0) return null;
  const ascending = coord[coord.length - 1] >= coord[0];
  let lo = 0, hi = coord.length - 1;
  if (ascending) {
    while (lo < coord.length && coord[lo] < valLo) lo++;
    while (hi >= 0 && coord[hi] > valHi) hi--;
    if (lo > hi) return null;
  } else {
    while (lo < coord.length && coord[lo] > valHi) lo++;
    while (hi >= 0 && coord[hi] < valLo) hi--;
    if (lo > hi) return null;
  }
  return [lo, hi];
}

function sliceAxis0(data, shape, t1, t2) {
  if (!Array.isArray(shape) || shape.length === 0) return { data, shape };
  const stride = shape.slice(1).reduce((a, b) => a * b, 1);
  const start  = t1 * stride;
  const count  = (t2 - t1 + 1) * stride;
  /* IMPORTANT: use slice() (a copy) — subarray() returns a view backed by
   * the same buffer, and h5wasm's create_dataset path reads from the
   * underlying ArrayBuffer offset 0, mangling sliced data. */
  const out = data.slice(start, start + count);
  const newShape = shape.slice();
  newShape[0] = t2 - t1 + 1;
  return { data: out, shape: newShape };
}

/* A 1-D dataset that represents a coordinate axis (lat/lon/time/etc.).
 * NetCDF4 coordinate variables are HDF5 dimension scales (CLASS ==
 * 'DIMENSION_SCALE'); files written by tools that don't set that attribute
 * are still recognised by CF name / standard_name / units. These datasets
 * must travel with the data variables that reference them, otherwise the
 * slimmed file loses its axes and re-scan marks the variable unsupported. */
const AXIS_NAME_ALIASES = new Set([
  'lat', 'latitude', 'lon', 'longitude', 'time', 't',
  'x', 'y', 'lev', 'level', 'depth', 'height', 'bnds', 'nv',
]);

const HDF5_REFERENCE_ATTRS = new Set(['DIMENSION_LIST', 'REFERENCE_LIST']);

function isCoordLike(name, item) {
  if (!item || !item.shape || item.shape.length !== 1) return false;
  const a = item.attrs || {};
  if (String(a.CLASS?.value ?? '') === 'DIMENSION_SCALE') return true;
  if (AXIS_NAME_ALIASES.has(String(name).toLowerCase())) return true;
  const std = String(a.standard_name?.value ?? '').toLowerCase();
  if (std === 'latitude' || std === 'longitude' || std === 'time') return true;
  const units = String(a.units?.value ?? '').toLowerCase();
  if (units.includes('degrees_north') || units.includes('degrees_east') ||
      / since /.test(units)) return true;
  return false;
}

export async function slim(byteSource, opts /*, ctx */) {
  const data = await loadAll(byteSource);
  const { h5, FS } = await loadH5wasm(opts);

  const srcName = `_wp_slim_src_${Date.now()}_${Math.floor(Math.random()*1e6)}.nc`;
  const dstName = `_wp_slim_dst_${Date.now()}_${Math.floor(Math.random()*1e6)}.nc`;
  FS.writeFile(srcName, data);

  let srcFile = null;
  let dstFile = null;
  const warnings = [];

  try {
    srcFile = new h5.File(srcName, 'r');
    const allKeys = srcFile.keys();

    /* Identify all top-level datasets and their names. */
    const datasets = [];
    for (const name of allKeys) {
      const item = srcFile.get(name);
      if (!item) continue;
      if (item.constructor.name !== 'Dataset') continue;
      datasets.push({ name, item });
    }

    const requested = new Set(opts.variables);
    const datasetNames = datasets.map(d => d.name);
    const missing = opts.variables.filter(n => !datasetNames.includes(n));
    if (missing.length === opts.variables.length)
      throw new VariableNotFoundError(
        `NetCDF4 slim: none of the requested variables are present ` +
        `(requested: ${opts.variables.join(', ')}; ` +
        `available: ${datasetNames.join(', ')})`);
    if (missing.length > 0)
      throw new VariableNotFoundError(
        `NetCDF4 slim: variable(s) not found: ${missing.join(', ')}`);

    const haveT = opts.t1 != null || opts.t2 != null;
    const haveBbox = Array.isArray(opts.bbox) && opts.bbox.length === 4;

    /* ── bbox: identify lat/lon coord variables and their pixel index range ── */
    let latInfo = null, lonInfo = null;   // { name, length, sliceLo, sliceHi }
    if (haveBbox) {
      const [minLon, minLat, maxLon, maxLat] = opts.bbox;
      // CF identification: a 1-D dataset is lat if its name/standard_name/units match.
      function isCoord(name, item, axisAliases, unitMarker) {
        if (!item.shape || item.shape.length !== 1) return false;
        const lname = name.toLowerCase();
        if (axisAliases.includes(lname)) return true;
        const a = item.attrs || {};
        const std = String((a.standard_name?.value ?? '')).toLowerCase();
        const units = String((a.units?.value ?? '')).toLowerCase();
        if (axisAliases.includes(std)) return true;
        if (units.includes(unitMarker)) return true;
        return false;
      }
      for (const { name, item } of datasets) {
        if (!latInfo && isCoord(name, item, ['latitude', 'lat', 'y'], 'degrees_north'))
          latInfo = { name, length: Number(item.shape[0]), values: Array.from(item.value, Number) };
        if (!lonInfo && isCoord(name, item, ['longitude', 'lon', 'x'], 'degrees_east'))
          lonInfo = { name, length: Number(item.shape[0]), values: Array.from(item.value, Number) };
      }
      if (!latInfo || !lonInfo)
        throw new SlimError('NetCDF4 slim: bbox requires lat + lon 1-D coord variables (CF convention)');
      const latRange = coordIndicesCovering(latInfo.values, minLat, maxLat);
      const lonRange = coordIndicesCovering(lonInfo.values, minLon, maxLon);
      if (!latRange || !lonRange)
        throw new SlimError('NetCDF4 slim: bbox does not intersect lat/lon extent');
      latInfo.sliceLo = latRange[0]; latInfo.sliceHi = latRange[1];
      lonInfo.sliceLo = lonRange[0]; lonInfo.sliceHi = lonRange[1];
    }

    /* Identify the source's time axis length so we only slice datasets
     * that actually live on it (not lat/lon/other coord vars). Heuristic:
     * look for a top-level 1-D dataset named 'time' or 't' (case-insensitive). */
    let timeAxisLen = null;
    if (haveT) {
      for (const { name, item } of datasets) {
        const lname = name.toLowerCase();
        if ((lname === 'time' || lname === 't') &&
            item.shape && item.shape.length === 1) {
          timeAxisLen = Number(item.shape[0]);
          break;
        }
      }
      if (timeAxisLen == null) {
        warnings.push(
          'NetCDF4 slim: t1/t2 given but no top-level time/t coordinate ' +
          'dataset was found; time slice ignored.');
      } else {
        warnings.push(
          `NetCDF4 slim: t1/t2 applied to axis 0 of datasets whose ` +
          `axis-0 length matches the time coord (${timeAxisLen}); ` +
          `other datasets are kept whole.`);
      }
    }

    /* Auto-include the coordinate/axis datasets the kept variables depend on.
     * scan() never lists coords as variables, so callers only pass data
     * variables; without their axes the slimmed file can't be re-scanned.
     * Keep coord-like 1-D datasets whose length matches an axis length of a
     * requested variable (so unrelated 1-D series are not pulled in). */
    const requestedAxisLengths = new Set();
    for (const { name, item } of datasets) {
      if (!requested.has(name)) continue;
      for (const len of Array.from(item.shape, Number)) requestedAxisLengths.add(len);
    }
    const autoCoords = new Set();
    for (const { name, item } of datasets) {
      if (requested.has(name)) continue;
      if (isCoordLike(name, item) && requestedAxisLengths.has(Number(item.shape[0])))
        autoCoords.add(name);
    }

    dstFile = new h5.File(dstName, 'w');

    for (const { name, item } of datasets) {
      if (!requested.has(name) && !autoCoords.has(name)) continue;

      let value = item.value;
      let shape = Array.from(item.shape, (x) => Number(x));
      const dtype = item.dtype;
      const meta  = item.metadata;
      const chunks = meta && meta.chunks
        ? Array.from(meta.chunks, (x) => Number(x))
        : null;

      /* Apply time slice only when the dataset's axis 0 actually matches
       * the file's time axis length. */
      if (haveT && timeAxisLen != null &&
          shape.length >= 1 && shape[0] === timeAxisLen) {
        const t1   = opts.t1 ?? 0;
        const t2   = (opts.t2 != null) ? Math.min(opts.t2, timeAxisLen - 1)
                                       : (timeAxisLen - 1);
        if (t1 >= timeAxisLen) {
          warnings.push(
            `NetCDF4 slim: t1=${opts.t1} >= time axis length ` +
            `(${timeAxisLen}); dataset '${name}' kept whole.`);
        } else {
          const sliced = sliceAxis0(value, shape, t1, t2);
          value = sliced.data;
          shape = sliced.shape;
        }
      }

      /* Apply bbox slice along whichever axes match lat/lon coord lengths.
       * If `name` IS the lat or lon coord itself, also slice it. */
      if (haveBbox) {
        // Slice axes whose length matches lat/lon coord length.
        for (let d = 0; d < shape.length; d++) {
          if (latInfo && shape[d] === latInfo.length && d !== 0) {
            const sliced = sliceAxis(value, shape, d, latInfo.sliceLo, latInfo.sliceHi);
            value = sliced.data; shape = sliced.shape;
          } else if (lonInfo && shape[d] === lonInfo.length && d !== 0
                     && !(latInfo && shape[d] === latInfo.length)) {
            const sliced = sliceAxis(value, shape, d, lonInfo.sliceLo, lonInfo.sliceHi);
            value = sliced.data; shape = sliced.shape;
          }
        }
        // For the coord variables themselves (1-D, name match), slice them.
        if (latInfo && name === latInfo.name && shape.length === 1) {
          const sliced = sliceAxis(value, shape, 0, latInfo.sliceLo, latInfo.sliceHi);
          value = sliced.data; shape = sliced.shape;
        } else if (lonInfo && name === lonInfo.name && shape.length === 1) {
          const sliced = sliceAxis(value, shape, 0, lonInfo.sliceLo, lonInfo.sliceHi);
          value = sliced.data; shape = sliced.shape;
        }
      }

      /* Preserve chunks only if they still divide the (possibly sliced) shape. */
      let writeChunks = null;
      if (chunks && chunks.length === shape.length) {
        const fits = chunks.every((c, i) => c <= shape[i] && shape[i] % c === 0);
        if (fits) writeChunks = chunks;
      }

      const created = dstFile.create_dataset({
        name,
        data:  value,
        shape,
        dtype,
        chunks: writeChunks,
      });
      const ds = created || dstFile.get(name);
      if (!ds) {
        warnings.push(
          `NetCDF4 slim: dataset '${name}' was written but its handle ` +
          `could not be reopened; attributes not copied.`);
        continue;
      }

      /* Copy portable attributes. h5wasm cannot recreate HDF5 object-reference
       * dimension-scale linkage attrs, and webparsers resolves axes by
       * coordinate names/units instead. */
      const attrs = item.attrs;
      for (const attrName of Object.keys(attrs)) {
        if (HDF5_REFERENCE_ATTRS.has(attrName)) continue;
        try {
          const a = attrs[attrName];
          ds.create_attribute(attrName, a.value, a.shape, a.dtype);
        } catch (e) {
          warnings.push(
            `NetCDF4 slim: attribute '${attrName}' on '${name}' not copied ` +
            `(${e.message || e})`);
        }
      }
    }

    /* Copy file-level (root group) attributes. */
    const rootAttrs = srcFile.attrs;
    for (const attrName of Object.keys(rootAttrs)) {
      try {
        const a = rootAttrs[attrName];
        dstFile.create_attribute(attrName, a.value, a.shape, a.dtype);
      } catch (e) {
        warnings.push(
          `NetCDF4 slim: root attribute '${attrName}' not copied ` +
          `(${e.message || e})`);
      }
    }

    dstFile.flush();
    dstFile.close(); dstFile = null;
    srcFile.close(); srcFile = null;

    const out = FS.readFile(dstName);

    return {
      bytes: new Uint8Array(out),
      warnings,
      variablesKept:    requested.size,
      variablesDropped: datasets.length - requested.size - autoCoords.size,
    };
  } finally {
    try { if (dstFile) dstFile.close(); } catch (_) {}
    try { if (srcFile) srcFile.close(); } catch (_) {}
    try { FS.unlink(srcName); } catch (_) {}
    try { FS.unlink(dstName); } catch (_) {}
  }
}
