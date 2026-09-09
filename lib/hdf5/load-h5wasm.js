/*
 * lib/hdf5/load-h5wasm.js
 *
 * One h5wasm loader for the whole library.
 *
 * Both the NetCDF4 reader (lib/sciwrid-lib.js) and the NetCDF4 writer
 * (lib/encode/netcdf4.js) need the module, and h5wasm's Emscripten FS is
 * process-global — loading it twice would mean two module instances and two
 * filesystems in the same realm. So resolution and caching live here.
 *
 * Resolution order, so consumers never have to `npm install h5wasm` separately:
 *   1. an explicit override URL, when the caller passes one
 *   2. Node / bundlers → the bare specifier `h5wasm` from node_modules
 *   3. browsers        → the ESM bundle from the jsdelivr CDN
 *
 * Returns { h5, FS } where h5 is the module and FS is the Emscripten FS.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/h5wasm@0.7.7/+esm';

/* Cached per realm, keyed by the specifier that won, so an override and the
 * default never hand back each other's module. */
const cache = new Map();

export async function loadH5wasm(overrideUrl) {
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const candidates = overrideUrl
    ? [overrideUrl]
    : isNode
      ? ['h5wasm', CDN]
      : [CDN, 'h5wasm'];

  const key = candidates.join('|');
  const hit = cache.get(key);
  if (hit) return hit;

  let mod, lastErr;
  for (const spec of candidates) {
    try { mod = await import(/* @vite-ignore */ spec); break; }
    catch (e) { lastErr = e; }
  }
  if (!mod) {
    throw new Error(
      'Failed to load h5wasm — tried ' + candidates.join(', ') +
      '. Last error: ' + (lastErr?.message || lastErr)
    );
  }

  const h5 = mod.default ?? mod;
  const { FS } = await h5.ready;
  const loaded = { h5, FS };
  cache.set(key, loaded);
  return loaded;
}
