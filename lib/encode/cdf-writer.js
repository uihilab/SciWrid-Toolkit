/*
 * lib/encode/cdf-writer.js — NetCDF-3 (CDF) header primitives.
 *
 * Lifted out of lib/trim/trimNetCDF3.js so there is one CDF writer in the
 * repo rather than two: trim rewrites a header it parsed, the encoder builds
 * one from scratch, and both lay out bytes the same way.
 *
 * CDF-1 / CDF-2, big-endian throughout:
 *
 *   header  = magic 'CDF'\x01 | numrecs:u32 | dim_list | gatt_list | var_list
 *   dim_list = ABSENT | NC_DIMENSION nelems:u32 [ name  dim_length:u32 ]*
 *   att_list = ABSENT | NC_ATTRIBUTE  nelems:u32 [ name  nc_type:u32 nelems:u32 values ]*
 *   var_list = ABSENT | NC_VARIABLE   nelems:u32
 *              [ name ndims:u32 dimid*:u32 vatt_list nc_type:u32 vsize:u32 begin ]*
 *   name     = nelems:u32 chars, zero-padded to 4
 *   values   = raw bytes, zero-padded to 4
 *
 * Spec: https://docs.unidata.ucar.edu/nug/current/file_format_specifications.html
 */
import { SciWridError } from '../errors.js';

export const TAG_ABSENT       = 0x00000000;
export const TAG_NC_DIMENSION = 0x0000000A;
export const TAG_NC_VARIABLE  = 0x0000000B;
export const TAG_NC_ATTRIBUTE = 0x0000000C;

/* nc3_type → bytes per element (matches NC3_TYPE enum in netcdf3.h) */
export const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
export const NC_TYPE = { byte: 1, char: 2, short: 3, int: 4, float: 5, double: 6 };

export function pad4(n) { return (4 - (n % 4)) % 4; }

/* An attribute value as the header wants it: a type tag, a count and the
 * padded bytes. Strings become NC_CHAR, numbers NC_FLOAT (the only two the
 * encoder writes; trim copies its attribute bytes verbatim instead). */
export function attrBytes(value) {
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return { type: NC_TYPE.char, nelems: bytes.length, bytes };
  }
  const arr = Array.isArray(value) ? value : [value];
  const bytes = new Uint8Array(arr.length * 4);
  const dv = new DataView(bytes.buffer);
  arr.forEach((v, i) => dv.setFloat32(i * 4, v, false));
  return { type: NC_TYPE.float, nelems: arr.length, bytes };
}

export class HeaderWriter {
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

  /* One attribute: name, nc_type, nelems, padded values. */
  writeAttr(name, value) {
    const { type, nelems, bytes } = attrBytes(value);
    this.writeName(name);
    this.u32(type);
    this.u32(nelems);
    this.writeValues(bytes);
  }

  /* An att_list from a plain object; ABSENT when it has no entries. */
  writeAttrList(attrs) {
    const entries = Object.entries(attrs || {}).filter(([, v]) => v != null);
    if (!entries.length) { this.u32(TAG_ABSENT); this.u32(0); return; }
    this.u32(TAG_NC_ATTRIBUTE);
    this.u32(entries.length);
    for (const [k, v] of entries) this.writeAttr(k, v);
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
      throw new SciWridError(`NetCDF3 header: no begin slot for var index ${varIndex}`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (slot.width === 8) {
      const hi = Math.floor(begin / 0x100000000);
      const lo = begin >>> 0;
      dv.setUint32(slot.offset,     hi, false);
      dv.setUint32(slot.offset + 4, lo, false);
    } else {
      if (begin > 0xFFFFFFFF)
        throw new SciWridError(
          `NetCDF3 header: begin offset ${begin} doesn't fit in 32 bits (v1 format)`);
      dv.setUint32(slot.offset, begin >>> 0, false);
    }
  }
}
