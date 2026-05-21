/*
 * lib/kerchunk/ref-store.js
 *
 * ChunkSource implementation backed by a kerchunk RefIndex + Node fs.
 * Returns raw, still-compressed chunk bytes. The downstream
 * decompressChunk + applyFilters in lib/zarr-helper.js handles decoding.
 *
 * File handles are pooled in a tiny LRU (cap 8) so a query that touches
 * the same source file dozens of times pays one open().
 */
import { promises as fs } from 'node:fs';

const FH_CACHE_MAX = 8;

export class KerchunkRefStore {
  constructor(refIndex, arrays) {
    this._refs    = refIndex;
    this._arrays  = arrays;
    this._fhCache = new Map();   /* path → fs.FileHandle, LRU by insertion */
  }

  listArrays() { return this._arrays; }

  async getChunkBytes(arrayName, chunkKey) {
    const ref = this._refs.getRef(arrayName, chunkKey);
    if (!ref) return null;
    if (ref.kind === 'inline') return ref.bytes;
    if (ref.kind !== 'file')
      throw new Error("KerchunkRefStore: unknown ref kind '" + ref.kind +
        "' for chunk '" + arrayName + '/' + chunkKey + "'");

    let fh;
    try {
      fh = await this._openCached(ref.path);
    } catch (e) {
      if (e && e.code === 'ENOENT')
        throw new Error("chunk '" + arrayName + '/' + chunkKey +
          "' refers to missing file '" + ref.path + "'");
      throw e;
    }

    const buf = Buffer.alloc(ref.length);
    const { bytesRead } = await fh.read(buf, 0, ref.length, ref.offset);
    if (bytesRead !== ref.length)
      throw new Error("chunk '" + arrayName + '/' + chunkKey +
        "' short read: expected " + ref.length + ', got ' + bytesRead +
        ' at offset ' + ref.offset + ' in ' + ref.path);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  }

  async _openCached(path) {
    if (this._fhCache.has(path)) {
      /* LRU touch: re-insert to move to end */
      const fh = this._fhCache.get(path);
      this._fhCache.delete(path);
      this._fhCache.set(path, fh);
      return fh;
    }
    const fh = await fs.open(path, 'r');
    this._fhCache.set(path, fh);
    if (this._fhCache.size > FH_CACHE_MAX) {
      const oldestKey = this._fhCache.keys().next().value;
      const oldest    = this._fhCache.get(oldestKey);
      this._fhCache.delete(oldestKey);
      await oldest.close().catch(() => {});
    }
    return fh;
  }

  async close() {
    for (const fh of this._fhCache.values()) {
      await fh.close().catch(() => {});
    }
    this._fhCache.clear();
  }
}
