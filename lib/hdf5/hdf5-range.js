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
 * via jsfive; those must be front-loaded (the common netCDF-C case, within a
 * 16 MB cap) or we fall back. A fully layout-independent version would also
 * pointer-follow the object headers — a follow-up.
 */
import { Hdf5RangeReader } from './range-reader.js';
import { fetchRange, translateUrl } from '../sources/range-fetcher.js';
import { decompressChunk } from '../zarr/decompressors.js';
import { applyFilters } from '../zarr/filters.js';
import { decodeTimes } from '../time-decoder.js';

const LAT_NAMES = ['lat', 'latitude', 'nav_lat', 'y', 'Y'];
const LON_NAMES = ['lon', 'longitude', 'nav_lon', 'x', 'X'];
const TIME_NAMES = ['time', 'valid_time', 'Time', 't'];

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

async function decodeChunk(url, ref, di, filters, fetchImpl) {
  const raw = await fetchRange(url, ref.address, ref.size, fetchImpl);
  let buf = raw;
  if (filters.compressor) buf = await decompressChunk(buf, filters.compressor);
  if (filters.shuffle) buf = await applyFilters(buf, [{ id: 'shuffle', elementsize: filters.shuffleSize }], { bytes: filters.shuffleSize });
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new di.TA(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / di.bytes));
}

/**
 * hdf5RangePointExtract(url, { variable, lat, lon }, opts) -> result | null
 * result: { variable, grid:{nx,ny,nt}, location:{lat,lon}, timeseries:[{time,value}] }
 */
export async function hdf5RangePointExtract(url, query, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rurl = translateUrl(url);
  const reader = new Hdf5RangeReader(rurl, { fetchImpl });
  const File = await loadJsfive();
  const size = await reader.size();

  // ---- Phase 1: parse object headers + coordinates from a small FRONT buffer.
  // netCDF-C front-loads these (typically <2 MB) even when the chunk B-tree and
  // raw data live deep in the file. Grow a little on a bounds error; bail to the
  // whole-file path if headers/coords aren't reachable within a small cap.
  const CAP = Math.min(size, 16 << 20);
  let N = Math.min(2 << 20, size);
  let meta = null;
  for (;;) {
    let head;
    try { head = await reader.read(0, N); }
    catch { return null; }
    const ab = head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength);
    try { meta = _parseFront(File, ab, query); break; }
    catch (e) {
      if (e && e.__fallback) return null;                    // unsupported layout
      if (N < CAP) { N = Math.min(N * 4, CAP); continue; }   // grow & retry
      return null;
    }
  }

  // ---- Phase 2: read the chunk B-tree at its REAL offset (async, a few KB),
  // then fetch and decode only the chunk(s) covering the point.
  let chunkRefs;
  try { chunkRefs = await walkChunkBTreeAsync(reader, meta.chunkAddress, meta.rank); }
  catch { return null; }
  const refByKey = new Map();
  for (const r of chunkRefs) refByKey.set(r.coords.join(','), r);

  const { rank, di, filters, cstr, ct, latBase, lonBase, latIdx, lonIdx, nt } = meta;
  const values = new Array(nt);
  const chunkCache = new Map();
  for (let t = 0; t < nt; t++) {
    const tBase = rank >= 3 ? Math.floor(t / ct) * ct : 0;
    const coords = rank >= 3 ? [tBase, latBase, lonBase] : [latBase, lonBase];
    const key = coords.join(',');
    let decoded = chunkCache.get(key);
    if (!decoded) {
      const ref = refByKey.get(key);
      if (!ref) return null;                                 // missing chunk -> fallback
      try { decoded = await decodeChunk(rurl, ref, di, filters, fetchImpl); }
      catch { return null; }
      chunkCache.set(key, decoded);
    }
    const local = rank >= 3
      ? [t - tBase, latIdx - latBase, lonIdx - lonBase]
      : [latIdx - latBase, lonIdx - lonBase];
    let li = 0;
    for (let d = 0; d < rank; d++) li += local[d] * cstr[d];
    values[t] = decoded[li];
  }

  // Match the whole-file path, which emits values at 3-decimal precision.
  const round3 = (v) => (v == null || Number.isNaN(v)) ? null : Math.round(v * 1000) / 1000;
  const timeseries = values.map((v, i) => ({
    time: meta.times ? meta.times[i] : null,
    value: round3(v),
  }));

  return {
    variable: meta.varName,
    grid: { nx: meta.shape[meta.lonAxis], ny: meta.shape[meta.latAxis], nt },
    location: meta.location,
    timeseries,
    _range: true,
  };
}

/* Parse the variable's metadata + coordinate axes from the front buffer (jsfive).
 * Does NOT read the chunk B-tree or raw data. Throws a RangeError when the front
 * buffer is too small (caller grows), or an error with `__fallback = true` for a
 * definitively unsupported layout. Returns the plain values Phase 2 needs. */
function _parseFront(File, ab, query) {
  const f = new File(ab, 'remote.nc');

  // Collect datasets (root group only; nested groups -> unsupported).
  const byName = {};
  for (const key of f.keys) {
    const o = f.get(key);
    if (o && o.constructor && o.constructor.name === 'Dataset') byName[key] = o;
    else { const err = new Error('groups unsupported'); err.__fallback = true; throw err; }
  }

  const varName = query.variable || Object.keys(byName).find(
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

  // Coordinate axes (lat/lon last two dims); read values from the front buffer.
  const latName = findByName(byName, LAT_NAMES);
  const lonName = findByName(byName, LON_NAMES);
  if (!latName || !lonName) { const e = new Error('no lat/lon'); e.__fallback = true; throw e; }
  const lats = readCoord(f, latName);
  const lonsRaw = readCoord(f, lonName);

  const rank = shape.length;
  const latAxis = rank - 2, lonAxis = rank - 1;
  let qlon = query.lon;
  if (lonsRaw[lonsRaw.length - 1] > 180 && qlon < 0) qlon = ((qlon % 360) + 360) % 360;
  const latIdx = nearestIndex(lats, query.lat);
  const lonIdx = nearestIndex(lonsRaw, qlon);

  const timeName = findByName(byName, TIME_NAMES);
  const nt = rank >= 3 ? shape[0] : 1;
  let times = null;
  if (rank >= 3 && timeName && byName[timeName]) {
    const traw = readCoord(f, timeName);
    const tattrs = f.get(timeName).attrs || {};
    try { times = decodeTimes(traw, tattrs.units, tattrs.calendar || 'standard'); }
    catch { times = Array.from(traw, (v) => String(v)); }
  }

  // Local strides within a chunk (row-major) + covering-chunk bases.
  const cstr = new Array(rank);
  cstr[rank - 1] = 1;
  for (let d = rank - 2; d >= 0; d--) cstr[d] = cstr[d + 1] * chunkShape[d + 1];
  const latBase = Math.floor(latIdx / chunkShape[latAxis]) * chunkShape[latAxis];
  const lonBase = Math.floor(lonIdx / chunkShape[lonAxis]) * chunkShape[lonAxis];
  const ct = rank >= 3 ? chunkShape[0] : 1;

  return {
    varName, shape, di, filters, chunkAddress: dob._chunk_address, rank,
    latAxis, lonAxis, latIdx, lonIdx, nt, times, cstr, ct, latBase, lonBase,
    location: { lat: lats[latIdx], lon: lonsRaw[lonIdx] > 180 ? lonsRaw[lonIdx] - 360 : lonsRaw[lonIdx] },
  };
}
