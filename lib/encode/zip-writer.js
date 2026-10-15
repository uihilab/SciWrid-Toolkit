/*
 * lib/encode/zip-writer.js — the ZIP container both Zarr paths write.
 *
 * Lifted out of lib/trim/trimZarr.js, which re-emits entries copied from a
 * source archive; the encoder builds every entry from scratch. Both go
 * through this one writer.
 *
 * An entry is either
 *   synthetic:   { name, bytes }                        method 0 (stored)
 *   passthrough: { name, method, compSize, uncompSize, dataOff }
 *                                                       a span of sourceData
 *
 * CRC-32 is computed whenever the uncompressed bytes are on hand — every
 * synthetic entry, and stored (method 0) passthrough entries, where the
 * compressed bytes are the uncompressed bytes. This repo's own readers ignore
 * the field, but Python's zipfile, Windows Explorer and zarr's ZipStore all
 * reject an archive whose CRC is wrong, and an export other tools cannot open
 * is not an export. Deflated passthrough entries keep 0: recovering their CRC
 * would mean inflating every entry, which is trim's existing trade-off.
 */

/* Standard CRC-32 (IEEE 802.3), table built once on first use. */
let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function buildZip(entries, sourceData) {
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
    /* method 0 means payload === the uncompressed bytes, so its CRC is known */
    const crc        = (e.bytes || method === 0) ? crc32(payload) : 0;

    /* Local file header (30B + name) */
    const lh   = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0,  0x04034b50, true);
    lhDV.setUint16(4,  20, true);
    lhDV.setUint16(6,  0,  true);
    lhDV.setUint16(8,  method, true);
    lhDV.setUint16(10, 0,  true);
    lhDV.setUint16(12, 0,  true);
    lhDV.setUint32(14, crc, true);
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
    cdDV.setUint32(16, crc, true);
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
