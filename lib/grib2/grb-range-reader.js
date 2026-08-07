/*
 * lib/grib2/grb-range-reader.js
 * Exact-range random-access reader over an HTTP(S) URL for GRIB2 range access.
 * Unlike the HDF5 block-cached reader, GRIB2 access is well-sized (a ~1 KB
 * message header, or a full ~hundreds-of-KB message), so we fetch EXACTLY the
 * requested bytes — block alignment would over-fetch the header walk into the
 * whole file and destroy the transfer win. Reads are cached by (offset,length)
 * so an identical re-read (nearest-cell probe then decode of the same message)
 * is free. Reuses fetchRange + translateUrl + the chunk cache.
 */
import { fetchRange, remoteSize, translateUrl } from '../sources/range-fetcher.js';
import { MemoryChunkCache, cacheKey } from '../sources/chunk-cache.js';

export class GrbRangeReader {
  constructor(url, { fetchImpl = globalThis.fetch, cache } = {}) {
    this._url = translateUrl(url);
    this._fetch = fetchImpl;
    this._cache = cache || new MemoryChunkCache();
    this._size = null;
    this._stats = { requests: 0, bytes: 0 };
  }

  async size() {
    if (this._size != null) return this._size;
    return (this._size = await remoteSize(this._url, this._fetch));
  }

  /* Read exactly [offset, offset+length) (clamped to EOF), in one request. */
  async read(offset, length) {
    const total = await this.size();
    const end = Math.min(offset + length, total);
    const len = Math.max(0, end - offset);
    if (len === 0) return new Uint8Array(0);
    const key = cacheKey(this._url, offset, len);
    const hit = this._cache.get(key);
    if (hit) return hit;
    const bytes = await fetchRange(this._url, offset, len, this._fetch);
    this._stats.requests += 1;
    this._stats.bytes += bytes.length;
    this._cache.set(key, bytes);
    return bytes;
  }

  stats() { return { ...this._stats }; }
}
