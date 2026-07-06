/*
 * lib/grib2/grb-range-reader.js
 * Block-cached random-access reader over an HTTP(S) URL for GRIB2 range access.
 * Mirrors lib/hdf5/range-reader.js: aligned block reads coalesce the indexer's
 * many small seeks into a few Range requests; reuses fetchRange + chunk cache.
 */
import { fetchRange, translateUrl } from '../sources/range-fetcher.js';
import { MemoryChunkCache, cacheKey } from '../sources/chunk-cache.js';

export class GrbRangeReader {
  constructor(url, { fetchImpl = globalThis.fetch, cache, blockSize = 1 << 20 } = {}) {
    this._url = translateUrl(url);
    this._fetch = fetchImpl;
    this._cache = cache || new MemoryChunkCache();
    this._block = blockSize;
    this._size = null;
    this._stats = { requests: 0, bytes: 0 };
  }

  async size() {
    if (this._size != null) return this._size;
    const res = await this._fetch(this._url, { headers: { Range: 'bytes=0-0' } });
    const cr = res.headers.get('content-range');       // "bytes 0-0/TOTAL"
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) return (this._size = Number(m[1]));
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > 0) return (this._size = cl);
    throw new Error('GrbRangeReader: cannot determine size of ' + this._url);
  }

  async _blockAt(blockIndex) {
    const start = blockIndex * this._block;
    const key = cacheKey(this._url, start, this._block);
    const hit = this._cache.get(key);
    if (hit) return hit;
    const total = await this.size();
    if (start >= total) return new Uint8Array(0);
    const len = Math.min(this._block, total - start);
    const bytes = await fetchRange(this._url, start, len, this._fetch);
    this._stats.requests += 1;
    this._stats.bytes += bytes.length;
    this._cache.set(key, bytes);
    return bytes;
  }

  async read(offset, length) {
    const total = await this.size();
    const end = Math.min(offset + length, total);
    const out = new Uint8Array(Math.max(0, end - offset));
    let done = 0;
    while (offset + done < end) {
      const pos = offset + done;
      const bi = Math.floor(pos / this._block);
      const blk = await this._blockAt(bi);
      const within = pos - bi * this._block;
      const n = Math.min(out.length - done, blk.length - within);
      if (n <= 0) break;
      out.set(blk.subarray(within, within + n), done);
      done += n;
    }
    return out;
  }

  stats() { return { ...this._stats }; }
}
