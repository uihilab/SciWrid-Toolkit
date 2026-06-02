// lib/tiff/ifd-reader.js
//
// Parse the TIFF header + IFD chain. Build a per-IFD tag map.
// No decoding here — just structural parsing.

import { UnsupportedFormatError, SourceError } from '../errors.js';

const TYPE_SIZE = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };

function readValues(dv, le, offset, type, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1:  case 7:  out.push(dv.getUint8(offset + i)); break;
      case 2:           out.push(dv.getUint8(offset + i)); break;     // ASCII: caller can decode bytes
      case 3:           out.push(dv.getUint16(offset + i * 2, le)); break;
      case 4:           out.push(dv.getUint32(offset + i * 4, le)); break;
      case 5: {                                                          // RATIONAL
        const num = dv.getUint32(offset + i * 8, le);
        const den = dv.getUint32(offset + i * 8 + 4, le);
        out.push([num, den]);
        break;
      }
      case 6:           out.push(dv.getInt8(offset + i)); break;
      case 8:           out.push(dv.getInt16(offset + i * 2, le)); break;
      case 9:           out.push(dv.getInt32(offset + i * 4, le)); break;
      case 10: {                                                         // SRATIONAL
        const num = dv.getInt32(offset + i * 8, le);
        const den = dv.getInt32(offset + i * 8 + 4, le);
        out.push([num, den]);
        break;
      }
      case 11:          out.push(dv.getFloat32(offset + i * 4, le)); break;
      case 12:          out.push(dv.getFloat64(offset + i * 8, le)); break;
      default:
        throw new SourceError(`tiff: unknown tag type ${type}`);
    }
  }
  return out;
}

/**
 * Parse the full IFD chain. Returns Array<{ offset, tags: Map<tag, { tag, type, values }> }>.
 * Tag values are read inline (when ≤4 bytes) or from the external offset.
 */
export function parseIFDs(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < 8) throw new SourceError('tiff: file shorter than header');

  // Byte order
  let le;
  if      (buf[0] === 0x49 && buf[1] === 0x49) le = true;
  else if (buf[0] === 0x4D && buf[1] === 0x4D) le = false;
  else throw new UnsupportedFormatError('Not a TIFF (bad byte-order mark)');

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint16(2, le);
  if (magic === 43) return parseBigTIFF(buf, dv, le);
  if (magic !== 42) throw new UnsupportedFormatError(`Not a TIFF (magic ${magic})`);

  const out = [];
  let nextIFD = dv.getUint32(4, le);
  const seen = new Set();
  while (nextIFD !== 0) {
    if (seen.has(nextIFD))
      throw new SourceError(`tiff: cyclic IFD chain at offset ${nextIFD}`);
    if (nextIFD >= buf.length)
      throw new SourceError(`tiff: IFD offset ${nextIFD} past EOF (${buf.length})`);
    seen.add(nextIFD);

    const numTags = dv.getUint16(nextIFD, le);
    const tags = new Map();
    for (let i = 0; i < numTags; i++) {
      const p = nextIFD + 2 + i * 12;
      const tag   = dv.getUint16(p, le);
      const type  = dv.getUint16(p + 2, le);
      const count = dv.getUint32(p + 4, le);
      const sz    = (TYPE_SIZE[type] || 0) * count;

      let valuesOffset;
      if (sz <= 4) {
        valuesOffset = p + 8;
      } else {
        valuesOffset = dv.getUint32(p + 8, le);
        if (valuesOffset + sz > buf.length)
          throw new SourceError(`tiff: tag ${tag} value spans past EOF`);
      }
      const values = TYPE_SIZE[type] ? readValues(dv, le, valuesOffset, type, count) : [];
      tags.set(tag, { tag, type, values });
    }
    out.push({ offset: nextIFD, tags, le, bigtiff: false });
    nextIFD = dv.getUint32(nextIFD + 2 + numTags * 12, le);
  }
  return out;
}

/**
 * BigTIFF (magic === 43): 64-bit offsets throughout. Header layout:
 *   bytes 0..1  : byte-order mark
 *   bytes 2..3  : magic (always 43)
 *   bytes 4..5  : offset size (always 8)
 *   bytes 6..7  : constant zero
 *   bytes 8..15 : 64-bit offset of the first IFD
 *
 * IFD layout:
 *   bytes 0..7              : numTags (uint64)
 *   bytes 8 + 20*i + 0..1   : tag id
 *   bytes 8 + 20*i + 2..3   : type
 *   bytes 8 + 20*i + 4..11  : count (uint64)
 *   bytes 8 + 20*i + 12..19 : valueOrOffset (uint64)
 *   bytes 8 + 20*N          : next-IFD offset (uint64)
 */
function parseBigTIFF(buf, dv, le) {
  const offsetSize = dv.getUint16(4, le);
  const constant   = dv.getUint16(6, le);
  if (offsetSize !== 8 || constant !== 0)
    throw new UnsupportedFormatError(
      `BigTIFF: malformed header (offsetSize=${offsetSize}, constant=${constant})`);
  if (buf.length < 16) throw new SourceError('BigTIFF: file shorter than header');

  const out = [];
  let nextIFD = Number(dv.getBigUint64(8, le));
  const seen = new Set();
  while (nextIFD !== 0) {
    if (seen.has(nextIFD))
      throw new SourceError(`bigtiff: cyclic IFD chain at offset ${nextIFD}`);
    if (nextIFD >= buf.length)
      throw new SourceError(`bigtiff: IFD offset ${nextIFD} past EOF (${buf.length})`);
    seen.add(nextIFD);

    const numTags = Number(dv.getBigUint64(nextIFD, le));
    const tags = new Map();
    for (let i = 0; i < numTags; i++) {
      const p = nextIFD + 8 + i * 20;
      const tag   = dv.getUint16(p,     le);
      const type  = dv.getUint16(p + 2, le);
      const count = Number(dv.getBigUint64(p + 4, le));
      const sz    = (TYPE_SIZE[type] || 0) * count;

      let valuesOffset;
      if (sz <= 8) {
        valuesOffset = p + 12;
      } else {
        valuesOffset = Number(dv.getBigUint64(p + 12, le));
        if (valuesOffset + sz > buf.length)
          throw new SourceError(`bigtiff: tag ${tag} value spans past EOF`);
      }
      const values = TYPE_SIZE[type] ? readValues(dv, le, valuesOffset, type, count) : [];
      tags.set(tag, { tag, type, values });
    }
    out.push({ offset: nextIFD, tags, le, bigtiff: true });
    nextIFD = Number(dv.getBigUint64(nextIFD + 8 + numTags * 20, le));
  }
  return out;
}
