# Zarr Logic

## Zarr v3

Zarr v3 ZIP stores are read by translating each `zarr.json` array node into
the same internal metadata shape used by the v2 reader. `indexArraysV3`
extracts shape, chunk shape, dtype, fill value, dimension names, chunk-key
encoding, and codec details, then stores v3-specific fields under `_`-prefixed
keys on `meta`.

`codecs.js` splits the v3 codec pipeline into the array byte order (`bytes`),
byte-to-byte codecs (`gzip`, `zstd`, `blosc`, `lz4`, `crc32c`), and optional
`sharding_indexed` configuration. Chunk reads apply byte codecs in reverse file
order. `crc32c` is stripped but not verified.

Chunk keys are built by `chunkKey(meta, idx)`. Default v3 encoding uses
`c/...` paths, while v2-style chunk-key encoding omits the prefix and joins
indices with the configured separator.

`sharding.js` reads `sharding_indexed` shards by loading the shard index from
the start or end of the shard, interpreting row-major `(offset, length)` u64
pairs, and returning `null` for the all-ones empty marker so the chunk-grid
reader leaves that inner chunk as fill.
