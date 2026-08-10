/*
 * lib/hdf5/vfs-name.js
 *
 * Unique path names for the h5wasm virtual filesystem.
 *
 * h5wasm's Emscripten FS is a single process-global mount. Every
 * SciWridToolkit instance and every trim() call in a realm writes into the
 * same namespace, so two concurrent opens must never pick the same path.
 *
 * `_wp_${Date.now()}.nc` was not enough. Date.now() has millisecond
 * resolution, and opening a file takes well under a millisecond, so two opens
 * that overlap collide on the name. MEMFS then truncates and rewrites the
 * existing node in place rather than creating a second one, which produces
 * two silent failures:
 *
 *   1. the handle opened first goes on reading the same path and now sees the
 *      second file's bytes -- wrong data, no error;
 *   2. whichever finishes first unlinks the shared path out from under the
 *      other.
 *
 * A monotonic counter cannot collide within a realm, and a realm is the exact
 * scope the FS spans, so it is a guarantee rather than a probability. The
 * timestamp is kept only because it makes a leaked file easy to place in
 * time. One counter is shared by every caller, so prefixes never have to be
 * checked against each other for overlap.
 */

let seq = 0;

/**
 * Build a collision-free name for the h5wasm virtual FS.
 *
 * @param {string} prefix - caller tag, e.g. '_wp' or '_wp_trim_src'
 * @param {string} [ext]  - file extension including the dot
 * @returns {string}
 */
export function h5TempName(prefix, ext = '.nc') {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}${ext}`;
}
