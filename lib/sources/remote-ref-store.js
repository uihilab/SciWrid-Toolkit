/*
 * lib/sources/remote-ref-store.js
 *
 * ChunkSource backed by a kerchunk RefIndex whose chunk refs are remote
 * (http/https/s3/gs). Fetches byte ranges via fetchRange and caches them.
 */

import { fetchRange } from './range-fetcher.js';
import { MemoryChunkCache, cacheKey } from './chunk-cache.js';

export class RemoteKerchunkRefStore {
  constructor(refIndex, arrays, { cache, fetchImpl } = {}) {
    this._refs = refIndex;
    this._arrays = arrays;
    this._cache = cache || new MemoryChunkCache();
    this._fetch = fetchImpl;
  }

  listArrays() { return this._arrays; }

  async getChunkBytes(arrayName, chunkKey) {
    const ref = this._refs.getRef(arrayName, chunkKey);
    if (!ref) return null;
    if (ref.kind === 'inline') return ref.bytes;
    if (ref.kind !== 'remote') {
      throw new Error("RemoteKerchunkRefStore: non-remote ref kind '" + ref.kind +
        "' for chunk '" + arrayName + '/' + chunkKey + "'");
    }

    const key = cacheKey(ref.url, ref.offset, ref.length);
    const hit = this._cache.get(key);
    if (hit) return hit;

    let bytes;
    try {
      bytes = await fetchRange(ref.url, ref.offset, ref.length, this._fetch);
    } catch (e) {
      throw new Error("chunk '" + arrayName + '/' + chunkKey +
        "' fetch failed from '" + ref.url + "': " + (e && e.message ? e.message : e));
    }
    this._cache.set(key, bytes);
    return bytes;
  }

  async close() {}
}
