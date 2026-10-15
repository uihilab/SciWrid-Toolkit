/*
 * lib/hdf5/object-header.js — read the object headers a variable needs, over
 * HTTP Range, without a file-sized buffer.
 *
 * WHY THIS EXISTS
 *
 * jsfive parses a file held as one ArrayBuffer at real file offsets, so the
 * only way to hand it metadata that lives at byte 8.7 GB is a 8.7+ GB buffer.
 * sparse-buffer.js does exactly that, capped at 1 GiB: right for a 272 MB
 * granule, wrong for NLDAS-3's 12.7 GB daily files, where netCDF-C wrote each
 * variable's object header just before that variable's data (Tair at byte
 * 19,156, Qair at 1.42 GB, Rainf at 8.71 GB) and the root group's link heap
 * somewhere in the middle.
 *
 * So for a file above that ceiling this module does the small part of what
 * jsfive does, by hand, at the addresses the file itself names:
 *
 *   superblock (v2/v3) -> root object header -> root links -> the requested
 *   variable's object header + lat/lon/time headers (each followed through its
 *   continuation blocks) -> dataspace, datatype, fill, filter pipeline, layout
 *   -> coordinate values.
 *
 * It returns the SAME `meta` object _parseFront (hdf5-range.js) builds from
 * jsfive, so the chunk-index walk, the fetch, the decode and the resample stay
 * one shared code path; only where the metadata comes from differs.
 *
 * WHAT IT DOES NOT DO (each is a decline with a reason, never a guess)
 *   - superblock v0/v1 and v1 object headers (netCDF-C writes v2 only when asked
 *     for the "latest" format; NLDAS-3 is superblock v2),
 *   - layout message versions other than 3 -- version 4 means chunk indexes
 *     (single chunk, implicit, fixed array, extensible array, v2 B-tree) that
 *     walkChunkBTreeAsync does not read. Version 3 is always a v1 B-tree,
 *   - links stored in a fractal heap whose root is an indirect block, or in a
 *     heap with an I/O filter,
 *   - shared messages, soft/external links, non-1-D coordinates.
 *
 * HOW LINKS ARE FOUND
 *
 * Compact links are link messages (0x06) in the group's own header. Dense links
 * live in a fractal heap with a v2 B-tree name index. As in dense-attrs.js, the
 * index is not needed: a direct block holds the link messages back to back and
 * each is self-sizing, so walking the block start to end enumerates them. This
 * borrows dense-attrs.js's heap-header and direct-block parsers rather than
 * adding a second copy.
 *
 * Like dense-attrs.js and jsfive, this assumes 8-byte offsets and lengths.
 */
import { parseHeapHeader, directBlockDataStart } from './dense-attrs.js';
import { decompressChunk } from '../zarr/decompressors.js';
import { applyFilters } from '../zarr/filters.js';
import { decodeTimes } from '../time-decoder.js';

const MSG = {
  DATASPACE: 0x01, LINK_INFO: 0x02, DATATYPE: 0x03, FILL_OLD: 0x04, FILL: 0x05,
  LINK: 0x06, LAYOUT: 0x08, FILTERS: 0x0b, ATTRIBUTE: 0x0c, CONTINUATION: 0x10,
  ATTR_INFO: 0x15,
};
const UNDEFINED = 0xffffffffffffffffn;

const LAT_NAMES = ['lat', 'latitude', 'nav_lat', 'y', 'Y'];
const LON_NAMES = ['lon', 'longitude', 'nav_lon', 'x', 'X'];
const TIME_NAMES = ['time', 'valid_time', 'Time', 't'];

/* A decline: this file's layout is not one the header reader supports. Carries
   the reason that hdf5-range.js surfaces through diag. */
export class HeaderDecline extends Error {
  constructor(reason) { super(reason); this.name = 'HeaderDecline'; this.__fallback = true; }
}
const decline = (reason) => { throw new HeaderDecline(reason); };

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u64 = (v, o) => Number(v.getBigUint64(o, true));
const addrAt = (v, o) => { const x = v.getBigUint64(o, true); return x === UNDEFINED ? null : Number(x); };
const sig = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const text = (u8) => { let n = u8.indexOf(0); if (n < 0) n = u8.length; return new TextDecoder().decode(u8.subarray(0, n)); };

/* Superblock v2/v3: signature(8) version(1) sizeof-offsets(1) sizeof-lengths(1)
   flags(1) base(8) extension(8) EOF(8) root-object-header(8) checksum(4). */
async function readSuperblock(reader) {
  const b = await reader.read(0, 64);
  if (b.length < 48 || sig(b, 1) !== 'HDF\r') decline('not an HDF5 file (no superblock signature)');
  const version = b[8];
  if (version !== 2 && version !== 3)
    decline('superblock version ' + version + ' is not read by the object-header reader (v2/v3 only)');
  if (b[9] !== 8 || b[10] !== 8)
    decline('superblock offset/length sizes are ' + b[9] + '/' + b[10] + ', only 8/8 is supported');
  const v = view(b);
  if (u64(v, 12) !== 0) decline('superblock base address is not 0');
  const root = addrAt(v, 36);
  if (root == null) decline('superblock has no root group address');
  return { root };
}

/* One object header (version 2) -> [{ type, flags, data }], following
   continuation messages. `data` is a Uint8Array over the message body. */
async function readObjectHeader(reader, addr) {
  const head = await reader.read(addr, 64);
  if (head.length < 12 || sig(head, 0) !== 'OHDR') decline('no object header at byte ' + addr);
  if (head[4] !== 2) decline('object header at byte ' + addr + ' is version ' + head[4] + ' (v2 only)');
  const flags = head[5];
  let p = 6;
  if (flags & 0x20) p += 16;                  // access/modify/change/birth times
  if (flags & 0x10) p += 4;                   // non-default attribute phase-change values
  const sizeBytes = 1 << (flags & 3);
  const chunk0 = Number(sizeBytes === 1 ? head[p] : sizeBytes === 2 ? view(head).getUint16(p, true)
    : sizeBytes === 4 ? view(head).getUint32(p, true) : view(head).getBigUint64(p, true));
  p += sizeBytes;
  const creationOrder = (flags & 0x04) !== 0; // each message header carries a 2-byte creation index
  const out = [];
  const queue = [{ at: addr + p, len: chunk0 }];
  let seen = 0;
  while (queue.length) {
    const { at, len } = queue.shift();
    if (++seen > 64) decline('object header at byte ' + addr + ' has more than 64 continuation blocks');
    const buf = await reader.read(at, len);
    if (buf.length < len) decline('object header block at byte ' + at + ' is truncated');
    const bv = view(buf);
    /* Chunk #0's size counts only its messages (its checksum follows it),
       whereas a continuation block's length covers "OCHK", the messages and the
       trailing checksum -- so only the latter ends 4 bytes early. */
    let q = 0;
    let end = len;
    if (at !== addr + p) {
      if (sig(buf, 0) !== 'OCHK') decline('continuation block at byte ' + at + ' lacks its signature');
      q = 4;
      end = len - 4;
    }
    const hdr = creationOrder ? 6 : 4;
    while (q + hdr <= end) {
      const type = buf[q];
      const size = bv.getUint16(q + 1, true);
      const mflags = buf[q + 3];
      const body = q + hdr;
      if (body + size > end) decline('object header message overruns its block at byte ' + at);
      if (type !== 0) {
        if (mflags & 0x02) decline('shared object header message (type ' + type + ')');
        if (type === MSG.CONTINUATION) {
          const off = addrAt(bv, body);
          if (off == null) decline('continuation message with an undefined address');
          queue.push({ at: off, len: u64(bv, body + 8) });
        } else out.push({ type, flags: mflags, data: buf.subarray(body, body + size) });
      }
      q = body + size;
    }
  }
  return out;
}

const find = (msgs, type) => msgs.find((m) => m.type === type);

/* ---------- fractal-heap walk (links and attributes share it) ---------- */

/* Walk the managed objects of a heap whose root is one direct block. `parseOne`
   gets (DataView, offset) and returns { size, ...rest } or null to stop. */
async function walkHeap(reader, heapAddr, parseOne, what) {
  const h = parseHeapHeader(view(await reader.read(heapAddr, 142)), 0);
  if (!h || h.rootAddress == null)
    decline(what + ': the fractal heap header at byte ' + heapAddr + ' is unreadable or has an I/O filter');
  if (h.currentRows > 0)
    decline(what + ': the fractal heap root is an indirect block (too many or too large objects)');
  const blk = await reader.read(h.rootAddress, h.startBlockSize);
  const bv = view(blk);
  const start = directBlockDataStart(bv, 0, h);
  if (start == null) decline(what + ': no direct block at byte ' + h.rootAddress);
  const found = [];
  let offset = start;
  while (offset < blk.length && found.length < h.managedCount) {
    let o = null;
    try { o = parseOne(bv, offset, blk); } catch { o = null; }
    if (!o || o.size <= 0 || offset + o.size > blk.length) break;
    found.push(o);
    offset += o.size;
  }
  if (found.length < h.managedCount)
    decline(what + ': read ' + found.length + ' of ' + h.managedCount + ' heap objects before the block stopped parsing');
  return found;
}

/* Link message (IV.A.2.g), version 1. Only hard links have an object to follow. */
function parseLink(v, o, u8) {
  if (v.getUint8(o) !== 1) return null;
  const flags = v.getUint8(o + 1);
  let p = o + 2;
  let type = 0;
  if (flags & 0x08) type = v.getUint8(p++);
  if (flags & 0x04) p += 8;                    // creation order
  if (flags & 0x10) p += 1;                    // name character set
  const lenSize = 1 << (flags & 3);
  const nameLen = Number(lenSize === 1 ? v.getUint8(p) : lenSize === 2 ? v.getUint16(p, true)
    : lenSize === 4 ? v.getUint32(p, true) : v.getBigUint64(p, true));
  p += lenSize;
  const name = new TextDecoder().decode(u8.subarray(p, p + nameLen));
  p += nameLen;
  if (type === 0) { const addr = addrAt(v, p); return { name, type, addr, size: p + 8 - o }; }
  if (type === 1 || type === 64) { const n = v.getUint16(p, true); return { name, type, addr: null, size: p + 2 + n - o }; }
  return null;
}

/* name -> object header address, for the group whose header messages are `msgs`. */
async function readLinks(reader, msgs) {
  const links = new Map();
  for (const m of msgs.filter((x) => x.type === MSG.LINK)) {
    const l = parseLink(view(m.data), 0, m.data);
    if (!l) decline('root group has a link message the reader cannot parse');
    if (l.addr != null) links.set(l.name, l.addr);
  }
  const info = find(msgs, MSG.LINK_INFO);
  if (info) {
    const v = view(info.data);
    let p = 2;
    if (info.data[1] & 0x01) p += 8;           // maximum creation index
    const heapAddr = addrAt(v, p);
    if (heapAddr != null) {
      const found = await walkHeap(reader, heapAddr, parseLink, 'dense links');
      for (const l of found) if (l.addr != null) links.set(l.name, l.addr);
    }
  }
  return links;
}

/* ---------- datatype, dataspace, fill, filters, layout ---------- */

/* Datatype message -> { dtype: '<f4' | '>i2' | '|u1' | ..., cls, size } */
function parseDatatype(u8) {
  const cls = u8[0] & 0x0f;
  const size = view(u8).getUint32(4, true);
  const b0 = u8[1];
  if (cls === 1) {                              // floating point: byte order is bits 0 and 6
    const order = (b0 & 0x01) | ((b0 >> 5) & 0x02);
    if (order !== 0 && order !== 1) return { dtype: null, cls, size };
    return { dtype: (order ? '>' : '<') + 'f' + size, cls, size };
  }
  if (cls === 0) return { dtype: ((b0 & 1) ? '>' : '<') + ((b0 & 8) ? 'i' : 'u') + size, cls, size };
  return { dtype: null, cls, size };
}

/* Dataspace message (v1 or v2) -> dims. */
function parseDataspace(u8) {
  const v = view(u8);
  const version = u8[0], nd = u8[1];
  let p;
  if (version === 1) p = 8;
  else if (version === 2) p = 4;
  else return decline('dataspace message version ' + version + ' is not supported');
  const dims = [];
  for (let d = 0; d < nd; d++) dims.push(u64(v, p + d * 8));
  return dims;
}

function readNumber(u8, o, dtype) {
  const v = view(u8);
  const le = dtype[0] !== '>';
  const kind = dtype[1], n = Number(dtype.slice(2));
  if (kind === 'f') return n === 4 ? v.getFloat32(o, le) : v.getFloat64(o, le);
  if (kind === 'i') return n === 1 ? v.getInt8(o) : n === 2 ? v.getInt16(o, le) : n === 4 ? v.getInt32(o, le) : Number(v.getBigInt64(o, le));
  return n === 1 ? v.getUint8(o) : n === 2 ? v.getUint16(o, le) : n === 4 ? v.getUint32(o, le) : Number(v.getBigUint64(o, le));
}

/* Fill value from the fill-value message, or null when none is defined. */
function parseFill(msgs, dt) {
  const m = find(msgs, MSG.FILL);
  if (!m || !dt.dtype) return null;
  const u8 = m.data;
  const version = u8[0];
  let defined = false, at = 0;
  if (version === 3) { defined = !!(u8[1] & 0x20); at = 6; }
  else if (version === 1 || version === 2) { defined = u8[3] !== 0 && u8[3] !== undefined; at = 8; }
  if (!defined || u8.length < at + dt.size) return null;
  return readNumber(u8, at, dt.dtype);
}

/* Filter pipeline (v1 and v2) -> the same { compressor, shuffle, shuffleSize }
   _parseFront builds. */
function parseFilters(msgs, bytes) {
  const filters = { compressor: null, shuffle: false, shuffleSize: bytes };
  const m = find(msgs, MSG.FILTERS);
  if (!m) return filters;
  const u8 = m.data, v = view(u8);
  const version = u8[0], n = u8[1];
  let p = version === 1 ? 8 : 2;
  for (let i = 0; i < n; i++) {
    const id = v.getUint16(p, true);
    let nameLen = 0;
    if (version === 1 || id >= 256) { nameLen = v.getUint16(p + 2, true); p += 2; }
    const nCd = v.getUint16(p + 4, true);
    p += 6;
    if (version === 1) nameLen = Math.ceil(nameLen / 8) * 8;
    p += nameLen;
    const cd = [];
    for (let k = 0; k < nCd; k++) cd.push(v.getUint32(p + k * 4, true));
    p += nCd * 4;
    if (version === 1 && nCd % 2) p += 4;
    if (id === 1) filters.compressor = { id: 'zlib' };
    else if (id === 2) { filters.shuffle = true; if (cd[0]) filters.shuffleSize = cd[0]; }
    else if (id === 3) { /* fletcher32 checksum -- decode ignores it, as on the jsfive path */ }
    else decline('unsupported filter ' + id);
  }
  return filters;
}

/* Data layout message -> { kind: 'contiguous' | 'chunked', ... } */
function parseLayout(u8, rank) {
  const v = view(u8);
  const version = u8[0];
  if (version !== 3)
    decline('data layout message version ' + version + ' (version 4 uses chunk indexes other than the v1 B-tree)');
  const cls = u8[1];
  if (cls === 1) return { kind: 'contiguous', address: addrAt(v, 2), size: u64(v, 10) };
  if (cls === 2) {
    const nd = u8[2];
    if (nd !== rank + 1) decline('chunk dimensionality ' + nd + ' does not match rank ' + rank + ' + 1');
    const chunkShape = [];
    for (let d = 0; d < rank; d++) chunkShape.push(v.getUint32(11 + d * 4, true));
    return { kind: 'chunked', address: addrAt(v, 3), chunkShape };
  }
  return decline('data layout class ' + cls + ' (compact data) is not supported');
}

/* ---------- attributes ---------- */

/* Attribute message (v1/v2/v3) -> { name, value, size } where `value` is a
   string for fixed-length strings, a number for the first element of a numeric
   attribute, and undefined for anything else (the walk still steps over it). */
function parseAttribute(v, o, u8) {
  const version = v.getUint8(o);
  let hdr, pad;
  if (version === 1) { hdr = 8; pad = 8; }
  else if (version === 2) { hdr = 8; pad = 1; }
  else if (version === 3) { hdr = 9; pad = 1; }
  else return null;
  const flags = version === 1 ? 0 : v.getUint8(o + 1);
  const nameSize = v.getUint16(o + 2, true), dtSize = v.getUint16(o + 4, true), dsSize = v.getUint16(o + 6, true);
  if (!nameSize || !dtSize || !dsSize) return null;
  const up = (n) => (pad <= 1 ? n : Math.ceil(n / pad) * pad);
  const nameAt = o + hdr, dtAt = nameAt + up(nameSize), dsAt = dtAt + up(dtSize), dataAt = dsAt + up(dsSize);
  const dt = parseDatatype(u8.subarray(dtAt, dtAt + dtSize));
  let count = 1;
  const dsv = u8[dsAt];
  if (dsv === 1 || dsv === 2) for (const d of parseDataspace(u8.subarray(dsAt, dsAt + dsSize))) count *= d;
  else return null;
  const size = dataAt - o + count * dt.size;
  let value;
  if (!(flags & 0x03) && dataAt + dt.size <= u8.length) {
    if (dt.cls === 3) value = text(u8.subarray(dataAt, dataAt + dt.size));
    else if (dt.dtype && count >= 1) value = readNumber(u8, dataAt, dt.dtype);
  }
  return { name: text(u8.subarray(nameAt, nameAt + nameSize)), value, size };
}

/* The attributes of an object: compact attribute messages plus, when the header
   carries an Attribute Info message, the dense heap. A dense heap the reader
   cannot walk costs the attributes (units, _FillValue), not the read: the
   caller reports the gap, as the jsfive path does for attributes it cannot see. */
async function readAttrs(reader, msgs, gaps) {
  const attrs = {};
  for (const m of msgs.filter((x) => x.type === MSG.ATTRIBUTE)) {
    try { const a = parseAttribute(view(m.data), 0, m.data); if (a && a.value !== undefined) attrs[a.name] = a.value; }
    catch { /* an attribute the reader cannot decode is skipped, like jsfive's */ }
  }
  const info = find(msgs, MSG.ATTR_INFO);
  if (info) {
    const heapAddr = addrAt(view(info.data), 2 + ((info.data[1] & 0x01) ? 2 : 0));
    if (heapAddr != null) {
      try {
        for (const a of await walkHeap(reader, heapAddr, parseAttribute, 'dense attributes'))
          if (a.value !== undefined) attrs[a.name] = a.value;
      } catch (e) {
        if (!(e instanceof HeaderDecline)) throw e;
        gaps.push(e.message);
      }
    }
  }
  return attrs;
}

/* ---------- dataset assembly ---------- */

async function readDataset(reader, addr, name) {
  const msgs = await readObjectHeader(reader, addr);
  const dsMsg = find(msgs, MSG.DATASPACE), dtMsg = find(msgs, MSG.DATATYPE), loMsg = find(msgs, MSG.LAYOUT);
  if (!dsMsg || !dtMsg || !loMsg) decline('"' + name + '" is not a dataset (missing dataspace, datatype or layout)');
  const shape = parseDataspace(dsMsg.data);
  const dt = parseDatatype(dtMsg.data);
  return { msgs, shape, dt, loMsg };
}

/**
 * readMetaViaHeaders(reader, { variable, dtypeInfo, walkChunkBTree, decode })
 *   -> meta (the object _parseFront returns)
 *
 * `dtypeInfo`, `walkChunkBTree` and `decode` are hdf5-range.js's own, injected
 * so the decode stays shared with the jsfive path and this module has no import
 * cycle with it.
 */
export async function readMetaViaHeaders(reader, { variable, dtypeInfo, walkChunkBTree, decodeChunkBytes }) {
  if (!variable) decline('a variable name is required (there is no jsfive "first 2-D dataset" guess here)');
  const { root } = await readSuperblock(reader);
  const rootMsgs = await readObjectHeader(reader, root);
  const links = await readLinks(reader, rootMsgs);

  const nameOf = (names) => {
    for (const n of names) if (links.has(n)) return n;
    const lower = new Map([...links.keys()].map((k) => [k.toLowerCase(), k]));
    for (const n of names) if (lower.has(n.toLowerCase())) return lower.get(n.toLowerCase());
    return null;
  };

  if (!links.has(variable)) decline('variable "' + variable + '" is not a link of the root group');
  const gaps = [];

  const v = await readDataset(reader, links.get(variable), variable);
  const di = dtypeInfo(v.dt.dtype || '');
  if (!di || v.shape.length < 2) decline('unsupported dtype/shape for "' + variable + '"');
  const layout = parseLayout(v.loMsg.data, v.shape.length);
  if (layout.kind !== 'chunked' || layout.address == null) decline('"' + variable + '" is not chunked');
  const filters = parseFilters(v.msgs, di.bytes);

  /* A 1-D coordinate: contiguous (one read) or chunked (a B-tree walk, then the
     chunks), through the same decode as the variable's own chunks. */
  const readCoord = async (name) => {
    const c = await readDataset(reader, links.get(name), name);
    const cdi = dtypeInfo(c.dt.dtype || '');
    if (!cdi || c.shape.length !== 1) decline('coordinate "' + name + '" is not a 1-D numeric dataset');
    const n = c.shape[0];
    const lo = parseLayout(c.loMsg.data, 1);
    const out = new Float64Array(n);
    if (lo.kind === 'contiguous') {
      if (lo.address == null) return out;          // never written
      const raw = await reader.read(lo.address, n * cdi.bytes);
      const arr = new cdi.TA(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * cdi.bytes));
      if (!cdi.littleEndian) decline('big-endian coordinate "' + name + '"');
      out.set(arr);
      return out;
    }
    const cf = parseFilters(c.msgs, cdi.bytes);
    const refs = await walkChunkBTree(reader, lo.address, 1);
    for (const r of refs) {
      const dec = await decodeChunkBytes(await reader.read(r.address, r.size),
        { filters: cf, dtype: cdi, filterMask: r.filterMask });
      const at = r.coords[0];
      for (let i = 0; i < lo.chunkShape[0] && at + i < n; i++) out[at + i] = dec[i];
    }
    return out;
  };

  const latName = nameOf(LAT_NAMES), lonName = nameOf(LON_NAMES);
  if (!latName || !lonName) decline('no lat/lon coordinate among the root links');
  const lats = await readCoord(latName), lonsRaw = await readCoord(lonName);

  const rank = v.shape.length;
  const nt = rank >= 3 ? v.shape[0] : 1;
  const timeName = nameOf(TIME_NAMES);
  let times = null, timesUndecoded = null;
  if (rank >= 3 && timeName) {
    const traw = await readCoord(timeName);
    const tm = await readDataset(reader, links.get(timeName), timeName);
    const tattrs = await readAttrs(reader, tm.msgs, gaps);
    try {
      times = decodeTimes(traw, tattrs.units, tattrs.calendar || 'standard').values;
    } catch (e) {
      timesUndecoded = 'time units are not readable from this file (' + String((e && e.message) || e) + ')';
    }
  }

  const vattrs = await readAttrs(reader, v.msgs, gaps);
  /* The HDF5 fill message is what the jsfive path reports. Files whose writer
     did not put one on the dataset (NLDAS-3: the message is "default", the
     value -9999 lives in the _FillValue attribute) would otherwise leave every
     fill cell as a real number, so the attribute is the fallback. */
  let fillValue = parseFill(v.msgs, v.dt);
  if (fillValue == null && typeof vattrs._FillValue === 'number') fillValue = vattrs._FillValue;

  return {
    varName: variable, shape: v.shape, di, filters, chunkShape: layout.chunkShape,
    chunkAddress: layout.address, rank, latAxis: rank - 2, lonAxis: rank - 1,
    lats, lonsRaw, times, timesUndecoded, nt,
    units: typeof vattrs.units === 'string' ? vattrs.units : '',
    fillValue: fillValue == null ? null : Number(fillValue),
    ...(gaps.length ? { attrGaps: gaps } : {}),
  };
}
