// lib/zarr/v3-metadata.js
//
// Zarr v3 metadata reader. Translates zarr.json array nodes into the internal
// v2-like meta shape consumed by chunk-grid/decompress/coordinate code.

import { mapCodecs } from './codecs.js';

const DTYPE_BYTES = {
  bool: ['u', 1],
  int8: ['i', 1],
  int16: ['i', 2],
  int32: ['i', 4],
  int64: ['i', 8],
  uint8: ['u', 1],
  uint16: ['u', 2],
  uint32: ['u', 4],
  uint64: ['u', 8],
  float16: ['f', 2],
  float32: ['f', 4],
  float64: ['f', 8],
};

export function dataTypeToTypestr(name, endian) {
  const spec = DTYPE_BYTES[name];
  if (!spec) throw new Error('Unsupported Zarr v3 data_type: ' + name);
  const [kind, bytes] = spec;
  const prefix = bytes === 1 ? '|' : (endian === 'big' ? '>' : '<');
  return prefix + kind + bytes;
}

function toMeta(j) {
  const codecs = mapCodecs(j.codecs);
  const sep = j.chunk_key_encoding?.configuration?.separator
    ?? (j.chunk_key_encoding?.name === 'v2' ? '.' : '/');
  const prefix = j.chunk_key_encoding?.name === 'v2' ? '' : 'c';
  const gridShape = j.chunk_grid?.configuration?.chunk_shape || j.shape;
  const innerShape = codecs.sharding?.chunk_shape || null;

  return {
    shape: j.shape,
    chunks: innerShape || gridShape,
    dtype: dataTypeToTypestr(j.data_type, codecs.endianness || 'little'),
    compressor: codecs.sharding ? null : codecs.compressor,
    filters: null,
    fill_value: j.fill_value,
    order: 'C',
    dimension_separator: sep,
    _chunkKeyPrefix: prefix,
    _dimNames: Array.isArray(j.dimension_names) ? j.dimension_names : null,
    _endianness: codecs.endianness,
    _byteCodecs: codecs.byteCodecs,
    _sharding: codecs.sharding ? { ...codecs.sharding, outerChunk: gridShape } : null,
    zarr_format: 3,
  };
}

export function indexArraysV3(entries) {
  const dec = new TextDecoder();
  const arrays = [];

  for (const path of Object.keys(entries)) {
    if (!path.endsWith('zarr.json')) continue;
    const root = path.slice(0, -'zarr.json'.length);
    let j;
    try { j = JSON.parse(dec.decode(entries[path])); } catch { continue; }
    if (j.zarr_format !== 3) continue;
    const cm = j.consolidated_metadata?.metadata;
    if (cm && typeof cm === 'object') {
      for (const [name, am] of Object.entries(cm)) {
        if (am?.node_type !== 'array') continue;
        arrays.push({
          name,
          root: root + name + '/',
          meta: toMeta(am),
          attrs: am.attributes || null,
        });
      }
      return arrays;
    }
  }

  for (const path of Object.keys(entries)) {
    if (!path.endsWith('/zarr.json')) continue;
    let j;
    try { j = JSON.parse(dec.decode(entries[path])); } catch { continue; }
    if (j.zarr_format !== 3 || j.node_type !== 'array') continue;
    const root = path.slice(0, -'zarr.json'.length);
    const name = root.replace(/\/$/, '').split('/').pop() || '/';
    arrays.push({ name, root, meta: toMeta(j), attrs: j.attributes || null });
  }

  return arrays;
}
