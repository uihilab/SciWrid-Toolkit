/*
 * lib/trim/netcdf4.js
 *
 * NetCDF-4 / HDF5 trim, via h5wasm.
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
 *     TrimResult.warnings when t1/t2 is given.
 *   * Output is materialized in WASM heap before being returned, so the
 *     practical output cap is ~1–2 GB. Documented in docs/API.md.
 *   * Chunked datasets: the source chunk shape is reused, clamped per axis
 *     to the (possibly sliced) shape. HDF5 does not require chunks to
 *     divide the shape evenly -- it pads the edge chunk -- so only the
 *     `chunk <= shape` bound is enforced.
 *   * Compression is PRESERVED: a dataset the source stored with deflate is
 *     written back with deflate at the same level. Without this, trimming a
 *     compressed file returns raw bytes and the output can be several times
 *     the size of the input even when variables were dropped -- keeping 2 of
 *     4 float32 variables from a 3:1-compressed file came out at 154%.
 *     Datasets the source stored uncompressed stay uncompressed; trim
 *     preserves the file's character rather than imposing a policy.
 *     h5wasm exposes only the gzip filter, so HDF5's shuffle pre-filter is
 *     not reapplied. That shifts the packing either way depending on the
 *     data: shuffle helps high-entropy float fields by grouping exponent
 *     bytes, but hurts fields with many exactly-repeated values because it
 *     breaks up the long identical runs LZ77 matches for free. On the
 *     idalia NLDAS-2 fixture plain deflate beat shuffle+deflate on 3 of 4
 *     variables (Wind_E by 26%), so keeping ALL variables still came out at
 *     86% of the source. Output bytes therefore will not match the input
 *     even for a no-op trim; TrimResult.warnings names the affected
 *     datasets so the size difference is explainable rather than mysterious.
 */

import { TrimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';
import { h5TempName } from '../hdf5/vfs-name.js';

/* Mirror the h5wasm resolution from lib/sciwrid-lib.js so consumers
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
    throw new TrimError(
      'NetCDF4 trim: failed to load h5wasm — tried ' + candidates.join(', ') +
      '. Last error: ' + (lastErr?.message || lastErr));

  const h5 = mod.default ?? mod;
  const { FS } = await h5.ready;
  return { h5, FS };
}

/* HDF5 numeric filter ids (H5Zpublic.h). h5wasm can WRITE only deflate;
 * shuffle it can report but not reapply, hence the summary warning below. */
const H5Z_FILTER_DEFLATE = 1;
const H5Z_FILTER_SHUFFLE = 2;

/**
 * What compression, if any, to re-apply to a dataset we are copying.
 *
 * The rule is "whatever the source did": a dataset stored with deflate is
 * written back with deflate at the same level, and an uncompressed one stays
 * uncompressed. Imposing compression on a source that had none would trade
 * the caller's read speed for bytes they never asked to save; dropping it
 * from a source that had it is what made trimmed files grow.
 *
 * @returns {{ level: number|null, hadShuffle: boolean }}
 *          level === null means "write this one uncompressed".
 */
function sourceCompression(item) {
  let filters;
  /* .filters is a getter that reaches into the WASM heap; a dataset type it
   * cannot describe throws rather than returning []. Uncompressed output is
   * always a valid answer, so treat a failure as "no filters". */
  try { filters = item.filters; } catch (_) { return { level: null, hadShuffle: false }; }
  if (!Array.isArray(filters) || filters.length === 0)
    return { level: null, hadShuffle: false };

  let level = null, hadShuffle = false;
  for (const f of filters) {
    if (!f) continue;
    if (f.id === H5Z_FILTER_SHUFFLE) { hadShuffle = true; continue; }
    if (f.id === H5Z_FILTER_DEFLATE) {
      /* cd_values[0] is the deflate level. Clamp rather than trust: a level
       * outside 0-9 makes H5Pset_deflate fail and take the whole trim with it. */
      const raw = Array.isArray(f.cd_values) ? Number(f.cd_values[0]) : NaN;
      level = Number.isFinite(raw) ? Math.min(9, Math.max(0, Math.trunc(raw))) : 4;
    }
  }
  return { level, hadShuffle };
}

/**
 * Chunk shape to write `shape` with, given the source's chunk shape.
 *
 * Compression requires chunking, so this must return something usable for any
 * shape a filtered dataset can have. Each axis is clamped to the sliced extent
 * -- a chunk dimension larger than the dataspace is rejected by HDF5, and
 * slicing routinely makes an axis shorter than its original chunk.
 *
 * @returns {number[]|null} null when the shape cannot be chunked at all
 *          (scalar, or an axis of length 0).
 */
function chunkShapeFor(shape, srcChunks) {
  if (!Array.isArray(shape) || shape.length === 0) return null;   // scalar
  if (shape.some(n => !Number.isInteger(n) || n < 1)) return null; // empty axis
  const base = (Array.isArray(srcChunks) && srcChunks.length === shape.length)
    ? srcChunks
    : shape;                       /* contiguous source: one chunk per dataset */
  return shape.map((n, i) => {
    const c = Number(base[i]);
    return Number.isInteger(c) && c > 0 ? Math.min(c, n) : n;
  });
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
 * trimmed file loses its axes and re-scan marks the variable unsupported. */
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

export async function trim(byteSource, opts /*, ctx */) {
  const data = await loadAll(byteSource);
  const { h5, FS } = await loadH5wasm(opts);

  const srcName = h5TempName('_wp_trim_src');
  const dstName = h5TempName('_wp_trim_dst');
  FS.writeFile(srcName, data);

  let srcFile = null;
  let dstFile = null;
  const warnings = [];
  /* Datasets whose source used HDF5's shuffle pre-filter. h5wasm can write
   * deflate but not shuffle, so these re-pack differently from the source --
   * measurably better on some fields, worse on others. Collected rather than
   * warned per dataset: on a file where every variable is shuffled that would
   * be one warning per variable, all saying the same thing. */
  const shuffleDropped = new Set();

  try {
    srcFile = new h5.File(srcName, 'r');
    const allKeys = srcFile.keys();

    /* Identify all top-level datasets and their names. Groups are counted but
     * not walked (see the v1 scope note above); the count is what lets the
     * caller be told that a rewrite would leave their contents behind. */
    const datasets = [];
    const groupNames = [];
    for (const name of allKeys) {
      const item = srcFile.get(name);
      if (!item) continue;
      if (item.constructor.name === 'Group') { groupNames.push(name); continue; }
      if (item.constructor.name !== 'Dataset') continue;
      datasets.push({ name, item });
    }

    const requested = new Set(opts.variables);
    const datasetNames = datasets.map(d => d.name);
    const missing = opts.variables.filter(n => !datasetNames.includes(n));
    if (missing.length === opts.variables.length)
      throw new VariableNotFoundError(
        `NetCDF4 trim: none of the requested variables are present ` +
        `(requested: ${opts.variables.join(', ')}; ` +
        `available: ${datasetNames.join(', ')})`);
    if (missing.length > 0)
      throw new VariableNotFoundError(
        `NetCDF4 trim: variable(s) not found: ${missing.join(', ')}`);

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
        throw new TrimError('NetCDF4 trim: bbox requires lat + lon 1-D coord variables (CF convention)');
      const latRange = coordIndicesCovering(latInfo.values, minLat, maxLat);
      const lonRange = coordIndicesCovering(lonInfo.values, minLon, maxLon);
      if (!latRange || !lonRange)
        throw new TrimError('NetCDF4 trim: bbox does not intersect lat/lon extent');
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
          'NetCDF4 trim: t1/t2 given but no top-level time/t coordinate ' +
          'dataset was found; time slice ignored.');
      } else {
        warnings.push(
          `NetCDF4 trim: t1/t2 applied to axis 0 of datasets whose ` +
          `axis-0 length matches the time coord (${timeAxisLen}); ` +
          `other datasets are kept whole.`);
      }
    }

    /* Auto-include the coordinate/axis datasets the kept variables depend on.
     * scan() never lists coords as variables, so callers only pass data
     * variables; without their axes the trimmed file can't be re-scanned.
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

    /* A request that removes nothing is answered with the input itself.
     *
     * Rewriting it would not be a copy: this path writes a fresh HDF5 file, so
     * it re-frames the B-trees, cannot reapply HDF5's shuffle pre-filter,
     * drops the object-reference dimension-scale attrs, and leaves any grouped
     * dataset behind entirely. All of that is acceptable when the caller asked
     * to drop variables -- it is the price of the format having no byte cut --
     * but there is nothing to weigh it against when they asked to drop none.
     * Returning the source bytes is the only answer guaranteed to be faithful,
     * and it skips a full decompress/recompress plus the WASM heap ceiling.
     *
     * "Everything" is judged against the datasets actually in the file, never
     * against scan()'s variable list: scan() omits variables it cannot decode,
     * so a caller selecting every name it offered may still be asking for a
     * strict subset of the file. */
    const coversEveryDataset =
      datasets.every(({ name }) => requested.has(name) || autoCoords.has(name));
    if (coversEveryDataset && !haveT && !haveBbox) {
      srcFile.close(); srcFile = null;
      if (groupNames.length > 0)
        warnings.push(
          `NetCDF4 trim: returned the input unchanged (no variables dropped, ` +
          `no time or bbox slice). This also preserved ${groupNames.length} ` +
          `group(s) (${groupNames.slice(0, 4).join(', ')}) that a rewrite ` +
          `would not have copied.`);
      else
        warnings.push(
          'NetCDF4 trim: returned the input unchanged -- the selection drops ' +
          'nothing, so rewriting could only lose fidelity.');
      return {
        bytes: data,
        warnings,
        variablesKept:    requested.size,
        variablesDropped: 0,
      };
    }

    /* Past here the file is genuinely being rewritten, so anything this
     * version cannot carry across is lost. Say so rather than dropping it
     * silently -- a caller who needs those datasets can keep them by other
     * means, but only if they know they are gone. */
    if (groupNames.length > 0)
      warnings.push(
        `NetCDF4 trim: ${groupNames.length} group(s) ` +
        `(${groupNames.slice(0, 4).join(', ')}${groupNames.length > 4 ? ', …' : ''}) ` +
        `were NOT copied -- this version walks top-level datasets only, and ` +
        `any dataset inside a group is absent from the output.`);

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
            `NetCDF4 trim: t1=${opts.t1} >= time axis length ` +
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

      /* Re-apply whatever compression the source used. Deflate needs a chunked
       * layout, so the chunk shape is decided first and the compression is
       * dropped only if the dataset cannot be chunked at all. */
      const { level, hadShuffle } = sourceCompression(item);
      let writeChunks = null;
      let writeLevel  = null;

      if (level != null && !(meta && meta.vlen)) {
        writeChunks = chunkShapeFor(shape, chunks);
        if (writeChunks) {
          writeLevel = level;
          if (hadShuffle) shuffleDropped.add(name);
        } else {
          warnings.push(
            `NetCDF4 trim: dataset '${name}' has shape ` +
            `[${shape.join(', ')}], which cannot be chunked; written ` +
            `uncompressed (the source used deflate level ${level}).`);
        }
      } else if (chunks && chunks.length === shape.length) {
        /* Uncompressed but chunked at the source: keep the layout. HDF5 pads
         * the edge chunk, so the chunk shape need not divide the shape -- it
         * only has to fit inside it. */
        writeChunks = chunkShapeFor(shape, chunks);
      }

      let created;
      try {
        created = dstFile.create_dataset({
          name,
          data:  value,
          shape,
          dtype,
          chunks: writeChunks,
          ...(writeLevel != null
            ? { compression: 'gzip', compression_opts: writeLevel }
            : {}),
        });
      } catch (e) {
        /* A filter the build cannot apply must not cost the caller the whole
         * trim -- a larger file still holds their data. Retry uncompressed,
         * and say so rather than returning a silently bigger file. */
        if (writeLevel == null) throw e;
        warnings.push(
          `NetCDF4 trim: could not write dataset '${name}' with deflate ` +
          `level ${writeLevel} (${e.message || e}); written uncompressed, ` +
          `so the output is larger than the source for this variable.`);
        shuffleDropped.delete(name);
        created = dstFile.create_dataset({ name, data: value, shape, dtype, chunks: null });
      }
      const ds = created || dstFile.get(name);
      if (!ds) {
        warnings.push(
          `NetCDF4 trim: dataset '${name}' was written but its handle ` +
          `could not be reopened; attributes not copied.`);
        continue;
      }

      /* Copy portable attributes. h5wasm cannot recreate HDF5 object-reference
       * dimension-scale linkage attrs, and SciWrid Toolkit resolves axes by
       * coordinate names/units instead. */
      const attrs = item.attrs;
      for (const attrName of Object.keys(attrs)) {
        if (HDF5_REFERENCE_ATTRS.has(attrName)) continue;
        try {
          const a = attrs[attrName];
          ds.create_attribute(attrName, a.value, a.shape, a.dtype);
        } catch (e) {
          warnings.push(
            `NetCDF4 trim: attribute '${attrName}' on '${name}' not copied ` +
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
          `NetCDF4 trim: root attribute '${attrName}' not copied ` +
          `(${e.message || e})`);
      }
    }

    if (shuffleDropped.size > 0) {
      const named = [...shuffleDropped].slice(0, 4).join(', ');
      const more  = shuffleDropped.size > 4 ? `, +${shuffleDropped.size - 4} more` : '';
      warnings.push(
        `NetCDF4 trim: deflate was preserved, but HDF5's shuffle pre-filter ` +
        `was not -- h5wasm can write only the gzip filter. Affected: ` +
        `${named}${more}. These datasets re-pack differently from the source ` +
        `(often smaller, sometimes larger), so output size will not match the ` +
        `input even when no variables were dropped.`);
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
