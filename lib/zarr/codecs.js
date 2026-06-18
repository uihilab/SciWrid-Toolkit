// lib/zarr/codecs.js
//
// Interpret a Zarr v3 codecs pipeline. v3 codecs apply array-to-array, then
// array-to-bytes (`bytes`), then bytes-to-bytes (compression / crc32c) in
// order. The existing v2 decompressors handle compression.

import { decompressChunk } from './decompressors.js';

const COMPRESSION = new Set(['gzip', 'zlib', 'zstd', 'blosc', 'lz4']);

export function mapCodecs(codecs) {
  const out = {
    endianness: null,
    compressor: null,
    transpose: null,
    sharding: null,
    byteCodecs: [],
  };
  if (!Array.isArray(codecs)) return out;

  for (const c of codecs) {
    const name = c && c.name;
    const cfg = (c && c.configuration) || {};
    if (name === 'bytes') {
      out.endianness = cfg.endian ?? 'little';
    } else if (name === 'transpose') {
      out.transpose = cfg.order || null;
    } else if (name === 'sharding_indexed') {
      out.sharding = cfg;
    } else if (name === 'crc32c') {
      out.byteCodecs.push({ name: 'crc32c', configuration: cfg });
    } else if (COMPRESSION.has(name)) {
      out.byteCodecs.push({ name, configuration: cfg });
      out.compressor = { id: name, ...cfg };
    } else {
      throw new Error('Unsupported Zarr v3 codec: ' + name);
    }
  }
  return out;
}

export async function decodeChunkBytes(raw, byteCodecs) {
  let buf = raw;
  for (let i = byteCodecs.length - 1; i >= 0; i--) {
    const c = byteCodecs[i];
    if (c.name === 'crc32c') {
      buf = buf.subarray(0, buf.length - 4);
    } else {
      buf = await decompressChunk(buf, { id: c.name, ...c.configuration });
    }
  }
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
