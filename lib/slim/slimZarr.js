/*
 * lib/slim/zarr.js
 *
 * Zarr v2 (zip-of-zarr) slim — zip-entry filter, no decode.
 *
 * Strategy:
 *   1. Walk the source ZIP's central directory to enumerate every entry
 *      with its raw byte span (compressed payload preserved verbatim).
 *   2. For each requested variable, parse <var>/.zarray + <var>/.zattrs
 *      to learn the chunk grid and which axis is "time" (heuristic:
 *      look at _ARRAY_DIMENSIONS for a name in {'time','t','Time'};
 *      fall back to axis 0).
 *   3. Decide which chunks to keep:
 *        - No t1/t2: all chunks
 *        - With t1/t2: every chunk whose time extent intersects
 *          [t1, t2+1). Boundary-widening (kept range may extend to chunk
 *          boundaries) is surfaced in result.warnings.
 *   4. Re-emit a new ZIP containing: .zgroup, top-level .zattrs (if any),
 *      and for each kept variable its .zarray + .zattrs + selected chunks.
 *      Entry method (stored=0 / deflate=8) is preserved per-entry — no
 *      recompression.
 *
 * CRC-32 is set to 0 for stored entries; the existing zarr-helper readZip
 * also ignores CRC, mirroring the project's existing buildZip convention
 * in scripts/test-zarr.js.
 *
 * Out of scope (v1): spatial bbox slicing; partial-chunk extraction along
 * the time axis (which would require decode + re-encode). Both deferred.
 */

import { SlimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';
import { inflateRaw } from '../zarr/decompressors.js';

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG   = 0x02014b50;

/* ── ZIP walker — returns raw byte spans, no decompression ─────────────── */

function findEOCD(data) {
  const dv  = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const min = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD_SIG) return i;
  }
  throw new SlimError('Zarr slim: not a ZIP file (no EOCD found)');
}

/**
 * Returns an array of { name, method, compSize, uncompSize, dataOff }.
 * dataOff is the absolute byte offset of the entry's compressed payload
 * within `data`. compSize bytes starting at dataOff are the raw stream.
 */
function parseZipEntries(data) {
  const dv      = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd    = findEOCD(data);
  const nEntry  = dv.getUint16(eocd + 10, true);
  const cdSize  = dv.getUint32(eocd + 12, true);
  const cdOff   = dv.getUint32(eocd + 16, true);

  const dec = new TextDecoder();
  const out = [];
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  for (let i = 0; i < nEntry && p < cdEnd; i++) {
    if (dv.getUint32(p, true) !== ZIP_CD_SIG)
      throw new SlimError(`Zarr slim: corrupt central directory at ${p}`);
    const method     = dv.getUint16(p + 10, true);
    const compSize   = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen    = dv.getUint16(p + 28, true);
    const extraLen   = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localHdr   = dv.getUint32(p + 42, true);
    const name       = dec.decode(data.subarray(p + 46, p + 46 + nameLen));

    /* Skip into the local header to find the actual data offset (local
     * header sizes can differ from CD entries because of extra fields). */
    if (dv.getUint32(localHdr, true) !== 0x04034b50)
      throw new SlimError(
        `Zarr slim: corrupt local header for entry '${name}' at ${localHdr}`);
    const lhNameLen  = dv.getUint16(localHdr + 26, true);
    const lhExtraLen = dv.getUint16(localHdr + 28, true);
    const dataOff    = localHdr + 30 + lhNameLen + lhExtraLen;

    out.push({ name, method, compSize, uncompSize, dataOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ── ZIP writer — preserves per-entry method, no recompression ───────────
 *
 * Two entry shapes are accepted:
 *   Passthrough: { name, method, compSize, uncompSize, dataOff }   ← from parseZipEntries
 *   Synthetic:   { name, bytes }   ← method assumed to be 0 (stored)
 * Synthetic entries are used when we have to emit a freshly built file
 * (e.g. a rewritten .zarray with the slimmed shape).
 * ----------------------------------------------------------------------- */

function writeZip(entries, sourceData) {
  const enc        = new TextEncoder();
  const localParts = [];
  const cdParts    = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes  = enc.encode(e.name);
    const method     = e.bytes ? 0 : e.method;
    const compSize   = e.bytes ? e.bytes.length : e.compSize;
    const uncompSize = e.bytes ? e.bytes.length : e.uncompSize;
    const payload    = e.bytes
                     ? e.bytes
                     : sourceData.subarray(e.dataOff, e.dataOff + e.compSize);

    /* Local file header (30B + name) */
    const lh   = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0,  0x04034b50, true);
    lhDV.setUint16(4,  20, true);
    lhDV.setUint16(6,  0,  true);
    lhDV.setUint16(8,  method, true);
    lhDV.setUint16(10, 0,  true);
    lhDV.setUint16(12, 0,  true);
    lhDV.setUint32(14, 0,  true);            /* CRC=0 (reader ignores) */
    lhDV.setUint32(18, compSize,   true);
    lhDV.setUint32(22, uncompSize, true);
    lhDV.setUint16(26, nameBytes.length, true);
    lhDV.setUint16(28, 0,  true);
    lh.set(nameBytes, 30);
    localParts.push(lh, payload);

    /* Central directory entry (46B + name) */
    const cd   = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0,  0x02014b50, true);
    cdDV.setUint16(4,  20, true);
    cdDV.setUint16(6,  20, true);
    cdDV.setUint16(8,  0,  true);
    cdDV.setUint16(10, method, true);
    cdDV.setUint16(12, 0,  true);
    cdDV.setUint16(14, 0,  true);
    cdDV.setUint32(16, 0,  true);
    cdDV.setUint32(20, compSize,   true);
    cdDV.setUint32(24, uncompSize, true);
    cdDV.setUint16(28, nameBytes.length, true);
    cdDV.setUint16(30, 0,  true);
    cdDV.setUint16(32, 0,  true);
    cdDV.setUint16(34, 0,  true);
    cdDV.setUint16(36, 0,  true);
    cdDV.setUint32(38, 0,  true);
    cdDV.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + payload.length;
  }

  /* Re-thread: keep the unused-binding lint quiet in case sourceData isn't
   * referenced (when every entry is synthetic). */
  void sourceData;

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0,  0x06054b50, true);
  eocdDV.setUint16(4,  0, true);
  eocdDV.setUint16(6,  0, true);
  eocdDV.setUint16(8,  entries.length, true);
  eocdDV.setUint16(10, entries.length, true);
  eocdDV.setUint32(12, cdSize, true);
  eocdDV.setUint32(16, cdOffset, true);
  eocdDV.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of cdParts)    { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

/* ── Helpers to decode small JSON entries (zarray/zattrs) ───────────────── */

/**
 * Return an entry's uncompressed bytes. Stored entries are views into the
 * source buffer; deflate entries are inflated via the isomorphic raw-inflate.
 */
async function readEntryBytes(data, entry) {
  const raw = data.subarray(entry.dataOff, entry.dataOff + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw, entry.uncompSize);
  throw new SlimError(
    `Zarr slim: entry '${entry.name}' uses unsupported ZIP compression ` +
    `method ${entry.method} (only stored=0 and deflate=8 are supported).`);
}

async function readEntryUtf8(data, entry) {
  return new TextDecoder().decode(await readEntryBytes(data, entry));
}

/* ── Variable / chunk identification ────────────────────────────────────── */

/**
 * Group entries into variables. A "variable" is any path segment that has
 * a `<name>/.zarray` entry. Returns:
 *   {
 *     topLevel:  Entry[]   (e.g. .zgroup, top-level .zattrs)
 *     vars: Map<name, { zarray, zattrs, chunks: Entry[] }>
 *   }
 */
function groupEntries(entries) {
  const topLevel = [];
  const vars     = new Map();

  for (const e of entries) {
    const slash = e.name.indexOf('/');
    if (slash < 0) { topLevel.push(e); continue; }

    const varName = e.name.slice(0, slash);
    const subPath = e.name.slice(slash + 1);
    if (!vars.has(varName))
      vars.set(varName, { zarray: null, zattrs: null, chunks: [] });
    const v = vars.get(varName);
    if      (subPath === '.zarray') v.zarray = e;
    else if (subPath === '.zattrs') v.zattrs = e;
    else                            v.chunks.push(e);
  }

  /* Drop "variables" that don't actually have a .zarray (e.g. sub-groups). */
  for (const [name, v] of vars.entries())
    if (!v.zarray) vars.delete(name);

  return { topLevel, vars };
}

/**
 * Determine the time-axis position for a Zarr variable, defaulting to 0.
 * Looks at the .zattrs `_ARRAY_DIMENSIONS` field if present.
 */
function timeAxisIndex(zattrsObj) {
  const dims = zattrsObj && zattrsObj._ARRAY_DIMENSIONS;
  if (!Array.isArray(dims)) return 0;
  for (let i = 0; i < dims.length; i++) {
    const d = String(dims[i] ?? '').toLowerCase();
    if (d === 'time' || d === 't') return i;
  }
  return 0;
}

/**
 * Parse a chunk key like "3.0.5" or "3/0/5" into a numeric index array.
 * The separator comes from the zarray's dimension_separator (default '.').
 */
/**
 * Resolve a lat/lon (or alias) dim index from `_ARRAY_DIMENSIONS`. Returns -1
 * when not present.
 */
function findDimIndex(zattrsObj, aliases) {
  const dims = zattrsObj && zattrsObj._ARRAY_DIMENSIONS;
  if (!Array.isArray(dims)) return -1;
  for (let i = 0; i < dims.length; i++) {
    const d = String(dims[i] ?? '').toLowerCase();
    if (aliases.includes(d)) return i;
  }
  return -1;
}

const LAT_ALIASES = ['latitude', 'lat', 'y'];
const LON_ALIASES = ['longitude', 'lon', 'x'];

/**
 * Decode a single-chunk 1-D coord array (uncompressed Float32/Float64/Int*)
 * into a JS array. Returns null if the array is multi-chunk, compressed, or
 * has an unsupported dtype — caller falls back to "no bbox slim possible".
 */
async function decodeSingleChunkCoord(data, vars, name) {
  const v = vars.get(name);
  if (!v) return null;
  const zarrayBytes = await readEntryUtf8(data, v.zarray);
  const meta = JSON.parse(zarrayBytes);
  if (!Array.isArray(meta.shape) || meta.shape.length !== 1) return null;
  if (Array.isArray(meta.chunks) && meta.chunks[0] !== meta.shape[0]) return null;   // multi-chunk
  if (meta.compressor && meta.compressor.id) return null;        // skip compressed coords
  if (Array.isArray(meta.filters) && meta.filters.length) return null;
  if (v.chunks.length !== 1) return null;
  const chunkEntry = v.chunks[0];
  // Read uncompressed chunk bytes and copy into an aligned buffer.
  const src = await readEntryBytes(data, chunkEntry);
  const aligned = src.slice();
  const dtype = String(meta.dtype || '');
  const N = meta.shape[0];
  let arr;
  if (/^[<|]f4$/.test(dtype)) arr = new Float32Array(aligned.buffer, 0, N);
  else if (/^[<|]f8$/.test(dtype)) arr = new Float64Array(aligned.buffer, 0, N);
  else if (/^[<|][iu][12]$/.test(dtype)) {
    const Ctor = /^[<|]i2$/.test(dtype) ? Int16Array : /^[<|]u2$/.test(dtype) ? Uint16Array
               : /^[<|]i1$/.test(dtype) ? Int8Array : Uint8Array;
    arr = new Ctor(aligned.buffer, 0, N);
  }
  else return null;
  // Copy to plain array to detach from the underlying ZIP buffer.
  return Array.from(arr);
}

/**
 * Find the inclusive [lo, hi] pixel-index range covering [valLo, valHi] in
 * a monotonic 1-D coord array. Returns null if no overlap.
 */
function indicesCovering(coord, valLo, valHi) {
  if (coord.length === 0) return null;
  const ascending = coord[coord.length - 1] >= coord[0];
  let lo = 0, hi = coord.length - 1;
  if (ascending) {
    while (lo < coord.length && coord[lo] < valLo) lo++;
    while (hi >= 0 && coord[hi] > valHi) hi--;
    if (lo > hi) return null;
  } else {
    // descending — e.g. latitude that runs north→south
    while (lo < coord.length && coord[lo] > valHi) lo++;
    while (hi >= 0 && coord[hi] < valLo) hi--;
    if (lo > hi) return null;
  }
  return [lo, hi];
}

function parseChunkKey(key, sep) {
  const parts = key.split(sep);
  const out   = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (!Number.isFinite(n)) return null;   /* bail; treat as non-chunk */
    out[i] = n;
  }
  return out;
}

/**
 * Compute per-axis chunk cuts for a data variable given the requested time
 * slice and/or bbox. Cut extents widen to chunk boundaries.
 */
function computeAxisCuts(name, zarray, zattrs, ctx, warnings) {
  const { haveT, haveBbox, t1, opts, bboxLatCoord, bboxLonCoord } = ctx;
  const chunks = zarray.chunks, shape = zarray.shape;
  const axisCuts = [];

  if (haveT) {
    const tAxis  = timeAxisIndex(zattrs);
    const tChunk = chunks[tAxis];
    const tLen   = shape[tAxis];
    const t2     = opts.t2 != null ? opts.t2 : (tLen - 1);
    if (t1 >= tLen)
      throw new SlimError(`Zarr slim: t1=${t1} >= time axis length (${tLen}) for variable '${name}'`);
    const tLoReq = Math.max(0, t1);
    const tHiReq = Math.min(tLen - 1, t2);
    const cLo = Math.floor(tLoReq / tChunk);
    const cHi = Math.floor(tHiReq / tChunk);
    const eLo = cLo * tChunk;
    const eHi = Math.min(tLen - 1, (cHi + 1) * tChunk - 1);
    if (eLo !== tLoReq || eHi !== tHiReq)
      warnings.push(`Zarr variable '${name}': time range [${tLoReq},${tHiReq}] widened to [${eLo},${eHi}] (chunk size ${tChunk})`);
    const newLen = Math.min(tLen - eLo, (cHi - cLo + 1) * tChunk);
    axisCuts.push({ axis: tAxis, chunkLo: cLo, chunkHi: cHi, newLen });
  }

  if (haveBbox) {
    const latAxis = findDimIndex(zattrs, LAT_ALIASES);
    const lonAxis = findDimIndex(zattrs, LON_ALIASES);
    if (latAxis < 0 || lonAxis < 0)
      throw new SlimError(`Zarr slim: variable '${name}' has no lat/lon axis in _ARRAY_DIMENSIONS — bbox cannot be applied`);
    const [minLon, minLat, maxLon, maxLat] = opts.bbox;
    const latIdx = indicesCovering(bboxLatCoord, minLat, maxLat);
    const lonIdx = indicesCovering(bboxLonCoord, minLon, maxLon);
    if (!latIdx || !lonIdx)
      throw new SlimError(`Zarr slim: bbox does not intersect variable '${name}' lat/lon extent`);
    for (const [axis, [pixLo, pixHi]] of [[latAxis, latIdx], [lonAxis, lonIdx]]) {
      const ch  = chunks[axis];
      const len = shape[axis];
      const cLo = Math.floor(pixLo / ch);
      const cHi = Math.floor(pixHi / ch);
      const eLo = cLo * ch;
      const eHi = Math.min(len - 1, (cHi + 1) * ch - 1);
      if (eLo !== pixLo || eHi !== pixHi)
        warnings.push(`Zarr variable '${name}': bbox axis ${axis} [${pixLo},${pixHi}] widened to [${eLo},${eHi}] (chunk size ${ch})`);
      const newLen = Math.min(len - eLo, (cHi - cLo + 1) * ch);
      axisCuts.push({ axis, chunkLo: cLo, chunkHi: cHi, newLen });
    }
  }

  return axisCuts;
}

/**
 * Decode a single-chunk 1-D coordinate array's raw element bytes so it can be
 * precisely re-sliced. Returns null when the array cannot be cheaply re-sliced.
 */
async function decodeCoordRaw(data, v) {
  const meta = JSON.parse(await readEntryUtf8(data, v.zarray));
  if (!Array.isArray(meta.shape) || meta.shape.length !== 1) return null;
  if (Array.isArray(meta.chunks) && meta.chunks[0] !== meta.shape[0]) return null;
  if (meta.compressor && meta.compressor.id) return null;
  if (Array.isArray(meta.filters) && meta.filters.length) return null;
  if (v.chunks.length !== 1) return null;
  const dm = /^[<|>]([fiu])(\d+)$/.exec(String(meta.dtype || ''));
  if (!dm) return null;
  const bpe = parseInt(dm[2], 10);
  const N   = meta.shape[0];
  const src = await readEntryBytes(data, v.chunks[0]);
  if (src.length < N * bpe) return null;
  return { meta, bpe, N, raw: src.slice(0, N * bpe) };
}

/* ── Main entry point ───────────────────────────────────────────────────── */

async function loadAll(byteSource) {
  const size = await byteSource.size();
  return byteSource.read(0, size);
}

export async function slim(byteSource, opts /*, ctx */) {
  const data    = await loadAll(byteSource);
  const entries = parseZipEntries(data);
  const { topLevel, vars: allVars } = groupEntries(entries);

  /* Validate requested variables. */
  const requested = new Set(opts.variables);
  const missing   = opts.variables.filter(v => !allVars.has(v));
  if (missing.length === opts.variables.length)
    throw new VariableNotFoundError(
      `Zarr slim: none of the requested variables are present ` +
      `(requested: ${opts.variables.join(', ')}; ` +
      `available: ${[...allVars.keys()].join(', ')})`);
  if (missing.length > 0)
    throw new VariableNotFoundError(
      `Zarr slim: variable(s) not found: ${missing.join(', ')}`);

  const haveT   = opts.t1 != null || opts.t2 != null;
  const t1      = opts.t1 ?? 0;
  const haveBbox = Array.isArray(opts.bbox) && opts.bbox.length === 4;
  const enc     = new TextEncoder();

  // Pre-decode lat/lon coord arrays if a bbox is present.
  // We resolve them lazily (caller may pass bbox even when no coord arrays
  // exist; in that case we throw with a clear message).
  let bboxLatCoord = null, bboxLonCoord = null;
  if (haveBbox) {
    // Discover the coord-array names by scanning data-var .zattrs for
    // _ARRAY_DIMENSIONS, taking the first non-time/non-x dim as lat, etc.
    // Simpler: try each LAT_ALIASES / LON_ALIASES name as a sibling array.
    for (const name of LAT_ALIASES) {
      bboxLatCoord = await decodeSingleChunkCoord(data, allVars, name);
      if (bboxLatCoord) break;
    }
    for (const name of LON_ALIASES) {
      bboxLonCoord = await decodeSingleChunkCoord(data, allVars, name);
      if (bboxLonCoord) break;
    }
    if (!bboxLatCoord || !bboxLonCoord)
      throw new SlimError(
        'Zarr slim: bbox requires single-chunk uncompressed 1-D lat/lon coord ' +
        'arrays. None found in this store.');
  }

  /* Build the output entry list. Each entry is either:
   *   - a passthrough entry (one of the parsed source entries, by reference), or
   *   - a synthetic entry { name, bytes } for rewritten .zarray files. */
  const passthrough = new Set();     /* source entries to copy verbatim */
  const synthetic   = [];            /* { name, bytes, sourceOrder } */
  const renameMap   = new Map();     /* sourceEntry → newName */
  const warnings    = [];

  for (const e of topLevel) passthrough.add(e);

  /* Auto-include coordinate arrays referenced by requested data variables.
   * Without these sibling arrays, scan/extract can re-open the slimmed store
   * but lose geospatial/time axis fidelity. */
  const effectiveRequested = new Set(requested);
  for (const [name, v] of allVars.entries()) {
    if (!requested.has(name) || !v.zattrs) continue;
    const zattrs = JSON.parse(await readEntryUtf8(data, v.zattrs));
    const dims = zattrs && zattrs._ARRAY_DIMENSIONS;
    if (!Array.isArray(dims)) continue;
    for (const dim of dims) {
      const dimName = String(dim ?? '');
      if (allVars.has(dimName)) effectiveRequested.add(dimName);
    }
  }

  const dimExtent = new Map();   /* dimension name -> [lo, hi] inclusive */
  const ctx = { haveT, haveBbox, t1, opts, bboxLatCoord, bboxLonCoord };
  for (const name of requested) {
    const v = allVars.get(name);
    const zarray = JSON.parse(await readEntryUtf8(data, v.zarray));
    const zattrs = v.zattrs ? JSON.parse(await readEntryUtf8(data, v.zattrs)) : {};
    if ((!haveT && !haveBbox) || !Array.isArray(zarray.chunks) ||
        !Array.isArray(zarray.shape) || zarray.chunks.length === 0) continue;
    const cuts = computeAxisCuts(name, zarray, zattrs, ctx, []);
    const dims = Array.isArray(zattrs._ARRAY_DIMENSIONS) ? zattrs._ARRAY_DIMENSIONS : [];
    for (const c of cuts) {
      const dn = String(dims[c.axis] ?? '');
      const lo = c.chunkLo * zarray.chunks[c.axis];
      const hi = lo + c.newLen - 1;
      if (dimExtent.has(dn)) {
        const [l0, h0] = dimExtent.get(dn);
        dimExtent.set(dn, [Math.min(l0, lo), Math.max(h0, hi)]);
      } else {
        dimExtent.set(dn, [lo, hi]);
      }
    }
  }

  for (const [name, v] of allVars.entries()) {
    if (!effectiveRequested.has(name)) continue;
    const autoIncluded = !requested.has(name);

    /* zattrs: always pass through unchanged. */
    if (v.zattrs) passthrough.add(v.zattrs);

    const zarray = JSON.parse(await readEntryUtf8(data, v.zarray));
    const zattrs = v.zattrs ? JSON.parse(await readEntryUtf8(data, v.zattrs)) : {};
    const sep    = zarray.dimension_separator || '.';
    const chunks = zarray.chunks;
    const shape  = zarray.shape;
    const dims   = Array.isArray(zattrs._ARRAY_DIMENSIONS) ? zattrs._ARRAY_DIMENSIONS : [];
    const coordDim = Array.isArray(shape) && shape.length === 1
      ? (dims.length ? String(dims[0]) : name)
      : null;

    if (coordDim != null && dimExtent.has(coordDim)) {
      const [lo, hi] = dimExtent.get(coordDim);
      const decoded  = await decodeCoordRaw(data, v);
      if (!decoded) {
        warnings.push(
          `Zarr coordinate '${name}': could not be re-sliced (multi-chunk or ` +
          `compressed); kept at full length — its axis may be longer than the ` +
          `sliced data.`);
        passthrough.add(v.zarray);
        for (const c of v.chunks) passthrough.add(c);
        continue;
      }
      const clampHi   = Math.min(hi, decoded.N - 1);
      const newN      = clampHi - lo + 1;
      const sliced    = decoded.raw.slice(lo * decoded.bpe, (clampHi + 1) * decoded.bpe);
      const newZarray = { ...decoded.meta, shape: [newN], chunks: [newN], compressor: null };
      synthetic.push({
        name: v.zarray.name,
        bytes: enc.encode(JSON.stringify(newZarray)),
        sourceOrder: entries.indexOf(v.zarray),
      });
      synthetic.push({
        name: v.chunks[0].name,
        bytes: sliced,
        sourceOrder: entries.indexOf(v.chunks[0]),
      });
      continue;
    }

    /* No slicing requested OR shape too odd to slice → keep .zarray + all chunks verbatim. */
    if ((!haveT && !haveBbox) || !Array.isArray(chunks) || !Array.isArray(shape) ||
        chunks.length === 0) {
      passthrough.add(v.zarray);
      for (const c of v.chunks) passthrough.add(c);
      continue;
    }

    // ── Collect per-axis cuts ──────────────────────────────────────────
    // axisCuts: { axis, chunkLo, chunkHi, newLen }
    const axisCuts = [];

    if (haveT && !autoIncluded) {
      const tAxis  = timeAxisIndex(zattrs);
      const tChunk = chunks[tAxis];
      const tLen   = shape[tAxis];
      const t2     = opts.t2 != null ? opts.t2 : (tLen - 1);
      if (t1 >= tLen)
        throw new SlimError(`Zarr slim: t1=${t1} >= time axis length (${tLen}) for variable '${name}'`);
      const tLoReq = Math.max(0, t1);
      const tHiReq = Math.min(tLen - 1, t2);
      const cLo = Math.floor(tLoReq / tChunk);
      const cHi = Math.floor(tHiReq / tChunk);
      const eLo = cLo * tChunk;
      const eHi = Math.min(tLen - 1, (cHi + 1) * tChunk - 1);
      if (eLo !== tLoReq || eHi !== tHiReq)
        warnings.push(`Zarr variable '${name}': time range [${tLoReq},${tHiReq}] widened to [${eLo},${eHi}] (chunk size ${tChunk})`);
      const newLen = Math.min(tLen - eLo, (cHi - cLo + 1) * tChunk);
      axisCuts.push({ axis: tAxis, chunkLo: cLo, chunkHi: cHi, newLen });
    }

    if (haveBbox) {
      const latAxis = findDimIndex(zattrs, LAT_ALIASES);
      const lonAxis = findDimIndex(zattrs, LON_ALIASES);
      if (autoIncluded && latAxis < 0 && lonAxis < 0) {
        passthrough.add(v.zarray);
        for (const c of v.chunks) passthrough.add(c);
        continue;
      }
      if (!autoIncluded && (latAxis < 0 || lonAxis < 0))
        throw new SlimError(`Zarr slim: variable '${name}' has no lat/lon axis in _ARRAY_DIMENSIONS — bbox cannot be applied`);
      const [minLon, minLat, maxLon, maxLat] = opts.bbox;
      const latIdx = indicesCovering(bboxLatCoord, minLat, maxLat);
      const lonIdx = indicesCovering(bboxLonCoord, minLon, maxLon);
      if (!latIdx || !lonIdx)
        throw new SlimError(`Zarr slim: bbox does not intersect variable '${name}' lat/lon extent`);
      const bboxCuts = [];
      if (latAxis >= 0) bboxCuts.push([latAxis, latIdx]);
      if (lonAxis >= 0) bboxCuts.push([lonAxis, lonIdx]);
      for (const [axis, [pixLo, pixHi]] of bboxCuts) {
        const ch  = chunks[axis];
        const len = shape[axis];
        const cLo = Math.floor(pixLo / ch);
        const cHi = Math.floor(pixHi / ch);
        const eLo = cLo * ch;
        const eHi = Math.min(len - 1, (cHi + 1) * ch - 1);
        if (eLo !== pixLo || eHi !== pixHi)
          warnings.push(`Zarr variable '${name}': bbox axis ${axis} [${pixLo},${pixHi}] widened to [${eLo},${eHi}] (chunk size ${ch})`);
        const newLen = Math.min(len - eLo, (cHi - cLo + 1) * ch);
        axisCuts.push({ axis, chunkLo: cLo, chunkHi: cHi, newLen });
      }
    }

    // Did anything actually shrink?
    const shrunk = axisCuts.some(c => {
      const origCount = Math.ceil(shape[c.axis] / chunks[c.axis]);
      const keptCount = c.chunkHi - c.chunkLo + 1;
      return keptCount < origCount;
    });

    if (!shrunk) {
      passthrough.add(v.zarray);
      for (const c of v.chunks) passthrough.add(c);
      continue;
    }

    // Rewrite .zarray with new shape + emit kept chunks with rebased indices.
    const newShape = shape.slice();
    for (const c of axisCuts) newShape[c.axis] = c.newLen;
    const newZarray = { ...zarray, shape: newShape };
    synthetic.push({
      name:  v.zarray.name,
      bytes: enc.encode(JSON.stringify(newZarray)),
      sourceOrder: entries.indexOf(v.zarray),
    });

    const cutByAxis = new Map(axisCuts.map(c => [c.axis, c]));
    for (const c of v.chunks) {
      const subPath = c.name.slice(name.length + 1);
      const idx     = parseChunkKey(subPath, sep);
      if (!idx || idx.length !== chunks.length) continue;
      let keep = true;
      for (const cut of axisCuts) {
        if (idx[cut.axis] < cut.chunkLo || idx[cut.axis] > cut.chunkHi) { keep = false; break; }
      }
      if (!keep) continue;

      const newIdx = idx.slice();
      for (const cut of axisCuts) newIdx[cut.axis] = idx[cut.axis] - cut.chunkLo;
      const newName = name + '/' + newIdx.join(sep);
      if (newName === c.name) {
        passthrough.add(c);
      } else {
        renameMap.set(c, newName);
        passthrough.add(c);
      }
    }

    // For coord arrays: their slim happens through their own iteration (each
    // coord is its own "variable" with _ARRAY_DIMENSIONS).
    // We don't need to special-case here.
  }

  /* Compose final entry list in stable original CD order. */
  const ordered = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    /* Synthetic entry takes precedence (e.g. rewritten .zarray). */
    const syn = synthetic.find(s => s.sourceOrder === i);
    if (syn) { ordered.push({ name: syn.name, bytes: syn.bytes }); continue; }
    if (!passthrough.has(e)) continue;
    if (renameMap.has(e))
      ordered.push({ ...e, name: renameMap.get(e) });
    else
      ordered.push(e);
  }

  const bytes = writeZip(ordered, data);
  return {
    bytes,
    warnings,
    variablesKept:    effectiveRequested.size,
    variablesDropped: allVars.size - effectiveRequested.size,
  };
}
