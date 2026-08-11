/*
 * lib/hdf5/range-reader.js
 *
 * Async, block-cached random-access reader over an HTTP(S) URL. Reads are
 * aligned to fixed blocks and cached, so the many small seeks an HDF5 parser
 * makes coalesce into a few Range requests. Reuses the library's fetchRange +
 * chunk-cache so byte accounting and s3/gs translation are shared.
 */
import { fetchRange, remoteSize, translateUrl } from '../sources/range-fetcher.js';
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
    return (this._size = await remoteSize(this._url, this._fetch));
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

  /* The longest run of bytes from offset 0 that this reader has already
   * fetched, or null if it has fetched none.
   *
   * Reads start at 0 and grow, so the front of the file is normally a solid
   * run of cached blocks -- but the cache is an LRU, so a long enough read can
   * evict an early block. The loop therefore stops at the first gap rather
   * than assuming the run is complete: a short prefix is still worth carrying,
   * a prefix with a hole in it is not a prefix.
   *
   * Only the reader's own block reads land here. Chunk fetches deliberately
   * bypass the reader (see decodeChunk), and they are scattered through the
   * file rather than at the front, so they could not extend a prefix anyway. */
  prefix() {
    const blocks = [];
    let total = 0;
    for (let bi = 0; ; bi++) {
      const blk = this._cache.get(cacheKey(this._url, bi * this._block, this._block));
      if (!blk || blk.length === 0) break;
      blocks.push(blk);
      total += blk.length;
      if (blk.length < this._block) break;         // last block of the file
    }
    if (!total) return null;
    if (blocks.length === 1) return blocks[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of blocks) { out.set(b, at); at += b.length; }
    return out;
  }

  stats() { return { ...this._stats }; }
}
