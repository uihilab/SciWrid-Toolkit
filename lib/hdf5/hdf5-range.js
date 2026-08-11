/*
 * lib/hdf5/hdf5-range.js
 *
 * Range-native NetCDF4/HDF5 point extraction. Instead of downloading the whole
 * file, it:
 *   1. reads a small FRONT region and parses the HDF5 metadata with jsfive
 *      (netCDF-C writes the superblock, object headers and chunk B-trees before
 *      the raw data, so a few MB usually covers all metadata; the region grows
 *      on a bounds error and retries),
 *   2. walks the target variable's chunk B-tree to get each chunk's byte
 *      { address, size, filterMask } — a kerchunk-style map,
 *   3. fetches ONLY the chunk(s) covering the requested lat/lon via HTTP Range,
 *   4. decodes them with the existing Zarr codecs (shuffle + zlib/gzip …).
 *
 * Returns the same object shape as the whole-file `extract()` point path, or
 * `null` when the file/layout is unsupported (caller falls back to whole-file).
 *
 * The chunk B-tree (the chunk->byte map) is read at its REAL offset via async
 * Range reads (walkChunkBTreeAsync), so files that store the index deep still
 * work. Object headers + coordinate arrays are read from the small front buffer
 * via jsfive; those must be front-loaded (the common netCDF-C case, within the
 * budget metadataCap() allows) or we fall back. A fully layout-independent
 * version would also pointer-follow the object headers — a follow-up.
 */
import { Hdf5RangeReader } from './range-reader.js';
import { fetchRange, translateUrl } from '../sources/range-fetcher.js';
import { decompressChunk } from '../zarr/decompressors.js';
import { applyFilters } from '../zarr/filters.js';
import { decodeTimes } from '../time-decoder.js';
import { attrsOf } from './dense-attrs.js';

const LAT_NAMES = ['lat', 'latitude', 'nav_lat', 'y', 'Y'];
const LON_NAMES = ['lon', 'longitude', 'nav_lon', 'x', 'X'];
const TIME_NAMES = ['time', 'valid_time', 'Time', 't'];

/* The initial front-buffer read in _parseMetaAndChunks. Shared so the gate in
 * the extractors and the read itself cannot drift apart. */
const FRONT_TARGET = 2 << 20;

/* Share of a file the range path may spend on metadata before giving up.
 *
 * The grow loop is speculative: it enlarges the front buffer until jsfive can
 * parse the headers, and it does not know in advance whether that will ever
 * succeed. When it does not, every one of those bytes is wasted -- the
 * whole-file fallback restarts at byte zero and reuses none of it. So the
 * speculative spend has to be bounded against what giving up will cost.
 *
 * Measured 2026-07-30 on a 32.2 MB GOES-18 ABI file whose metadata jsfive
 * cannot parse at any size: the old flat 16 MB cap spent 16.78 MB discovering
 * that, then the fallback moved 32.22 MB, for 49.00 MB = 152.1% of the file. */
const METADATA_BUDGET = 0.25;

/* How far the metadata grow loop may read for a file of `size` bytes.
 *
 * Three bounds, and each one matters:
 *   - the file itself     -- never read past EOF
 *   - a 16 MB hard cap    -- keeps huge files from a huge speculative read
 *   - METADATA_BUDGET     -- keeps the spend proportional to the fallback cost
 *
 * Floored at FRONT_TARGET because that first read is the price of entry: below
 * it the loop could not even make its initial attempt. Files small enough for
 * that floor to bite are the ones unprofitableBeforeRead() already declines.
 *
 * Exported for .testkit/test-range-profitability.js -- the policy is worth
 * pinning, and pinning it through multi-megabyte downloads is not. */
export function metadataCap(size) {
  return Math.min(size, 16 << 20,
    Math.max(FRONT_TARGET, Math.floor(size * METADATA_BUDGET)));
}

let _jsfiveFile = null;
async function loadJsfive() {
  if (_jsfiveFile) return _jsfiveFile;
  const mod = await import('jsfive');
  _jsfiveFile = (mod.default && mod.default.File) ? mod.default.File : mod.File;
  if (!_jsfiveFile) throw new Error('jsfive File not found');
  return _jsfiveFile;
}

/* dtype string ("<f4","<i2","|u1", ">f8") -> { TA, bytes, littleEndian } */
function dtypeInfo(dt) {
  const m = /^([<>|])([fiu])(\d+)$/.exec(dt);
  if (!m) return null;
  const [, endian, kind, sz] = m;
  const bytes = Number(sz);
  const le = endian !== '>';
  const TA = {
    f4: Float32Array, f8: Float64Array,
    i1: Int8Array, i2: Int16Array, i4: Int32Array,
    u1: Uint8Array, u2: Uint16Array, u4: Uint32Array,
  }[kind + bytes];
  return TA ? { TA, bytes, littleEndian: le } : null;
}

/* Walk an HDF5 v1 raw-data-chunk B-tree by reading each node at its real byte
 * offset via the range reader (a few KB total), so it works even when the
 * B-tree is stored deep in the file — object headers stay on the front buffer,
 * only the index is fetched here. Returns [{ coords, address, size, filterMask }]. */
async function walkChunkBTreeAsync(reader, rootAddr, rank, sizeofOffset = 8) {
  const ndims = rank + 1;                 // HDF5 chunk key carries rank+1 dims
  const keySize = 8 + ndims * 8;          // chunk_size(4)+filter_mask(4)+dims*8
  const hdrSize = 8 + 2 * sizeofOffset;   // sig(4)+type(1)+level(1)+entries(2)+2 siblings
  const out = [];
  const node = async (addr) => {
    const hdr = await reader.read(addr, hdrSize);
    const hv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    const sig = String.fromCharCode(hdr[0], hdr[1], hdr[2], hdr[3]);
    if (sig !== 'TREE') throw new Error('chunk btree: bad signature "' + sig + '"');
    const level = hv.getUint8(5);
    const entries = hv.getUint16(6, true);
    // n entries are laid out as key,child,key,child,... (a trailing key follows,
    // which we don't need). Read the key/child region in one range request.
    const body = await reader.read(addr + hdrSize, entries * (keySize + sizeofOffset));
    const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const children = [];
    let off = 0;
    for (let i = 0; i < entries; i++) {
      const chunkSize = bv.getUint32(off, true);
      const filterMask = bv.getUint32(off + 4, true);
      const coords = [];
      for (let d = 0; d < ndims; d++) coords.push(Number(bv.getBigUint64(off + 8 + d * 8, true)));
      off += keySize;
      const child = Number(bv.getBigUint64(off, true));
      off += sizeofOffset;
      if (level > 0) children.push(child);
      else out.push({ coords: coords.slice(0, rank), address: child, size: chunkSize, filterMask });
    }
    for (const c of children) await node(c);   // recurse internal nodes
  };
  await node(rootAddr);
  return out;
}

function findByName(datasetsByName, names) {
  for (const n of names) if (datasetsByName[n]) return n;
  const lower = Object.keys(datasetsByName).reduce((a, k) => (a[k.toLowerCase()] = k, a), {});
  for (const n of names) if (lower[n.toLowerCase()]) return lower[n.toLowerCase()];
  return null;
}

/* Read a 1-D coordinate dataset's values via jsfive (from the front buffer),
 * validating the length so a truncated front buffer triggers a grow-retry. */
function readCoord(file, name) {
  const ds = file.get(name);
  const val = ds.value;
  const expect = ds.shape.reduce((a, b) => a * b, 1);
  if (!val || val.length !== expect) throw new RangeError('coord "' + name + '" truncated');
  return Float64Array.from(val);
}

function nearestIndex(arr, target) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - target);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/* `tally` accumulates chunk-fetch cost. Chunk reads deliberately do NOT go
 * through Hdf5RangeReader: that reader is 1 MB block-aligned, which is right
 * for the many small seeks of a header walk and badly wrong for a chunk read,
 * where it would round every fetch up to a megabyte. The consequence is that
 * reader.stats() alone undercounts a range extraction by everything that
 * matters, so the caller adds this tally before reporting _stats. */
async function decodeChunk(url, ref, di, filters, fetchImpl, tally) {
  const raw = await fetchRange(url, ref.address, ref.size, fetchImpl);
  if (tally) { tally.requests += 1; tally.bytes += raw.length; }
  let buf = raw;
  if (filters.compressor) buf = await decompressChunk(buf, filters.compressor);
  if (filters.shuffle) buf = await applyFilters(buf, [{ id: 'shuffle', elementsize: filters.shuffleSize }], { bytes: filters.shuffleSize });
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new di.TA(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / di.bytes));
}

/* Decline the range path and say why. Returning null (rather than throwing)
 * keeps every existing caller working: the API layer treats null as "fall back
 * to the whole-file path". opts.diag is optional -- callers that do not pass it
 * simply get the null. */
function decline(opts, reason) {
  if (opts && Array.isArray(opts.diag)) opts.diag.push({ path: 'hdf5-range', reason });
  return null;
}

/* Gate A: is the range path pointless before we have read a single byte?
 *
 * _parseMetaAndChunks opens by reading min(FRONT_TARGET, size), so for any file
 * at or below FRONT_TARGET the metadata read alone pulls essentially the whole
 * body -- and then the chunk fetch pulls much of it AGAIN. Measured on
 * examples/idalia/idalia-nldas2.nc (896459 bytes): 197% of the file moved, for
 * an answer the whole-file path gives at 100%.
 *
 * This MUST run before the front-buffer read, not after. Falling back
 * re-downloads the file, so a gate placed after that read has already spent the
 * bytes and would turn 197% into 200%. Here it costs nothing: `size` comes from
 * a HEAD, which transfers no body. */
function unprofitableBeforeRead(size) {
  return size <= FRONT_TARGET;
}

/* Total range-path cost = the reader's header/coord reads + the chunk reads it
 * never sees. Emitted as `_stats` so that "did the range path run, and what did
 * it cost?" has ONE answer across formats: grib2-range.js reports the same
 * { requests, bytes } shape. `_range: true` stays for existing callers. */
function rangeStats(reader, tally) {
  const s = reader.stats();
  return { requests: s.requests + tally.requests, bytes: s.bytes + tally.bytes };
}

/* Row-major strides within a chunk of shape `chunkShape`. */
function chunkStrides(chunkShape) {
  const rank = chunkShape.length;
  const cstr = new Array(rank);
  cstr[rank - 1] = 1;
  for (let d = rank - 2; d >= 0; d--) cstr[d] = cstr[d + 1] * chunkShape[d + 1];
  return cstr;
}

/* Phase 1 (shared): grow a small FRONT buffer until jsfive parses object headers
 * + coords, then read the chunk B-tree at its real offset. Returns { meta,
 * refByKey } or null (caller falls back). */
async function _parseMetaAndChunks(reader, File, size, variable, fetchImpl, opts) {
  const CAP = metadataCap(size);
  let N = Math.min(FRONT_TARGET, size);
  let meta = null;
  for (;;) {
    let head;
    try { head = await reader.read(0, N); }
    catch (e) { return decline(opts, 'front buffer read failed: ' + String((e && e.message) || e)); }
    const ab = head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength);
    try { meta = _parseFront(File, ab, variable); break; }
    catch (e) {
      if (e && e.__fallback)
        return decline(opts, 'unsupported layout: ' + String((e && e.message) || e));
      if (N < CAP) { N = Math.min(N * 4, CAP); continue; }
      /* Budget exhausted. Say so specifically -- "returned no result" gave no
       * hint that the cost was a speculative metadata read that failed. */
      return decline(opts,
        'metadata not parseable within ' + CAP + ' bytes (' +
        Math.round(100 * METADATA_BUDGET) + '% of a ' + size + ' byte file): ' +
        String((e && e.message) || e));
    }
  }
  let chunkRefs;
  try { chunkRefs = await walkChunkBTreeAsync(reader, meta.chunkAddress, meta.rank); }
  catch (e) { return decline(opts, 'chunk index walk failed: ' + String((e && e.message) || e)); }
  const refByKey = new Map();
  for (const r of chunkRefs) refByKey.set(r.coords.join(','), r);
  return { meta, refByKey };
}

/**
 * hdf5RangePointExtract(url, { variable, lat, lon }, opts) -> result | null
 * result: { variable, grid:{nx,ny,nt}, location:{lat,lon}, timeseries:[{time,value}] }
 */
export async function hdf5RangePointExtract(url, query, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rurl = translateUrl(url);
  const reader = new Hdf5RangeReader(rurl, { fetchImpl });
  const tally = { requests: 0, bytes: 0 };
  const File = await loadJsfive();
  const size = await reader.size();

  if (!opts.forceRange && unprofitableBeforeRead(size))
    return decline(opts,
      'file is ' + size + ' bytes; the range path must read up to ' +
      FRONT_TARGET + ' bytes of metadata before it can fetch anything, so the ' +
      'whole-file path is strictly cheaper');

  const parsed = await _parseMetaAndChunks(reader, File, size, query.variable, fetchImpl, opts);
  if (!parsed) return null;
  const { meta, refByKey } = parsed;
  const { rank, di, filters, chunkShape, lats, lonsRaw, latAxis, lonAxis, nt } = meta;

  // Nearest cell to the query point (lon converted to the file's convention).
  let qlon = query.lon;
  if (lonsRaw[lonsRaw.length - 1] > 180 && qlon < 0) qlon = ((qlon % 360) + 360) % 360;
  const latIdx = nearestIndex(lats, query.lat);
  const lonIdx = nearestIndex(lonsRaw, qlon);

  const cstr = chunkStrides(chunkShape);
  const latBase = Math.floor(latIdx / chunkShape[latAxis]) * chunkShape[latAxis];
  const lonBase = Math.floor(lonIdx / chunkShape[lonAxis]) * chunkShape[lonAxis];
  const ct = rank >= 3 ? chunkShape[0] : 1;

  /* Gate B: marginal. The front buffer is already paid for, and falling back
   * re-downloads the file, so the sunk cost is deliberately EXCLUDED here --
   * continuing costs chunkBytes, falling back costs a fresh `size`. Including
   * the sunk bytes would make this refuse cases where refusing is the more
   * expensive option. */
  {
    const needed = new Set();
    for (let t = 0; t < nt; t++) {
      const tb = rank >= 3 ? Math.floor(t / ct) * ct : 0;
      needed.add((rank >= 3 ? [tb, latBase, lonBase] : [latBase, lonBase]).join(','));
    }
    let chunkBytes = 0;
    for (const key of needed) {
      const ref = refByKey.get(key);
      if (!ref) return decline(opts, 'chunk ' + key + ' missing from the chunk index');
      chunkBytes += ref.size;
    }
    if (!opts.forceRange && chunkBytes >= size)
      return decline(opts,
        'remaining chunk fetches would move ' + chunkBytes + ' bytes of a ' +
        size + ' byte file; whole-file path is cheaper from here');
  }

  const values = new Array(nt);
  const chunkCache = new Map();
  for (let t = 0; t < nt; t++) {
    const tBase = rank >= 3 ? Math.floor(t / ct) * ct : 0;
    const coords = rank >= 3 ? [tBase, latBase, lonBase] : [latBase, lonBase];
    const key = coords.join(',');
    let decoded = chunkCache.get(key);
    if (!decoded) {
      const ref = refByKey.get(key);
      if (!ref) return null;
      try { decoded = await decodeChunk(rurl, ref, di, filters, fetchImpl, tally); }
      catch { return null; }
      chunkCache.set(key, decoded);
    }
    const local = rank >= 3
      ? [t - tBase, latIdx - latBase, lonIdx - lonBase]
      : [latIdx - latBase, lonIdx - lonBase];
    let li = 0;
    for (let d = 0; d < rank; d++) li += local[d] * cstr[d];
    const raw = decoded[li];
    values[t] = (meta.fillValue != null && raw === meta.fillValue) ? NaN : raw;
  }

  /* NaN and null map to null because NaN is not JSON-serialisable and fill
   * values rely on it. The value itself is passed through unchanged: an
   * earlier version rounded to three decimals here, which quantised every
   * range-path reading and produced 100% relative error on small values
   * (0.000111111 -> 0). The whole-file path never rounded, so the two paths
   * disagreed. See .testkit/test-range-parity.js. */
  const clean = (v) => (v == null || Number.isNaN(v)) ? null : v;
  const timeseries = values.map((v, i) => ({
    time: meta.times ? meta.times[i] : null,
    value: clean(v),
  }));

  return {
    variable: meta.varName,
    grid: { nx: meta.shape[lonAxis], ny: meta.shape[latAxis], nt },
    location: { lat: lats[latIdx], lon: lonsRaw[lonIdx] > 180 ? lonsRaw[lonIdx] - 360 : lonsRaw[lonIdx] },
    timeseries,
    _range: true,
    _stats: rangeStats(reader, tally),
    /* Name every field the range path could not produce correctly. Absent when
     * nothing degraded, like _fastPathSkipped. */
    ...(meta.timesUndecoded
      ? { _degraded: [{ field: 'time', reason: meta.timesUndecoded }] }
      : {}),
  };
}

/**
 * hdf5RangeGridExtract(url, { variable, bbox, width, height, time }, opts) -> result | null
 * result: { data: Float32Array(W*H), width, height, bbox, variable, units, time }
 *
 * Fetches only the spatial chunks of the SELECTED timestep, assembles that one
 * timestep's native grid, and resamples it to W×H with the SAME `inlineExtract`
 * the whole-file path uses — so the output is identical, transfer is one
 * timestep's spatial extent (independent of file size / other timesteps / vars).
 */
export async function hdf5RangeGridExtract(url, query, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rurl = translateUrl(url);
  const reader = new Hdf5RangeReader(rurl, { fetchImpl });
  const tally = { requests: 0, bytes: 0 };
  const File = await loadJsfive();
  const size = await reader.size();

  if (!opts.forceRange && unprofitableBeforeRead(size))
    return decline(opts,
      'file is ' + size + ' bytes; the range path must read up to ' +
      FRONT_TARGET + ' bytes of metadata before it can fetch anything, so the ' +
      'whole-file path is strictly cheaper');

  const parsed = await _parseMetaAndChunks(reader, File, size, query.variable, fetchImpl, opts);
  if (!parsed) return null;
  const { meta, refByKey } = parsed;
  const { rank, di, filters, chunkShape, lats, lonsRaw, latAxis, lonAxis, units } = meta;

  const ny = meta.shape[latAxis], nx = meta.shape[lonAxis];
  const fill = meta.fillValue;
  if (!isMonotonic(lats) || !isMonotonic(lonsRaw)) return null;   // resampler needs sorted

  const time = Number.isInteger(query.time) ? query.time : 0;
  const ct = rank >= 3 ? chunkShape[0] : 1;
  const tBase = rank >= 3 ? Math.floor(time / ct) * ct : 0;
  const tl = time - tBase;
  const cstr = chunkStrides(chunkShape);
  const cy = chunkShape[latAxis], cx = chunkShape[lonAxis];

  /* Gate B, over the chunks of the selected timestep only. Sunk front-buffer
   * cost is excluded for the same reason as in the point path. */
  {
    let chunkBytes = 0;
    for (const [key, ref] of refByKey) {
      const coords = key.split(',').map(Number);
      if (rank >= 3 && coords[0] !== tBase) continue;
      chunkBytes += ref.size;
    }
    if (!opts.forceRange && chunkBytes >= size)
      return decline(opts,
        'remaining grid chunk fetches would move ' + chunkBytes + ' bytes of a ' +
        size + ' byte file; whole-file path is cheaper from here');
  }

  // Assemble the selected timestep's native grid from its spatial chunks.
  const sliceData = new Float32Array(ny * nx);
  for (const [key, ref] of refByKey) {
    const coords = key.split(',').map(Number);
    if (rank >= 3 && coords[0] !== tBase) continue;         // other time-chunks
    let decoded;
    try { decoded = await decodeChunk(rurl, ref, di, filters, fetchImpl, tally); }
    catch { return null; }
    const cLat = coords[latAxis], cLon = coords[lonAxis];
    for (let ly = 0; ly < cy; ly++) {
      const gy = cLat + ly;
      if (gy >= ny) break;
      const rowBase = (rank >= 3 ? tl * cstr[0] + ly * cstr[latAxis] : ly * cstr[latAxis]);
      for (let lx = 0; lx < cx; lx++) {
        const gx = cLon + lx;
        if (gx >= nx) break;
        const v = decoded[rowBase + lx * cstr[lonAxis]];
        sliceData[gy * nx + gx] = (fill != null && v === fill) ? NaN : v;   // fill -> NaN
      }
    }
  }

  // Resample with the SAME code path as the whole-file grid export.
  const latsAscending = lats[0] < lats[ny - 1];
  const lonsAscending = lonsRaw[0] < lonsRaw[nx - 1];
  const lonRange = lonsAscending ? [lonsRaw[0], lonsRaw[nx - 1]] : [lonsRaw[nx - 1], lonsRaw[0]];
  const { inlineExtract } = await import('../../worker/loader.js');
  const data = inlineExtract(
    { lats, lons: lonsRaw, data: sliceData, nx, latsAscending, lonsAscending,
      lonRange, bbox: query.bbox, width: query.width, height: query.height });

  return {
    data, width: query.width, height: query.height, bbox: query.bbox,
    variable: meta.varName, units: units || '', time, _range: true,
    _stats: rangeStats(reader, tally),
  };
}

function isMonotonic(a) {
  if (a.length < 2) return true;
  const inc = a[1] > a[0];
  for (let i = 2; i < a.length; i++) if ((a[i] > a[i - 1]) !== inc) return false;
  return true;
}

/* Parse the variable's raw metadata + coordinate axes from the front buffer
 * (jsfive). Does NOT read the chunk B-tree or raw data. Throws a RangeError when
 * the front buffer is too small (caller grows), or `__fallback = true` for a
 * definitively unsupported layout. */
function _parseFront(File, ab, variable) {
  const f = new File(ab, 'remote.nc');

  const byName = {};
  for (const key of f.keys) {
    const o = f.get(key);
    if (o && o.constructor && o.constructor.name === 'Dataset') byName[key] = o;
    else { const err = new Error('groups unsupported'); err.__fallback = true; throw err; }
  }

  const varName = variable || Object.keys(byName).find(
    (k) => byName[k].shape && byName[k].shape.length >= 2);
  const ds = byName[varName];
  if (!ds) { const e = new Error('variable not found'); e.__fallback = true; throw e; }

  const shape = ds.shape;
  const di = dtypeInfo(ds.dtype);
  if (!di || shape.length < 2) { const e = new Error('unsupported dtype/shape'); e.__fallback = true; throw e; }

  const dob = ds._dataobjects;
  dob._get_chunk_params();
  const chunkShape = dob._chunks;
  if (!chunkShape || dob._chunk_address == null) { const e = new Error('not chunked'); e.__fallback = true; throw e; }

  // Filter pipeline (Maps): deflate (id 1) -> zlib; shuffle (id 2).
  const fp = dob.filter_pipeline || [];
  const filters = { compressor: null, shuffle: false, shuffleSize: di.bytes };
  for (const entry of fp) {
    const id = entry && entry.get ? entry.get('filter_id') : (entry && entry.filter_id);
    const cd = entry && entry.get ? entry.get('client_data') : (entry && entry.client_data);
    if (id === 1) filters.compressor = { id: 'zlib' };
    else if (id === 2) { filters.shuffle = true; if (cd && cd[0]) filters.shuffleSize = cd[0]; }
    else if (id === 3) { /* fletcher32 checksum — decode ignores it */ }
    else { const e = new Error('unsupported filter ' + id); e.__fallback = true; throw e; }
  }

  const latName = findByName(byName, LAT_NAMES);
  const lonName = findByName(byName, LON_NAMES);
  if (!latName || !lonName) { const e = new Error('no lat/lon'); e.__fallback = true; throw e; }
  const lats = readCoord(f, latName);
  const lonsRaw = readCoord(f, lonName);

  const rank = shape.length;
  const nt = rank >= 3 ? shape[0] : 1;
  const timeName = findByName(byName, TIME_NAMES);
  let times = null;
  let timesUndecoded = null;
  if (rank >= 3 && timeName && byName[timeName]) {
    const traw = readCoord(f, timeName);
    const tattrs = attrsOf(f.get(timeName));
    /* decodeTimes returns { values, unitsRaw, calendar } -- an OBJECT. Indexing
     * it as an array yielded undefined for every step, which JSON.stringify
     * then omitted entirely, so the `time` key silently vanished from the range
     * result while the whole-file result carried it.
     *
     * When it throws we record the reason and leave `times` null, so the caller
     * emits time: null. An earlier fallback stringified the raw values,
     * producing "391440" where the whole-file path produces
     * "2023-08-28T00:00:00Z" -- indistinguishable from a real timestamp to
     * anything downstream.
     *
     * `units` reaches us here only because attrsOf() reads HDF5 dense attribute
     * storage, which jsfive does not; see lib/hdf5/dense-attrs.js. Files whose
     * attributes it still cannot reach fall through to the catch and are
     * reported as _degraded rather than guessed at. */
    try {
      times = decodeTimes(traw, tattrs.units,
                          tattrs.calendar || 'standard').values;
    } catch (e) {
      times = null;
      timesUndecoded = 'time units are not readable from this file (' +
        String((e && e.message) || e) + ')';
    }
  }

  const vattrs = attrsOf(ds);
  return {
    varName, shape, di, filters, chunkShape, chunkAddress: dob._chunk_address, rank,
    latAxis: rank - 2, lonAxis: rank - 1, lats, lonsRaw, times, timesUndecoded, nt,
    units: vattrs.units || '',
    fillValue: (dob.fillvalue == null ? null : Number(dob.fillvalue)),   // HDF5 fill message
  };
}
