/*
 * lib/slim/netcdf3.js
 *
 * NetCDF-3 (Classic + 64-bit-offset) slim. No decode — for kept variables
 * we copy raw data bytes verbatim from the source and rewrite only the
 * header with the new variable layout and offsets.
 *
 * Strategy
 * --------
 *   1. wp_nc3_scan() + wp_nc3_full_layout() give us the parsed header as
 *      JSON: version, numrecs, dims, gatts, vars (each with begin/vsize/
 *      is_record/atts/...).
 *   2. Validate opts.variables against the layout; everything else dropped.
 *   3. Time slice (if t1/t2 given) only applies to RECORD variables (the
 *      unlimited dim is the time axis). For non-record kept vars t1/t2 is
 *      ignored. If t1/t2 given but no kept var is a record var → no-op.
 *   4. Build the new header bytes (CDF spec is small and well-defined):
 *      magic + numrecs + dim_list + gatt_list + var_list. We always keep
 *      every dim from the source so dimids stay stable (cheap safety).
 *      Global attrs are copied verbatim. Per-var attrs come from the
 *      layout JSON (base64-decoded value bytes).
 *   5. Compute new `begin` for each kept var (non-record vars first,
 *      contiguous; then record vars interleaved with the new recsize)
 *      and patch them into the header at the captured begin-field offsets.
 *   6. Copy data:
 *      - Non-record vars: one contiguous span [begin, begin+vsize) per var
 *      - Record vars:    for each kept record r' in [0, n_kept_records):
 *                          for each kept record var v:
 *                            copy src[v.begin + (t1+r') * src_recsize, vsize)
 *                            into dst[v.new_begin + r' * dst_recsize, vsize)
 *
 * CDF spec reference:
 *   https://docs.unidata.ucar.edu/nug/current/file_format_specifications.html
 */

import { SlimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';
import WebParsers from '../../wasm/webparsers.js';

const TAG_ABSENT      = 0x00000000;
const TAG_NC_DIMENSION = 0x0000000A;
const TAG_NC_VARIABLE  = 0x0000000B;
const TAG_NC_ATTRIBUTE = 0x0000000C;

/* nc3_type → bytes per element (matches NC3_TYPE enum in netcdf3.h) */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

const CHUNK = 65536;

function pad4(n) { return (4 - (n % 4)) % 4; }

async function loadAll(byteSource) {
  const size = await byteSource.size();
  return byteSource.read(0, size);
}

function copyIntoWasm(wasm, data) {
  const ptr = wasm.ccall('wp_malloc', 'number', ['number'], [data.length]);
  if (ptr === 0) throw new SlimError('NetCDF3 slim: WASM out of memory');
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
    wasm.ccall('wp_memcpy', null,
      ['number', 'array', 'number'],
      [ptr + off, slice, slice.length]);
  }
  return ptr;
}

function b64ToBytes(s) {
  if (!s) return new Uint8Array(0);
  /* atob is available in Node 18+ and browsers */
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Header writer ──────────────────────────────────────────────────────── */

class HeaderWriter {
  constructor(version) {
    this.version    = version;
    this.parts      = [];        /* Uint8Array[] appended in order */
    this.totalLen   = 0;
    this.beginSlots = [];        /* { varIndex, offset, width } — patched later */
  }

  push(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    this.parts.push(u8);
    this.totalLen += u8.length;
  }

  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false /* big-endian */);
    this.push(b);
  }

  /* CDF "name": nelems[u32] + chars + zero padding to 4 */
  writeName(name) {
    const bytes = new TextEncoder().encode(name);
    this.u32(bytes.length);
    this.push(bytes);
    const pad = pad4(bytes.length);
    if (pad) this.push(new Uint8Array(pad));
  }

  /* CDF "values": bytes padded to 4 */
  writeValues(bytes) {
    this.push(bytes);
    const pad = pad4(bytes.length);
    if (pad) this.push(new Uint8Array(pad));
  }

  /* Reserve a begin slot — write zero now, capture its absolute offset for patching. */
  writeBeginPlaceholder(varIndex) {
    const width = this.version === 2 ? 8 : 4;
    this.beginSlots.push({ varIndex, offset: this.totalLen, width });
    this.push(new Uint8Array(width));
  }

  build() {
    const out = new Uint8Array(this.totalLen);
    let p = 0;
    for (const part of this.parts) { out.set(part, p); p += part.length; }
    return out;
  }

  /* Patch a begin slot in `bytes` (which was returned by build()). */
  patchBegin(bytes, varIndex, begin) {
    const slot = this.beginSlots.find(s => s.varIndex === varIndex);
    if (!slot)
      throw new SlimError(`NetCDF3 slim: no begin slot for var index ${varIndex}`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (slot.width === 8) {
      const hi = Math.floor(begin / 0x100000000);
      const lo = begin >>> 0;
      dv.setUint32(slot.offset,     hi, false);
      dv.setUint32(slot.offset + 4, lo, false);
    } else {
      if (begin > 0xFFFFFFFF)
        throw new SlimError(
          `NetCDF3 slim: begin offset ${begin} doesn't fit in 32 bits (v1 format)`);
      dv.setUint32(slot.offset, begin >>> 0, false);
    }
  }
}

/* ── Main entry point ───────────────────────────────────────────────────── */

export async function slim(byteSource, opts, ctx) {
  const data    = await loadAll(byteSource);
  const factory = opts.wasmFactory || ctx?.wasmFactory || WebParsers;
  const wasm    = await factory();

  const inPtr = copyIntoWasm(wasm, data);
  let scanPtr = 0;
  try {
    scanPtr = wasm.ccall('wp_nc3_scan', 'number',
                         ['number', 'number'], [inPtr, data.length]);
    wasm.ccall('wp_free', null, ['number'], [inPtr]);
    if (scanPtr === 0)
      throw new SlimError('NetCDF3 slim: wp_nc3_scan failed (malformed file?)');

    const jsonPtr = wasm.ccall('wp_nc3_full_layout', 'number',
                               ['number'], [scanPtr]);
    if (jsonPtr === 0)
      throw new SlimError('NetCDF3 slim: wp_nc3_full_layout returned NULL');
    const json = wasm.UTF8ToString(jsonPtr);
    wasm.ccall('wp_free', null, ['number'], [jsonPtr]);

    /** @type {{version:number, numrecs:number, data_len:number,
     *         dims:Array, gatts:Array, vars:Array}} */
    const layout = JSON.parse(json);

    return assembleSlim(data, layout, opts);
  } finally {
    if (scanPtr) {
      try { wasm.ccall('wp_nc3_scan_free', null, ['number'], [scanPtr]); }
      catch (_) {}
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Pure-function core. Separated so tests can drive it with a hand-built  */
/* layout JSON, no WASM required.                                         */
/* ---------------------------------------------------------------------- */
export function assembleSlim(data, layout, opts) {
  const requested = new Set(opts.variables);
  const allNames  = layout.vars.map(v => v.name);
  const missing   = opts.variables.filter(n => !allNames.includes(n));
  if (missing.length === opts.variables.length)
    throw new VariableNotFoundError(
      `NetCDF3 slim: none of the requested variables are present ` +
      `(requested: ${opts.variables.join(', ')}; ` +
      `available: ${allNames.join(', ')})`);
  if (missing.length > 0)
    throw new VariableNotFoundError(
      `NetCDF3 slim: variable(s) not found: ${missing.join(', ')}`);

  const keptVars     = layout.vars.filter(v => requested.has(v.name));
  const recordVars   = layout.vars.filter(v => v.is_record);
  const keptNonRec   = keptVars.filter(v => !v.is_record);
  const keptRecord   = keptVars.filter(v =>  v.is_record);
  const origRecsize  = recordVars.reduce((s, v) => s + v.vsize, 0);
  const newRecsize   = keptRecord.reduce((s, v) => s + v.vsize, 0);

  /* Time slice: applies only to the record dim (the unlimited dim).
   * If user gave t1/t2 but no kept record vars, ignore the slice. */
  const haveT       = opts.t1 != null || opts.t2 != null;
  const origNumRecs = layout.numrecs;
  let t1 = 0, t2 = origNumRecs - 1;
  const warnings    = [];
  if (haveT && keptRecord.length > 0) {
    t1 = opts.t1 ?? 0;
    t2 = opts.t2 != null ? opts.t2 : origNumRecs - 1;
    if (t1 >= origNumRecs)
      throw new SlimError(
        `NetCDF3 slim: t1=${t1} >= numrecs (${origNumRecs})`);
    if (t2 >= origNumRecs) t2 = origNumRecs - 1;
  } else if (haveT && keptRecord.length === 0) {
    warnings.push(
      'NetCDF3 slim: t1/t2 given but no kept variables are record vars; ' +
      'time slice ignored');
  }
  const newNumRecs = (haveT && keptRecord.length > 0)
                   ? (t2 - t1 + 1)
                   : origNumRecs;

  /* ── Write the new header with placeholder begins ───────────────────── */
  const hw  = new HeaderWriter(layout.version);
  const magic = new Uint8Array([0x43, 0x44, 0x46, layout.version]);
  hw.push(magic);
  hw.u32(newNumRecs);

  /* dim_list — keep every dim verbatim so dimids stay valid */
  if (layout.dims.length === 0) {
    hw.u32(TAG_ABSENT); hw.u32(0);
  } else {
    hw.u32(TAG_NC_DIMENSION);
    hw.u32(layout.dims.length);
    for (const d of layout.dims) {
      hw.writeName(d.name);
      hw.u32(d.is_unlimited ? 0 : d.length);
    }
  }

  /* gatt_list — global attrs verbatim */
  writeAttList(hw, layout.gatts);

  /* var_list — only kept variables, in original declaration order */
  if (keptVars.length === 0) {
    hw.u32(TAG_ABSENT); hw.u32(0);
  } else {
    hw.u32(TAG_NC_VARIABLE);
    hw.u32(keptVars.length);
    for (let i = 0; i < keptVars.length; i++) {
      const v = keptVars[i];
      hw.writeName(v.name);
      hw.u32(v.ndims);
      for (const did of v.dim_indices) hw.u32(did);
      writeAttList(hw, v.atts || []);
      hw.u32(v.type);
      hw.u32(v.vsize);
      hw.writeBeginPlaceholder(i);   /* patched below */
    }
  }

  const headerBytes = hw.build();
  const headerLen   = headerBytes.length;

  /* ── Compute new begins for each kept variable ──────────────────────── */
  const newBegin = new Array(keptVars.length);
  let off = headerLen;
  /* Non-record vars first, contiguous */
  for (let i = 0; i < keptVars.length; i++) {
    if (keptVars[i].is_record) continue;
    newBegin[i] = off;
    off += keptVars[i].vsize;
  }
  /* Record vars: each starts at its offset within the first record window */
  const recordRegionStart = off;
  let inRec = 0;
  for (let i = 0; i < keptVars.length; i++) {
    if (!keptVars[i].is_record) continue;
    newBegin[i] = recordRegionStart + inRec;
    inRec += keptVars[i].vsize;
  }
  const totalDataLen = recordRegionStart + newRecsize * newNumRecs;

  /* Patch the placeholder begins */
  for (let i = 0; i < keptVars.length; i++) {
    hw.patchBegin(headerBytes, i, newBegin[i]);
  }

  /* ── Allocate output, copy data spans ───────────────────────────────── */
  const out = new Uint8Array(headerLen + (totalDataLen - headerLen));
  out.set(headerBytes, 0);

  for (let i = 0; i < keptVars.length; i++) {
    const v = keptVars[i];
    if (!v.is_record) {
      out.set(data.subarray(v.begin, v.begin + v.vsize), newBegin[i]);
    }
  }
  for (let rNew = 0; rNew < newNumRecs; rNew++) {
    const rSrc = t1 + rNew;
    for (let i = 0; i < keptVars.length; i++) {
      const v = keptVars[i];
      if (!v.is_record) continue;
      const srcOff = v.begin   + rSrc * origRecsize;
      const dstOff = newBegin[i] + rNew * newRecsize;
      out.set(data.subarray(srcOff, srcOff + v.vsize), dstOff);
    }
  }

  return {
    bytes: out,
    warnings,
    variablesKept:    keptVars.length,
    variablesDropped: layout.vars.length - keptVars.length,
  };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function writeAttList(hw, atts) {
  if (!atts || atts.length === 0) {
    hw.u32(TAG_ABSENT); hw.u32(0);
    return;
  }
  hw.u32(TAG_NC_ATTRIBUTE);
  hw.u32(atts.length);
  for (const a of atts) {
    hw.writeName(a.name);
    hw.u32(a.type);
    hw.u32(a.nelems);
    const raw = b64ToBytes(a.value_b64);
    /* nelems may exceed what the parser stored inline (512 bytes cap); we
     * write what we have. Downstream readers tolerate this for v1. */
    const want = a.nelems * (TYPE_SIZE[a.type] || 1);
    const buf  = (raw.length === want) ? raw
              : (raw.length >   want) ? raw.subarray(0, want)
              : padTail(raw, want);
    hw.writeValues(buf);
  }
}

function padTail(buf, want) {
  const out = new Uint8Array(want);
  out.set(buf, 0);
  return out;
}
