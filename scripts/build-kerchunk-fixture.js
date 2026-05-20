#!/usr/bin/env node
/*
 * scripts/build-kerchunk-fixture.js
 *
 * One-shot dev script. Builds the test fixture for the kerchunk-parquet
 * reader. Run from repo root:
 *
 *   npm install                 # installs numcodecs + hyparquet-writer
 *   node scripts/build-kerchunk-fixture.js
 *
 * Output (committed; not regenerated in CI):
 *   examples/testfile/kerchunk-fixture.bin       ← concatenated chunk bytes
 *   examples/testfile/kerchunk-fixture.parquet   ← single-file parquet refs
 *
 * Design note: the reader does fs.read(path, offset, length) and decodes
 * the bytes via shuffle + zlib. It never parses HDF5. So the "source file"
 * is just a flat concatenation of (shuffle+zlib)-encoded chunks — byte
 * layout identical from the reader's perspective to a real HDF5 archive
 * with the same chunks, but ~50 LOC instead of an h5wasm authoring pass.
 *
 * Data:
 *   tas: float32 [4, 8] = arange(32).reshape(4, 8); chunks [2, 4]; filters
 *        [shuffle]; compressor zlib(level=4).
 *   y:   float32 [4]    = [0,1,2,3];   chunk [4]; filters [shuffle]; zlib(4).
 *   x:   float32 [8]    = [0..7];      chunk [8]; filters [shuffle]; zlib(4).
 *
 * Metadata refs (.zgroup, .zarray, .zattrs) are stored inline in the
 * parquet (kerchunk does the same for small entries).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { parquetWriteFile } from 'hyparquet-writer';

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR    = join(ROOT, 'examples', 'testfile');
const BIN_PATH   = join(OUT_DIR, 'kerchunk-fixture.bin');
const PQ_PATH    = join(OUT_DIR, 'kerchunk-fixture.parquet');
const SOURCE_REL = 'kerchunk-fixture.bin';   // refs use a relative path

mkdirSync(OUT_DIR, { recursive: true });

/* ---------------- chunk encoding helpers ---------------- */

/**
 * HDF5/Zarr-style byte shuffle. For elementsize=4 and N elements:
 *   in  = [a0,a1,a2,a3, b0,b1,b2,b3, c0,c1,c2,c3, ...]
 *   out = [a0,b0,c0,..., a1,b1,c1,..., a2,b2,c2,..., a3,b3,c3,...]
 * (the reader implements the mirror decode in lib/zarr-helper.js).
 */
function shuffleEncode(input, elementsize) {
  const count = input.length / elementsize;
  if (!Number.isInteger(count))
    throw new Error('shuffleEncode: input length ' + input.length +
      ' not a multiple of elementsize ' + elementsize);
  const out = new Uint8Array(input.length);
  for (let j = 0; j < elementsize; j++) {
    for (let i = 0; i < count; i++) {
      out[j * count + i] = input[i * elementsize + j];
    }
  }
  return out;
}

function encodeChunk(floats) {
  const raw = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  const shuffled = shuffleEncode(raw, 4);
  /* Node zlib.deflateSync produces zlib-format (RFC 1950), which matches
   * Zarr's "zlib" compressor and the reader's DecompressionStream('deflate'). */
  return deflateSync(Buffer.from(shuffled), { level: 4 });
}

/* ---------------- author the chunks ---------------- */

/* tas = arange(32).reshape(4, 8); chunks (2, 4). Row-major within each chunk. */
const tasChunks = [
  Float32Array.from([0, 1, 2, 3,   8, 9, 10, 11]),       // 0.0
  Float32Array.from([4, 5, 6, 7,   12, 13, 14, 15]),     // 0.1
  Float32Array.from([16, 17, 18, 19, 24, 25, 26, 27]),   // 1.0
  Float32Array.from([20, 21, 22, 23, 28, 29, 30, 31]),   // 1.1
];

const yArr = Float32Array.from([0, 1, 2, 3]);
const xArr = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

const tasEnc = tasChunks.map(encodeChunk);
const yEnc   = encodeChunk(yArr);
const xEnc   = encodeChunk(xArr);

/* Concatenate all encoded payloads into one .bin, tracking offsets. */
const segments = [];
let cursor = 0;
function place(label, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  segments.push({ label, offset: cursor, length: u8.length, bytes: u8 });
  cursor += u8.length;
  return segments[segments.length - 1];
}

const tas00 = place('tas/0.0', tasEnc[0]);
const tas01 = place('tas/0.1', tasEnc[1]);
const tas10 = place('tas/1.0', tasEnc[2]);
const tas11 = place('tas/1.1', tasEnc[3]);
const y0    = place('y/0',     yEnc);
const x0    = place('x/0',     xEnc);

const binBuf = Buffer.concat(segments.map(s => s.bytes));
writeFileSync(BIN_PATH, binBuf);
console.log(`Wrote ${BIN_PATH} (${binBuf.length} bytes)`);

/* ---------------- author the refs map ---------------- */

const zarrayTas = JSON.stringify({
  zarr_format: 2,
  shape: [4, 8],
  chunks: [2, 4],
  dtype: '<f4',
  compressor: { id: 'zlib', level: 4 },
  filters: [{ id: 'shuffle', elementsize: 4 }],
  fill_value: 'NaN',
  order: 'C',
  dimension_separator: '.',
});
const zattrsTas = JSON.stringify({ _ARRAY_DIMENSIONS: ['y', 'x'] });

const zarrayY = JSON.stringify({
  zarr_format: 2,
  shape: [4],
  chunks: [4],
  dtype: '<f4',
  compressor: { id: 'zlib', level: 4 },
  filters: [{ id: 'shuffle', elementsize: 4 }],
  fill_value: 'NaN',
  order: 'C',
  dimension_separator: '.',
});
const zattrsY = JSON.stringify({ _ARRAY_DIMENSIONS: ['y'] });

const zarrayX = JSON.stringify({
  zarr_format: 2,
  shape: [8],
  chunks: [8],
  dtype: '<f4',
  compressor: { id: 'zlib', level: 4 },
  filters: [{ id: 'shuffle', elementsize: 4 }],
  fill_value: 'NaN',
  order: 'C',
  dimension_separator: '.',
});
const zattrsX = JSON.stringify({ _ARRAY_DIMENSIONS: ['x'] });

const zgroup = JSON.stringify({ zarr_format: 2 });

/* Schema: { key, path, offset, size, raw }
 *   - metadata rows: key + raw (JSON string); path/offset/size null
 *   - chunk rows:    key + path + offset + size; raw null
 */
const rows = [
  { key: '.zgroup',     raw: zgroup },
  { key: 'tas/.zarray', raw: zarrayTas },
  { key: 'tas/.zattrs', raw: zattrsTas },
  { key: 'y/.zarray',   raw: zarrayY },
  { key: 'y/.zattrs',   raw: zattrsY },
  { key: 'x/.zarray',   raw: zarrayX },
  { key: 'x/.zattrs',   raw: zattrsX },

  { key: 'tas/0.0', path: SOURCE_REL, offset: BigInt(tas00.offset), size: BigInt(tas00.length) },
  { key: 'tas/0.1', path: SOURCE_REL, offset: BigInt(tas01.offset), size: BigInt(tas01.length) },
  { key: 'tas/1.0', path: SOURCE_REL, offset: BigInt(tas10.offset), size: BigInt(tas10.length) },
  { key: 'tas/1.1', path: SOURCE_REL, offset: BigInt(tas11.offset), size: BigInt(tas11.length) },
  { key: 'y/0',     path: SOURCE_REL, offset: BigInt(y0.offset),    size: BigInt(y0.length)    },
  { key: 'x/0',     path: SOURCE_REL, offset: BigInt(x0.offset),    size: BigInt(x0.length)    },
];

const columnData = [
  { name: 'key',    data: rows.map(r => r.key) },
  { name: 'path',   data: rows.map(r => r.path   ?? null), type: 'STRING' },
  { name: 'offset', data: rows.map(r => r.offset ?? null), type: 'INT64'  },
  { name: 'size',   data: rows.map(r => r.size   ?? null), type: 'INT64'  },
  { name: 'raw',    data: rows.map(r => r.raw    ?? null), type: 'STRING' },
];

await parquetWriteFile({ filename: PQ_PATH, columnData });
console.log(`Wrote ${PQ_PATH}`);

console.log('\nFixture summary:');
for (const s of segments) {
  console.log(`  ${s.label.padEnd(10)} offset=${String(s.offset).padStart(5)} length=${s.length}`);
}
