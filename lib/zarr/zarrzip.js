// lib/zarrzip.mjs
//
// Random access into a zipped Zarr store.
//
// A Zarr store is a key/value map, and a ZIP file is already exactly that -- a
// central directory mapping names to byte offsets. So the demo store is read
// the same way the cloud stores are: look up one chunk key, decompress one
// chunk. Nothing here reads the whole file, which is the point; unzipping 76 MB
// to answer a question about two years would be the behaviour this project
// exists to argue against.
//
// Node's zlib supplies the inflate, so this adds no dependency.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * Parse the central directory. Returns a key -> entry map; nothing is
 * decompressed until `read` is called for a specific key.
 */
export function openZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  /* The EOCD sits at the end, behind a comment of up to 64 KB. */
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff)
    throw new Error('zip64 stores are not supported yet');

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== CD_SIG)
      throw new Error(`corrupt central directory at entry ${n}`);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    has: (key) => entries.has(key),
    keys: () => entries.keys(),

    /* The compressed size, free: the central directory already carries it, so
       a zipped store can report its exact download cost without inflating a
       single chunk. */
    size: (key) => (entries.has(key) ? entries.get(key).compressedSize : null),

    /**
     * @returns {{ bytes: Uint8Array, compressedLength: number } | null}
     *          null when the key is absent -- an unwritten Zarr chunk, which
     *          means fill_value, not an error.
     */
    read(key) {
      const e = entries.get(key);
      if (!e) return null;

      /* The local header repeats the name and carries its own extra field,
         which is often a different length from the central one. */
      const lo = e.localOffset;
      if (dv.getUint32(lo, true) !== LFH_SIG)
        throw new Error(`corrupt local header for ${key}`);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const raw = bytes.subarray(start, start + e.compressedSize);

      if (e.method === 0) return { bytes: raw, compressedLength: e.compressedSize };
      if (e.method === 8)
        return { bytes: new Uint8Array(inflateRawSync(raw)), compressedLength: e.compressedSize };
      throw new Error(`unsupported zip compression method ${e.method} for ${key}`);
    },
  };
}
