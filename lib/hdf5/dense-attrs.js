/*
 * lib/hdf5/dense-attrs.js — read HDF5 attributes that jsfive cannot see.
 *
 * WHY THIS EXISTS
 *
 * jsfive 0.4 only reads attributes stored as Attribute messages (0x000C) inside
 * the object header. That is HDF5's "compact" attribute storage. Its
 * get_attributes() carries the gap as a comment:
 *
 *     //# TODO attributes may also be stored in objects reference in the
 *     //# Attribute Info Message (0x0015, 21).
 *
 * That TODO is not an edge case. netCDF-C sets attribute creation order to
 * TRACKED|INDEXED, and HDF5 switches an object to "dense" storage as soon as
 * creation order is indexed -- regardless of how few attributes it has. So on
 * any file written by a modern netCDF-C, EVERY dataset's object header holds an
 * Attribute Info message and NO attribute messages, and jsfive reports `{}` for
 * all of them. Confirmed on examples/idalia/idalia-nldas2.nc (netcdf 4.9.3 /
 * hdf5 1.14.6): all four datasets have a 0x0015 message and no 0x000C, so
 * `lat`, `lon`, `time` and `Rainf` each came back with no attributes at all,
 * while the root group -- which has one attribute and no creation-order index,
 * hence compact storage -- parsed fine. That asymmetry is what made the bug
 * look like jsfive being randomly broken.
 *
 * The cost of the gap: the range path could not read `time`'s `units`, so
 * decodeTimes threw and every range-extracted timeseries came back with
 * time: null, and no variable could report its `units`.
 *
 * HOW IT WORKS
 *
 * Dense attributes live in a fractal heap, with two version-2 B-trees indexing
 * them (by name hash, and by creation order). We do not need either index: the
 * heap's managed objects ARE the attribute messages, laid out back to back in
 * the direct block, so walking the block start to end enumerates them.
 *
 * Each message is self-describing, which is what makes the walk safe -- the
 * version-3 header gives the name/datatype/dataspace sizes, and the value size
 * follows from the datatype's element size times the dataspace's element count.
 * Sum those and you have the offset of the next message. Anything that does not
 * parse as a valid message stops the walk rather than being guessed at.
 *
 * DECODING is deliberately NOT reimplemented here. The heap block sits inside
 * the same buffer jsfive already parsed, at a real file offset, so we hand each
 * message's offset back to jsfive's own unpack_attribute(). It resolves
 * datatypes, dataspaces, string encodings and variable-length strings (whose
 * data lives in a global heap elsewhere in the file) exactly as it does for
 * compact attributes. This module only has to find the messages; jsfive still
 * owns what they mean.
 *
 * LIMITS (each returns what was found so far, never a wrong value):
 *   - heaps whose root is an indirect block (many or large attributes)
 *   - heaps with an I/O filter pipeline
 *   - huge/tiny heap objects, which are stored outside the direct block
 * The caller falls back to jsfive's compact attributes, i.e. today's behaviour.
 *
 * Like jsfive itself, this assumes 8-byte offsets and lengths (the superblock
 * field), which is what every netCDF4/HDF5 writer in practice emits.
 */

const ATTR_INFO_MSG_TYPE = 0x0015;

/* A short buffer is not a corrupt file -- on the range path it means the front
 * buffer has not grown far enough to cover the heap yet. RangeError is the
 * signal _parseMetaAndChunks already retries on, so use it rather than
 * returning null (which would be read as "no dense attributes here"). */
function need(view, offset, length) {
  if (offset < 0 || offset + length > view.byteLength)
    throw new RangeError('dense attributes: buffer ends before offset ' + (offset + length));
}

/* Address fields are 8 bytes; anything at all-ones is HDF5's "undefined". */
function readAddr(view, offset) {
  need(view, offset, 8);
  const v = view.getBigUint64(offset, true);
  return v === 0xffffffffffffffffn ? null : Number(v);
}

/* The Attribute Info message (IV.A.2.v). We want only the fractal heap
 * address; the two B-tree addresses that follow are indexes into the same heap
 * and the walk below does not need them. */
function parseAttrInfo(view, offset) {
  need(view, offset, 2);
  const version = view.getUint8(offset);
  if (version !== 0) return null;
  const flags = view.getUint8(offset + 1);
  let p = offset + 2;
  if (flags & 0x01) p += 2;              // maximum creation index
  return readAddr(view, p);              // fractal heap address
}

/* Fractal heap header (III.G). Fixed layout at 8-byte offsets/lengths, so the
 * field positions are constants rather than a parsed struct. */
function parseHeapHeader(view, offset) {
  need(view, offset, 142);
  if (String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
                          view.getUint8(offset + 2), view.getUint8(offset + 3)) !== 'FRHP')
    return null;
  if (view.getUint8(offset + 4) !== 0) return null;          // version
  if (view.getUint16(offset + 7, true) !== 0) return null;   // I/O filters: unsupported
  return {
    flags:           view.getUint8(offset + 9),
    managedCount:    Number(view.getBigUint64(offset + 70, true)),
    startBlockSize:  Number(view.getBigUint64(offset + 112, true)),
    log2MaxHeapSize: view.getUint16(offset + 128, true),
    rootAddress:     readAddr(view, offset + 132),
    currentRows:     view.getUint16(offset + 140, true),
  };
}

/* Bytes before the first object in a direct block (III.G): signature, version,
 * a back-pointer to the heap header, the block's offset in the heap's address
 * space (sized by log2MaxHeapSize), and an optional checksum. */
function directBlockDataStart(view, addr, h) {
  need(view, addr, 5);
  if (String.fromCharCode(view.getUint8(addr), view.getUint8(addr + 1),
                          view.getUint8(addr + 2), view.getUint8(addr + 3)) !== 'FHDB')
    return null;
  if (view.getUint8(addr + 4) !== 0) return null;            // version
  const blockOffsetSize = Math.ceil(h.log2MaxHeapSize / 8);
  return addr + 4 + 1 + 8 + blockOffsetSize + ((h.flags & 0x02) ? 4 : 0);
}

const padded = (n, multiple) => (multiple <= 1 ? n : Math.ceil(n / multiple) * multiple);

/* Number of elements described by a Dataspace message. A scalar dataspace has
 * dimensionality 0, hence the empty-product 1. */
function dataspaceCount(view, offset) {
  need(view, offset, 2);
  const version = view.getUint8(offset);
  const ndims = view.getUint8(offset + 1);
  let p;
  if (version === 1) p = offset + 8;
  else if (version === 2) p = offset + 4;
  else return null;
  let n = 1;
  for (let d = 0; d < ndims; d++) {
    need(view, p, 8);
    n *= Number(view.getBigUint64(p, true));
    p += 8;
  }
  return n;
}

/* Measure the attribute message at `offset` -> { size, decodable }, or null
 * if it does not parse as one. `size` is the whole trick: it is what lets the
 * walk find the next message without consulting an index. */
function attributeMessageSize(view, offset) {
  need(view, offset, 1);
  const version = view.getUint8(offset);
  let headerSize, pad;
  if (version === 1) { headerSize = 8; pad = 8; }        // fields padded to 8
  else if (version === 3) { headerSize = 9; pad = 1; }   // packed, plus a charset byte
  else return null;

  need(view, offset, headerSize);
  const nameSize      = view.getUint16(offset + 2, true);
  const datatypeSize  = view.getUint16(offset + 4, true);
  const dataspaceSize = view.getUint16(offset + 6, true);
  if (!nameSize || !datatypeSize || !dataspaceSize) return null;

  const datatypeAt  = offset + headerSize + padded(nameSize, pad);
  /* Datatype message: class+version(1), class bit fields(3), then the size of
   * one element in bytes. Variable-length types report 16 here -- the size of
   * the global-heap reference actually stored -- which is exactly what we want
   * for advancing past the data. */
  need(view, datatypeAt, 8);
  const elementSize = view.getUint32(datatypeAt + 4, true);

  const dataspaceAt = datatypeAt + padded(datatypeSize, pad);
  const count = dataspaceCount(view, dataspaceAt);
  if (count == null || count < 0) return null;

  const dataAt = dataspaceAt + padded(dataspaceSize, pad);
  return {
    size: (dataAt - offset) + count * elementSize,
    decodable: carriesMetadata(view, datatypeAt),
  };
}

/* Datatype classes worth decoding: integers, floats, and strings, plus enums
 * (an integer with labels) and variable-length strings.
 *
 * Everything else in an HDF5 file's attributes is writer bookkeeping rather
 * than metadata. The ones that actually turn up in netCDF4 are REFERENCE_LIST
 * (a compound of object reference + index, class 6) and DIMENSION_LIST (a
 * variable-length sequence of object references, class 9 over class 7) -- the
 * dimension-scale links tying a coordinate variable to the datasets that use
 * it. Their values are file addresses. jsfive cannot decode either one: it
 * returns null and prints "Attribute REFERENCE_LIST type not implemented" for
 * every dataset it sees. Filtering here keeps a range scan quiet without
 * suppressing a warning that would be worth reading somewhere else.
 *
 * A skipped message is still measured and stepped over -- only the decode is
 * skipped -- so the walk stays aligned on the next one. */
function carriesMetadata(view, datatypeAt) {
  const cls = view.getUint8(datatypeAt) & 0x0f;
  if (cls === 9) {                    // variable-length: only over strings
    need(view, datatypeAt + 8, 1);
    return (view.getUint8(datatypeAt + 8) & 0x0f) === 3;
  }
  return cls === 0 || cls === 1 || cls === 3 || cls === 8;
}

/**
 * readDenseAttrs(dob) -> { name: value } | null
 *
 * `dob` is a jsfive DataObjects (`dataset._dataobjects`): it carries the file
 * buffer as `.fh` and the object header messages as `.msgs`, and its
 * `unpack_attribute(offset)` decodes one message at a file offset.
 *
 * Returns null when the object stores no dense attributes -- the caller should
 * then use jsfive's compact ones. Throws RangeError when the buffer is too
 * short, so the range path's grow-and-retry loop can react.
 */
export function readDenseAttrs(dob) {
  if (!dob || !dob.fh || !Array.isArray(dob.msgs)) return null;

  const infoMsg = dob.msgs.find(
    (m) => (m.get ? m.get('type') : m.type) === ATTR_INFO_MSG_TYPE);
  if (!infoMsg) return null;

  const view = new DataView(dob.fh);
  const heapAddress = parseAttrInfo(
    view, infoMsg.get ? infoMsg.get('offset_to_message') : infoMsg.offset_to_message);
  if (heapAddress == null) return null;

  const header = parseHeapHeader(view, heapAddress);
  if (!header || header.rootAddress == null) return null;
  /* currentRows > 0 means the root is an indirect block: the objects are spread
   * over a doubling table of direct blocks rather than the single block below.
   * Declining is honest; guessing would read the wrong bytes. */
  if (header.currentRows > 0) return null;

  const start = directBlockDataStart(view, header.rootAddress, header);
  if (start == null) return null;
  const end = header.rootAddress + header.startBlockSize;

  const attrs = {};
  let offset = start;
  let found = 0;
  while (offset < end && found < header.managedCount) {
    let msg;
    try { msg = attributeMessageSize(view, offset); }
    catch (e) { if (e instanceof RangeError) throw e; msg = null; }
    /* Trailing free space, or a hole left by a deleted attribute. Either way
     * the bytes ahead are no longer a message stream, so stop with what we
     * have rather than decoding garbage into an attribute value. */
    if (msg == null || msg.size <= 0 || offset + msg.size > end) break;

    if (msg.decodable) {
      try {
        const [name, value] = dob.unpack_attribute(offset);
        if (name) attrs[name] = value;
      } catch (e) {
        if (e instanceof RangeError) throw e;
        /* One undecodable attribute must not cost us the rest: its size came
         * from the header, so the next message is still locatable. */
      }
    }
    found += 1;
    offset += msg.size;
  }
  return found ? attrs : null;
}

/**
 * attrsOf(dataset) -> { name: value }
 *
 * The attribute accessor the rest of the library should use in place of
 * `dataset.attrs`, which silently returns `{}` for dense storage. Compact and
 * dense are alternatives in HDF5, never both, but they are merged rather than
 * chosen between so that neither source can be lost if that ever stops holding.
 */
export function attrsOf(dataset) {
  const compact = (dataset && dataset.attrs) || {};
  let dense = null;
  try { dense = readDenseAttrs(dataset && dataset._dataobjects); }
  catch (e) { if (e instanceof RangeError) throw e; }
  return dense ? { ...compact, ...dense } : compact;
}
