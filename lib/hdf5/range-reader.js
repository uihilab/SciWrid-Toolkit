/*
 * lib/hdf5/range-reader.js
 *
 * Async, block-cached random-access reader over an HTTP(S) URL. Reads are
 * aligned to fixed blocks and cached, so the many small seeks an HDF5 parser
 * makes coalesce into a few Range requests. Reuses the library's fetchRange +
 * chunk-cache so byte accounting and s3/gs translation are shared.
 */
import { fetchRange, translateUrl } from '../sources/range-fetcher.js';
import { MemoryChunkCache, cacheKey } from '../sources/chunk-cache.js';

export class Hdf5RangeReader {
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
    // A 1-byte range reveals the total via Content-Range (works even when HEAD
    // is disallowed). Falls back to Content-Length.
    const res = await this._fetch(this._url, { headers: { Range: 'bytes=0-0' } });
    const cr = res.headers.get('content-range');       // "bytes 0-0/TOTAL"
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (m) return (this._size = Number(m[1]));
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > 0) return (this._size = cl);
    throw new Error('Hdf5RangeReader: cannot determine size of ' + this._url);
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

  /* Read exactly [offset, offset+length) (clamped to EOF). Returns a Uint8Array. */
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
