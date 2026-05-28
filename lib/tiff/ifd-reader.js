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
  if (buf[0] === 0x49 && buf[1] === 0x49) le = true;
  else if (buf[0] === 0x4D && buf[1] === 0x4D)
    throw new UnsupportedFormatError('Big-endian TIFF not supported in v1');
  else
    throw new UnsupportedFormatError('Not a TIFF (bad byte-order mark)');

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint16(2, le);
  if (magic === 43) throw new UnsupportedFormatError('BigTIFF not supported in v1');
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
    out.push({ offset: nextIFD, tags });
    nextIFD = dv.getUint32(nextIFD + 2 + numTags * 12, le);
  }
  return out;
}
