// lib/zarr/sharding.js
//
// Zarr v3 sharding_indexed reader. One outer chunk (shard) contains a regular
// grid of inner chunks plus an index of (offset,length) u64 pairs.

import { decodeChunkBytes } from './codecs.js';

const ALL_ONES = 0xFFFFFFFFFFFFFFFFn;

export function shardInnerGrid(meta) {
  const outer = meta._sharding.outerChunk;
  const inner = meta._sharding.chunk_shape;
  return outer.map((o, i) => Math.ceil(o / inner[i]));
}

export function innerToShard(meta, innerGlobalIdx) {
  const inner = meta._sharding.chunk_shape;
  const outer = meta._sharding.outerChunk;
  const per = outer.map((o, i) => Math.ceil(o / inner[i]));
  const shardIdx = innerGlobalIdx.map((g, i) => Math.floor(g / per[i]));
  const innerLocalIdx = innerGlobalIdx.map((g, i) => g % per[i]);
  return { shardIdx, innerLocalIdx };
}

export function innerLinearIndex(meta, innerLocalIdx) {
  const grid = shardInnerGrid(meta);
  let lin = 0;
  for (let i = 0; i < grid.length; i++) lin = lin * grid[i] + innerLocalIdx[i];
  return lin;
}

export class ShardReader {
  constructor(meta) {
    this.meta = meta;
    this.sh = meta._sharding;
    this._cacheKey = null;
    this._cache = null;
  }

  _innerCodecs() {
    return (this.sh.codecs || []).filter((c) => c.name !== 'bytes' && c.name !== 'transpose');
  }

  async _loadShard(shardKey, rawShard) {
    if (this._cacheKey === shardKey) return this._cache;
    const grid = shardInnerGrid(this.meta);
    const nInner = grid.reduce((a, b) => a * b, 1);
    const idxLen = nInner * 16;
    const loc = this.sh.index_location || 'end';
    const hasCrc = (this.sh.index_codecs || []).some((c) => c.name === 'crc32c');
    const crc = hasCrc ? 4 : 0;
    const idxBytes = loc === 'start'
      ? rawShard.subarray(0, idxLen)
      : rawShard.subarray(rawShard.length - idxLen - crc, rawShard.length - crc);
    const index = idxBytes.byteOffset % 8 === 0
      ? new BigUint64Array(idxBytes.buffer, idxBytes.byteOffset, nInner * 2)
      : new BigUint64Array(idxBytes.slice().buffer);
    this._cacheKey = shardKey;
    this._cache = { index, body: rawShard };
    return this._cache;
  }

  async innerChunkBytes(_source, _arrayName, shardKey, rawShard, innerLinear) {
    const { index, body } = await this._loadShard(shardKey, rawShard);
    const offset = index[innerLinear * 2];
    const length = index[innerLinear * 2 + 1];
    if (offset === ALL_ONES || length === 0n) return null;
    const off = Number(offset), len = Number(length);
    const raw = body.subarray(off, off + len);
    const codecs = this._innerCodecs();
    return codecs.length ? decodeChunkBytes(raw, codecs) : raw;
  }
}
