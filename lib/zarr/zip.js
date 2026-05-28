// lib/zarr/zip.js
//
// Tiny ZIP reader — central-directory walker, supports stored (method 0)
// and deflate (method 8) entries. Lifted verbatim from zarr-helper.js.
// No external deps.

import { inflateRaw } from './decompressors.js';

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG   = 0x02014b50;

/** Locate the End-of-Central-Directory record (last 22..65557 bytes). */
export function findEOCD(buf) {
  const dv  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD_SIG) return i;
  }
  throw new Error('Not a ZIP file (EOCD signature not found)');
}

/**
 * Parse a ZIP-of-zarr buffer into a flat map { entryName: Uint8Array }.
 * Supports stored (method 0) and deflate (method 8).
 */
export async function readZip(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const eocd      = findEOCD(buf);
  const cdEntries = dv.getUint16(eocd + 10, true);
  const cdSize    = dv.getUint32(eocd + 12, true);
  const cdOffset  = dv.getUint32(eocd + 16, true);

  const out = {};
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < cdEntries && p < cdEnd; i++) {
    if (dv.getUint32(p, true) !== ZIP_CD_SIG)
      throw new Error('ZIP central directory corrupt at ' + p);

    const method     = dv.getUint16(p + 10, true);
    const compSize   = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen    = dv.getUint16(p + 28, true);
    const extraLen   = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lhOffset   = dv.getUint32(p + 42, true);

    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    /* Skip directory entries (trailing slash) */
    if (!name.endsWith('/')) {
      /* Local-file-header: 30 bytes + name + extra → then data */
      const lhNameLen  = dv.getUint16(lhOffset + 26, true);
      const lhExtraLen = dv.getUint16(lhOffset + 28, true);
      const dataStart  = lhOffset + 30 + lhNameLen + lhExtraLen;
      const compBytes  = buf.subarray(dataStart, dataStart + compSize);

      let bytes;
      if (method === 0) {
        bytes = compBytes;
      } else if (method === 8) {
        bytes = await inflateRaw(compBytes, uncompSize);
      } else {
        throw new Error('Unsupported ZIP method ' + method + ' for ' + name);
      }
      out[name] = bytes;
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
