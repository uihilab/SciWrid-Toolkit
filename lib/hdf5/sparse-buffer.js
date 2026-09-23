/*
 * lib/hdf5/sparse-buffer.js
 *
 * A file-sized buffer with only the interesting parts present.
 *
 * jsfive consumes its file as a plain ArrayBuffer -- it slices it and builds
 * DataViews over it at real file offsets -- so there is no reader interface to
 * hook. Metadata that lives near the end of a 182 MB file can therefore only
 * be parsed from a 182 MB buffer, even though the bytes worth having are a few
 * megabytes at each end.
 *
 * The trade this makes explicit: RAM proportional to FILE SIZE, network
 * proportional to WINDOW SIZE. That is the right way round for a range reader
 * -- 3 MB moved instead of 182 MB -- but it is not free, so the ceiling below
 * is declared rather than discovered when a 4 GB granule arrives.
 */

/* Refuse rather than allocate unboundedly. 1 GiB covers every archive probed
   on 2026-09-23 (the largest was NWM LDASOUT at 272 MB) with room to spare.
   Read per call, not captured at import, so a caller that sets the variable
   afterwards is not silently ignored. */
export const SPARSE_MAX_BYTES =
  Number(process.env.SCIWRID_HDF5_SPARSE_MAX_BYTES) || (1 << 30);

/**
 * Build a file-sized buffer holding only `windows`.
 *
 * @param reader   { read(offset, length) -> Promise<Uint8Array> }
 * @param size     the file's true length in bytes
 * @param windows  [{ start, length }] — clamped to the file; empty ones skipped
 * @returns { buffer: ArrayBuffer, bytesFilled: number }
 */
export async function assembleSparse(reader, size, windows) {
  if (size > SPARSE_MAX_BYTES)
    throw new Error(
      `sparse buffer: file is ${size} bytes, above the ${SPARSE_MAX_BYTES} byte ceiling. ` +
      `Raise SCIWRID_HDF5_SPARSE_MAX_BYTES deliberately, or use the whole-file path.`);

  const buf = new Uint8Array(size);
  let bytesFilled = 0;

  for (const w of windows ?? []) {
    const start = Math.max(0, Math.min(Number(w.start) || 0, size));
    const length = Math.min(Number(w.length) || 0, size - start);
    if (length <= 0) continue;
    const bytes = await reader.read(start, length);
    buf.set(bytes.subarray(0, Math.min(bytes.length, size - start)), start);
    bytesFilled += bytes.length;
  }

  return { buffer: buf.buffer, bytesFilled };
}
