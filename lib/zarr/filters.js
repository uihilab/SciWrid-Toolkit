// lib/zarr/filters.js
//
// Zarr v2 chunk filters: shuffle decode (used by blosc), and the
// applyFilters dispatcher. We don't yet support fixedscaleoffset/delta.
//
// Filters are applied in forward order on encode and reverse order on
// decode (spec: zarr.readthedocs.io/en/v2.13.6/spec/v2.html#filters).
// numcodecs JS port (0.3.x) only ships compressors, so filter codecs are
// hand-rolled here. Currently supported: `shuffle`. Anything else throws
// with the filter id named so a corrupt store is one stack trace.

/**
 * HDF5/Zarr-style byte un-shuffle. Mirror of shuffleEncode in the fixture
 * builder. For elementsize=4 and N elements (input.length = N*4):
 *   in  = [a0,b0,c0,..., a1,b1,c1,..., a2,b2,c2,..., a3,b3,c3,...]
 *   out = [a0,a1,a2,a3, b0,b1,b2,b3, c0,c1,c2,c3, ...]
 */
function shuffleDecode(input, elementsize) {
  const count = input.length / elementsize;
  if (!Number.isInteger(count))
    throw new Error('shuffleDecode: input length ' + input.length +
      ' not a multiple of elementsize ' + elementsize);
  const out = new Uint8Array(input.length);
  for (let j = 0; j < elementsize; j++) {
    for (let i = 0; i < count; i++) {
      out[i * elementsize + j] = input[j * count + i];
    }
  }
  return out;
}

export async function applyFilters(bytes, filters, dtype) {
  if (!filters || filters.length === 0) return bytes;
  let buf = bytes;
  /* Reverse order: undo last-encoded filter first */
  for (let i = filters.length - 1; i >= 0; i--) {
    const f  = filters[i];
    const id = String((f && f.id) || '').toLowerCase();
    if (id === 'shuffle') {
      const elementsize = (f.elementsize != null) ? f.elementsize : dtype.bytes;
      buf = shuffleDecode(buf, elementsize);
    } else {
      throw new Error("Zarr filter '" + id + "' not supported " +
        "(currently supported: shuffle). " +
        "fletcher32 / fixedscaleoffset / delta are tracked as follow-ups.");
    }
  }
  return buf;
}
