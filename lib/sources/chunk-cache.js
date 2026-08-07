/*
 * lib/sources/chunk-cache.js
 *
 * ChunkCache interface: { get(key): Uint8Array|null, set(key, bytes): void }.
 * MemoryChunkCache is an LRU bounded by total bytes. Cache keys are immutable
 * byte ranges: "<url>:<offset>:<length>".
 */

export function cacheKey(url, offset, length) {
  return url + ':' + offset + ':' + length;
}

export class MemoryChunkCache {
  constructor(maxBytes = 64 * 1024 * 1024) {
    this._max = maxBytes;
    this._bytes = 0;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return null;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }

  set(key, bytes) {
    if (this._map.has(key)) {
      this._bytes -= this._map.get(key).length;
      this._map.delete(key);
    }
    this._map.set(key, bytes);
    this._bytes += bytes.length;
    while (this._bytes > this._max && this._map.size > 1) {
      const oldest = this._map.keys().next().value;
      this._bytes -= this._map.get(oldest).length;
      this._map.delete(oldest);
    }
  }
}
