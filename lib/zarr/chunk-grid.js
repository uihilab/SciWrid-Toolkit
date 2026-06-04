// lib/zarr/chunk-grid.js
//
// Chunk-grid traversal and reading. Walks every chunk of a Zarr array,
// decompresses it, applies filters, places it into the right slice of
// the output Float32Array.

import { decompressChunk } from './decompressors.js';
import { applyFilters }    from './filters.js';
import { parseDtype, parseFillValue } from './metadata.js';

/** Compute number of chunks along each axis, ceil(shape[i] / chunks[i]). */
export function chunkGridDims(shape, chunks) {
  return shape.map((s, i) => Math.ceil(s / chunks[i]));
}

/** Iterate every chunk index in row-major (C) order. */
export function* chunkIndices(grid) {
  const n = grid.length;
  const idx = new Array(n).fill(0);
  while (true) {
    yield idx.slice();
    let d = n - 1;
    while (d >= 0 && ++idx[d] === grid[d]) { idx[d] = 0; d--; }
    if (d < 0) return;
  }
}

/**
 * Copy one decoded chunk (typed array, length = product(chunks)) into the
 * destination flat float array at the right strided offsets.  Handles edge
 * chunks where shape[i] % chunks[i] !== 0 (the last chunk along each axis
 * is padded with fill_value in the file but the in-memory array uses
 * actual shape).
 */
export function placeChunk(dst, dstShape, chunkVals, chunks, chunkIdx, fill) {
  const ndim = dstShape.length;
  /* Strides for dst (C order) */
  const dstStrides = new Array(ndim);
  dstStrides[ndim - 1] = 1;
  for (let i = ndim - 2; i >= 0; i--) dstStrides[i] = dstStrides[i + 1] * dstShape[i + 1];

  /* Strides for the chunk (also C order, shape = chunks) */
  const chStrides = new Array(ndim);
  chStrides[ndim - 1] = 1;
  for (let i = ndim - 2; i >= 0; i--) chStrides[i] = chStrides[i + 1] * chunks[i + 1];

  /* Origin of this chunk in dst-coordinates, and per-axis effective length
   * (clipped to dstShape — handles partially-filled trailing chunks) */
  const origin = chunkIdx.map((c, i) => c * chunks[i]);
  const effLen = chunkIdx.map((c, i) =>
    Math.min(chunks[i], dstShape[i] - origin[i]));

  /* Recurse over axes; collapse the innermost run into a single copy. */
  function recurse(axis, dstOff, chOff) {
    if (axis === ndim - 1) {
      const n = effLen[axis];
      for (let k = 0; k < n; k++) {
        let v = chunkVals[chOff + k];
        /* Convert fill markers to NaN so query layer treats them as missing */
        if (Number.isFinite(fill) && v === fill) v = NaN;
        dst[dstOff + k] = v;
      }
      return;
    }
    for (let k = 0; k < effLen[axis]; k++) {
      recurse(axis + 1, dstOff + k * dstStrides[axis], chOff + k * chStrides[axis]);
    }
  }
  recurse(0, origin.reduce((s, o, i) => s + o * dstStrides[i], 0), 0);
}

/**
 * Read all chunks for an array, decompress, and reduce to a Float64Array.
 * Use this for axes that need full integer precision past 2^24 — notably
 * Unix-epoch time arrays where Float32 truncation would round to the nearest
 * ~128 seconds at 2024 dates.
 */
export async function readArrayAsFloat64(scanResult, arrayInfo) {
  const meta   = arrayInfo.meta;
  const shape  = meta.shape;
  const chunks = meta.chunks;
  const sep    = meta.dimension_separator || '.';

  if (meta.order && meta.order !== 'C')
    throw new Error('Only C-order arrays supported (got "' + meta.order + '")');

  const dt   = parseDtype(meta.dtype);
  const fill = parseFillValue(meta.fill_value);

  const totalLen = shape.reduce((a, b) => a * b, 1);
  const dst = new Float64Array(totalLen);
  if (dt.stringLike) {
    for (let i = 0; i < totalLen; i++) dst[i] = i;
    return dst;
  }
  if (Number.isFinite(fill)) dst.fill(fill);

  const grid = chunkGridDims(shape, chunks);

  for (const idx of chunkIndices(grid)) {
    const key = idx.join(sep);
    const raw = await scanResult.source.getChunkBytes(arrayInfo.name, key);
    if (!raw) continue;

    const dec0   = await decompressChunk(raw, meta.compressor);
    const dec    = await applyFilters(dec0, meta.filters, dt);
    const expect = chunks.reduce((a, b) => a * b, 1) * dt.bytes;
    if (dec.length < expect)
      throw new Error('Chunk ' + arrayInfo.name + '/' + key + ' decoded to ' +
                      dec.length + ' bytes, expected ' + expect);

    const typed = dt.view(dec, 0, chunks.reduce((a, b) => a * b, 1));
    placeChunk(dst, shape, typed, chunks, idx, fill);
  }
  return dst;
}

/**
 * Read all chunks for an array, decompress, and reduce to a Float32Array
 * of total length = product(shape).  Order is row-major.
 */
export async function readArrayAsFloat32(scanResult, arrayInfo) {
  const meta   = arrayInfo.meta;
  const shape  = meta.shape;
  const chunks = meta.chunks;
  const sep    = meta.dimension_separator || '.';

  if (meta.order && meta.order !== 'C')
    throw new Error('Only C-order arrays supported (got "' + meta.order + '")');

  const dt   = parseDtype(meta.dtype);
  const fill = parseFillValue(meta.fill_value);

  const totalLen = shape.reduce((a, b) => a * b, 1);
  const dst = new Float32Array(totalLen);
  if (dt.stringLike) {
    for (let i = 0; i < totalLen; i++) dst[i] = i;
    return dst;
  }
  if (Number.isFinite(fill)) dst.fill(fill);

  const grid = chunkGridDims(shape, chunks);

  for (const idx of chunkIndices(grid)) {
    const key = idx.join(sep);
    const raw = await scanResult.source.getChunkBytes(arrayInfo.name, key);

    /* Missing chunk → fill region with fill_value (already done above) */
    if (!raw) continue;

    const dec0   = await decompressChunk(raw, meta.compressor);
    const dec    = await applyFilters(dec0, meta.filters, dt);
    const expect = chunks.reduce((a, b) => a * b, 1) * dt.bytes;
    if (dec.length < expect)
      throw new Error('Chunk ' + arrayInfo.name + '/' + key + ' decoded to ' +
                      dec.length + ' bytes, expected ' + expect);

    const typed = dt.view(dec, 0, chunks.reduce((a, b) => a * b, 1));
    placeChunk(dst, shape, typed, chunks, idx, fill);
  }

  return dst;
}
