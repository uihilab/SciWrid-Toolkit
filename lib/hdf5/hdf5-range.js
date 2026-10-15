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
 * budget metadataCap() allows) or we fall back.
 *
 * LARGE FILES. jsfive needs a file-sized buffer to parse metadata at real
 * offsets, and sparse-buffer.js caps that at SCIWRID_HDF5_SPARSE_MAX_BYTES
 * (1 GiB). A file above the cap -- NLDAS-3's 12.7 GB daily files, where each
 * variable's object header sits just before its own data, Rainf at 8.7 GB --
 * therefore no longer takes the jsfive path at all: object-header.js reads the
 * superblock, root links and the needed variables' headers by Range, at the
 * addresses the file names, and hands back the same `meta`. Everything after
 * that (chunk index, fetch, decode, resample) is shared. Files under the cap
 * keep the jsfive path unchanged.
 */
import { Hdf5RangeReader } from './range-reader.js';
import { fetchRange, translateUrl } from '../sources/range-fetcher.js';
import { decompressChunk } from '../zarr/decompressors.js';
import { applyFilters } from '../zarr/filters.js';
import { decodeTimes } from '../time-decoder.js';
import { attrsOf } from './dense-attrs.js';
import { recordCarry } from '../sources/prefetch-carry.js';
import { assembleSparse, sparseMaxBytes } from './sparse-buffer.js';
import { readMetaViaHeaders } from './object-header.js';
import { normalizeJsfiveError } from './jsfive-errors.js';

const LAT_NAMES = ['lat', 'latitude', 'nav_lat', 'y', 'Y'];
const LON_NAMES = ['lon', 'longitude', 'nav_lon', 'x', 'X'];
const TIME_NAMES = ['time', 'valid_time', 'Time', 't'];

/* The initial front-buffer read in _parseMetaAndChunks. Shared so the gate in
 * the extractors and the read itself cannot drift apart. */
const FRONT_TARGET = 2 << 20;

/* Read granularity of the object-header path; see _withCarry. */
const HEADER_BLOCK = 64 << 10;

/* The tail window, and how far it may grow.
 *
 * Measured 2026-09-23 against the live stores: NEX-GDDP-CMIP6 (182 MB) and NWM
 * LDASOUT (272 MB) both parse from a 2 MB front plus a 1 MB tail -- 3.1 MB,
 * regardless of file size. The prefix alone reached metadataCap() and declined
 * on both.
 *
 * The cap is where honesty begins: nClimGrid-Daily keeps `prcp`'s object
 * header in the MIDDLE of the file, after tmax's and tmin's data, and no
 * front/tail window reaches it (2 MB + 16 MB fails; 64 MB of a 64.5 MB file
 * succeeds). Growing past this cap to chase that case would download the file
 * while pretending to range-read it, so the honest move is to decline and let
 * the whole-file path own it. */
const TAIL_TARGET = 1 << 20;
const TAIL_CAP = 16 << 20;

/* Share of a file the range path may buffer while trying to parse metadata.
 *
 * The grow loop is speculative: it enlarges the front buffer until jsfive can
 * parse the headers, and it does not know in advance whether that will ever
 * succeed. It originally had to be bounded because failure was pure loss --
 * the whole-file fallback restarted at byte zero and reused none of it.
 * Measured 2026-07-30 on a 32.2 MB GOES-18 ABI file whose metadata jsfive
 * cannot parse at any size: a flat 16 MB cap spent 16.78 MB discovering that,
 * then the fallback moved 32.22 MB, for 49.00 MB = 152.1% of the file.
 *
 * That is no longer the reason. The front buffer is handed to the fallback
 * (see _withCarry), so a failed grow loop costs no extra BYTES at all -- the
 * fallback fetches only the remainder and the total lands at one file, the
 * same as never having tried. What the cap still bounds is MEMORY and LATENCY:
 * how much of a file we are willing to hold, and stall on, before admitting
 * the metadata is not parseable. Those are worth bounding on their own. */
const METADATA_BUDGET = 0.25;

/* How far the metadata grow loop may read for a file of `size` bytes.
 *
 * Three bounds, and each one matters:
 *   - the file itself     -- never read past EOF
 *   - a 16 MB hard cap    -- never hold a huge speculative buffer
 *   - METADATA_BUDGET     -- keep that proportional on smaller files
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
  return decodeChunkBytes(raw, { filters, dtype: di, filterMask: ref.filterMask });
}

/**
 * One chunk's raw bytes, decoded into its typed array.
 *
 * Split out of decodeChunk so the fetch and the decode are separable: a caller
 * with its own chunk scheduling -- its own concurrency, its own accumulator,
 * its own cost accounting -- brings the bytes here, while decodeChunk above
 * keeps fetching them itself. One decoder either way, because two would agree
 * today and drift the day one of them is fixed.
 *
 * `filterMask` is accepted because the ref carries it, and a caller has no
 * business dropping a field it does not understand. It is NOT consulted yet:
 * the mask names filters skipped for one particular chunk, and honouring it
 * means decoding that chunk differently from its neighbours. The internal path
 * has always ignored it; this is the same behaviour, now visible rather than
 * buried. A file that varies its mask per chunk will read wrong here.
 */
export async function decodeChunkBytes(bytes, { filters, dtype, filterMask } = {}) {
  if (!filters || !dtype)
    throw new Error(
      'decodeChunkBytes: filters and dtype are required; both come from openChunkMap meta');
  void filterMask;
  let buf = bytes;
  if (filters.compressor) buf = await decompressChunk(buf, filters.compressor);
  if (filters.shuffle) buf = await applyFilters(buf, [{ id: 'shuffle', elementsize: filters.shuffleSize }], { bytes: filters.shuffleSize });
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new dtype.TA(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / dtype.bytes));
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
 * The carry does not make this gate redundant. It repays a DECLINE; the 197%
 * above is what a SUCCESS costs on a small file, where the chunk fetch re-reads
 * bytes the front buffer already holds and no fallback ever runs. So the gate
 * still has to catch that case up front, and still before the read: `size`
 * comes from a HEAD, which transfers no body, so refusing here is free. */
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

/* What declining right now would still cost the caller in transfer.
 *
 * Without a carry the fallback restarts at byte zero and owes the whole file.
 * With one it inherits the front buffer and owes only the rest -- so the same
 * decision is genuinely cheaper than it used to be, and the gate that compares
 * against it has to know which world it is in rather than assume the worse.
 *
 * reader.stats() is exactly the front-buffer spend at this point: chunk fetches
 * bypass the reader, and none have happened yet when the gates run. */
function remainingFallbackCost(reader, size, opts) {
  if (!opts || !opts.carry) return size;
  return Math.max(0, size - reader.stats().bytes);
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
  let front = Math.min(FRONT_TARGET, size);
  let tail = 0;
  let meta = null;

  if (size > sparseMaxBytes()) {
    /* Above the sparse ceiling there is no buffer to grow, so the ladder below
       does not apply. Every way this can fail is a decline with its reason; the
       reads that were made stay in the reader's cache for the carry. */
    try {
      meta = await readMetaViaHeaders(reader, {
        variable, dtypeInfo, walkChunkBTree: walkChunkBTreeAsync, decodeChunkBytes });
    } catch (e) {
      return decline(opts, 'object-header read failed on a ' + size + ' byte file (above the ' +
        sparseMaxBytes() + ' byte sparse ceiling): ' + String((e && e.message) || e));
    }
  }

  for (; !meta;) {
    let ab;
    try {
      const windows = [{ start: 0, length: front }];
      if (tail > 0) windows.push({ start: Math.max(front, size - tail), length: tail });
      ({ buffer: ab } = await assembleSparse(reader, size, windows));
    } catch (e) {
      return decline(opts, 'metadata read failed: ' + String((e && e.message) || e));
    }

    try { meta = _parseFront(File, ab, variable); break; }
    catch (raw) {
      const e = normalizeJsfiveError(raw);
      /* Our own "this file's layout is not supported" signal, raised by
         _parseFront. No window will change it. */
      if (e.__fallback) return decline(opts, 'unsupported layout: ' + e.message);
      /* Look at the tail before spending more on the front: a prefix cannot
         reach metadata the writer put at the end, and the front was already
         sufficient for everything front-loaded. */
      if (tail < TAIL_CAP) { tail = tail === 0 ? TAIL_TARGET : Math.min(tail * 4, TAIL_CAP); continue; }
      if (front < CAP) { front = Math.min(front * 4, CAP); continue; }
      return decline(opts,
        'metadata not parseable from ' + front + ' bytes at the front plus ' +
        tail + ' at the tail of a ' + size + ' byte file: ' + e.message);
    }
  }
  let chunkRefs;
  try { chunkRefs = await walkChunkBTreeAsync(reader, meta.chunkAddress, meta.rank); }
  catch (e) { return decline(opts, 'chunk index walk failed: ' + String((e && e.message) || e)); }
  const refByKey = new Map();
  for (const r of chunkRefs) refByKey.set(r.coords.join(','), r);
  return { meta, refByKey };
}

/* Set up the reader both extractors need, and -- this is the point -- make
 * sure the bytes they read survive a decline.
 *
 * A declined range path used to be pure loss: the caller fell back to
 * fetch(url), which restarts at byte zero, so the front region was paid for
 * twice. opts.carry (lib/sources/prefetch-carry.js) is where the front region
 * goes on the way out, so the fallback can ask only for the remainder. It is
 * populated ONLY on a decline -- a successful range extraction has no fallback
 * to feed, and banking megabytes for nobody would just hold memory.
 *
 * `finally` rather than a check at each exit because there are a dozen ways
 * out of these functions, including throwing, and every one of them leaves the
 * same bytes on the floor. */
async function _withCarry(url, opts, run) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const rurl = translateUrl(url);
  let reader = new Hdf5RangeReader(rurl, { fetchImpl });
  const size = await reader.size();
  /* Above the sparse ceiling the object-header reader makes a handful of small
     scattered reads (a superblock, a few headers, a heap, a B-tree node). The
     reader's 1 MB blocks suit a front-buffer parse, where reads are dense; here
     each one would be rounded up to a megabyte for a few hundred bytes -- ten
     headers, ten MB. 64 KB keeps the read near what was asked for. */
  if (size > sparseMaxBytes())
    reader = new Hdf5RangeReader(rurl, { fetchImpl, blockSize: HEADER_BLOCK, size });
  let out = null;
  try {
    out = await run(rurl, reader, size, fetchImpl);
    return out;
  } finally {
    if (!out && opts.carry) recordCarry(opts.carry, url, reader.prefix(), size);
  }
}

/**
 * openChunkMap(url, { variable, fetchImpl }) -> { meta, refs } | null
 *
 * The chunk index for one NetCDF4/HDF5 variable: where every chunk lives, how
 * big it is, and what it takes to decode. This is what `_parseMetaAndChunks`
 * has always built on the way to an answer, handed out instead of consumed.
 *
 * It exists because `extract` gives a point and `extractGrid` gives a
 * resampled raster, and neither can feed a reduction -- the first throws the
 * grid away, the second invents cells that were never measured. A consumer
 * with its own reducer needs neither: it needs to address the chunks. That is
 * a `.zarray` plus an address function, which is exactly what comes back here,
 * so a NetCDF4 variable can be read by anything that already reads Zarr.
 *
 * The profitability gates the extractors apply are deliberately NOT applied.
 * They answer "is a range read cheaper than downloading the whole file for
 * this one answer", which is the right question for an extraction and the
 * wrong one for an index: a caller asking where the chunks are has already
 * decided to address them itself, and may read one chunk or ten thousand.
 *
 * Returns null on a layout this path cannot parse, matching the extractors --
 * a caller that has a whole-file fallback keeps it.
 */
export async function openChunkMap(url, { variable, fetchImpl, ...rest } = {}) {
  if (!variable) throw new Error('openChunkMap: a variable name is required');
  const opts = { ...rest, ...(fetchImpl ? { fetchImpl } : {}) };
  return _withCarry(url, opts, async (rurl, reader, size, fetch_) => {
    /* Injectable so the window ladder can be tested without a real HDF5 file
       or the network; production passes nothing and gets jsfive. */
    const File = opts.__FileImpl ?? await loadJsfive();
    const parsed = await _parseMetaAndChunks(reader, File, size, variable, fetch_, opts);
    if (!parsed) return null;
    const { meta, refByKey } = parsed;
    return {
      /* Renamed on the way out, because the internal spellings are not a
         public vocabulary: `di` is a dtype descriptor and `lonsRaw` is simply
         the longitudes. The rest passes through under its own name. */
      meta: {
        varName: meta.varName,
        shape: meta.shape,
        chunkShape: meta.chunkShape,
        dtype: meta.di,
        fillValue: meta.fillValue,
        filters: meta.filters,
        rank: meta.rank,
        latAxis: meta.latAxis,
        lonAxis: meta.lonAxis,
        lats: meta.lats,
        lons: meta.lonsRaw,
        times: meta.times,
        units: meta.units,
      },
      refs: refByKey,
    };
  });
}

/**
 * hdf5RangePointExtract(url, { variable, lat, lon }, opts) -> result | null
 * result: { variable, grid:{nx,ny,nt}, location:{lat,lon}, timeseries:[{time,value}] }
 */
export async function hdf5RangePointExtract(url, query, opts = {}) {
  return _withCarry(url, opts, (rurl, reader, size, fetchImpl) =>
    _pointExtract(rurl, reader, size, fetchImpl, query, opts));
}

async function _pointExtract(rurl, reader, size, fetchImpl, query, opts) {
  const tally = { requests: 0, bytes: 0 };
  const File = await loadJsfive();

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

  /* Gate B: marginal. Both sides of the comparison are what is still to be
   * PAID; the front buffer is sunk and appears on neither. Continuing costs
   * chunkBytes. Declining costs whatever the fallback has to fetch -- which is
   * the whole file, unless a carry is here to hand it the front buffer, in
   * which case it is only the remainder. Charging the sunk bytes to either
   * side would make this refuse cases where refusing is the more expensive
   * option. */
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
    const fallbackCost = remainingFallbackCost(reader, size, opts);
    if (!opts.forceRange && chunkBytes >= fallbackCost)
      return decline(opts,
        'remaining chunk fetches would move ' + chunkBytes + ' bytes against ' +
        fallbackCost + ' still owed by the whole-file path on a ' + size +
        ' byte file; falling back is cheaper from here');
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
 * Fetches only the spatial chunks of the SELECTED timestep that lie under the
 * bbox (plus a one-cell margin for the nearest-neighbour pick), assembles that
 * window of the native grid, and resamples it to W×H with the SAME
 * `inlineExtract` the whole-file path uses — so the output is identical and
 * transfer is the chunks under the bbox (independent of file size, grid size,
 * other timesteps and other variables).
 */
export async function hdf5RangeGridExtract(url, query, opts = {}) {
  return _withCarry(url, opts, (rurl, reader, size, fetchImpl) =>
    _gridExtract(rurl, reader, size, fetchImpl, query, opts));
}

async function _gridExtract(rurl, reader, size, fetchImpl, query, opts) {
  const tally = { requests: 0, bytes: 0 };
  const File = await loadJsfive();

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

  /* The native window the resample can touch.
   *
   * inlineExtract picks, for every output pixel, the nearest native row and
   * column (clamping to the edge, and shifting longitudes by 360 when the grid
   * uses the other convention). Rather than re-derive those rules here and risk
   * drifting from them, ask inlineExtract itself: run it once over a lat-only
   * and once over a lon-only index array, so its output IS the row/column each
   * pixel lands on. Those indices, widened by one cell each side as a margin
   * and clamped to the grid, bound every cell the real resample will read.
   * A bbox that misses the grid clamps to the edge cells exactly as before. */
  const latsAscending = lats[0] < lats[ny - 1];
  const lonsAscending = lonsRaw[0] < lonsRaw[nx - 1];
  const lonRange = lonsAscending ? [lonsRaw[0], lonsRaw[nx - 1]] : [lonsRaw[nx - 1], lonsRaw[0]];
  const { inlineExtract } = await import('../../worker/loader.js');
  const probe = { bbox: query.bbox, width: query.width, height: query.height,
                  latsAscending, lonsAscending, lonRange };
  const rowIdx = inlineExtract({ ...probe, lats, lons: [lonsRaw[0]], nx: 1,
    data: Float32Array.from({ length: ny }, (_, k) => k) });
  const colIdx = inlineExtract({ ...probe, lats: [lats[0]], lons: lonsRaw, nx,
    data: Float32Array.from({ length: nx }, (_, k) => k) });
  let y0 = ny, y1 = -1, x0 = nx, x1 = -1;
  for (const v of rowIdx) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
  for (const v of colIdx) { if (v < x0) x0 = v; if (v > x1) x1 = v; }
  if (y1 < 0 || x1 < 0) return null;                       // empty output: nothing to window
  y0 = Math.max(0, y0 - 1); y1 = Math.min(ny - 1, y1 + 1);
  x0 = Math.max(0, x0 - 1); x1 = Math.min(nx - 1, x1 + 1);
  const wy = y1 - y0 + 1, wx = x1 - x0 + 1;

  /* Does this chunk (by its element offsets) overlap the window? */
  const inWindow = (coords) => {
    const cLat = coords[latAxis], cLon = coords[lonAxis];
    return cLat <= y1 && cLat + cy > y0 && cLon <= x1 && cLon + cx > x0;
  };

  /* Gate B, over the chunks of the selected timestep under the window only.
   * Sunk front-buffer cost is excluded, and the fallback is charged only what it
   * still owes, for the same reasons as in the point path. */
  {
    let chunkBytes = 0;
    for (const [key, ref] of refByKey) {
      const coords = key.split(',').map(Number);
      if (rank >= 3 && coords[0] !== tBase) continue;
      if (!inWindow(coords)) continue;
      chunkBytes += ref.size;
    }
    const fallbackCost = remainingFallbackCost(reader, size, opts);
    if (!opts.forceRange && chunkBytes >= fallbackCost)
      return decline(opts,
        'remaining grid chunk fetches would move ' + chunkBytes + ' bytes against ' +
        fallbackCost + ' still owed by the whole-file path on a ' + size +
        ' byte file; falling back is cheaper from here');
  }

  /* Assemble the window from the chunks that overlap it. Sized to the window,
   * not the grid: on a 6500 x 11700 grid the full slab alone is 304 MB. */
  const sliceData = new Float32Array(wy * wx);
  for (const [key, ref] of refByKey) {
    const coords = key.split(',').map(Number);
    if (rank >= 3 && coords[0] !== tBase) continue;         // other time-chunks
    if (!inWindow(coords)) continue;                        // chunks outside the bbox
    let decoded;
    try { decoded = await decodeChunk(rurl, ref, di, filters, fetchImpl, tally); }
    catch { return null; }
    const cLat = coords[latAxis], cLon = coords[lonAxis];
    for (let ly = 0; ly < cy; ly++) {
      const gy = cLat + ly;
      if (gy >= ny) break;
      if (gy < y0 || gy > y1) continue;
      const rowBase = (rank >= 3 ? tl * cstr[0] + ly * cstr[latAxis] : ly * cstr[latAxis]);
      for (let lx = 0; lx < cx; lx++) {
        const gx = cLon + lx;
        if (gx >= nx) break;
        if (gx < x0 || gx > x1) continue;
        const v = decoded[rowBase + lx * cstr[lonAxis]];
        sliceData[(gy - y0) * wx + (gx - x0)] = (fill != null && v === fill) ? NaN : v;   // fill -> NaN
      }
    }
  }

  /* Resample with the SAME code path as the whole-file grid export, over the
   * window's sub-axes. The direction flags and lonRange are those of the FULL
   * axes, not recomputed from the sub-arrays: a one-column window has no
   * direction of its own, and a narrower lonRange would change which pixels
   * inlineExtract shifts by 360. With the full-axis values the nearest cell for
   * every pixel is the one the whole slab would have given. */
  const data = inlineExtract(
    { lats: lats.slice(y0, y1 + 1), lons: lonsRaw.slice(x0, x1 + 1), data: sliceData, nx: wx,
      latsAscending, lonsAscending, lonRange,
      bbox: query.bbox, width: query.width, height: query.height });

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
