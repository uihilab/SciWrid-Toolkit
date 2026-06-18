#!/usr/bin/env node
// scripts/test-zarr-v3.js - Zarr v3 unit + integration tests.
import { parseDtype } from '../lib/zarr/metadata.js';
import { mapCodecs, decodeChunkBytes } from '../lib/zarr/codecs.js';
import { dataTypeToTypestr, indexArraysV3 } from '../lib/zarr/v3-metadata.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as rsv } from 'node:path';
import { gzipSync } from 'node:zlib';
import zarrHelper from '../lib/zarr-helper.js';

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.stack || e.message); }
}

console.log('zarr v3 tests\n');

console.log('[dtype]');
await test('big-endian int16 is byteswapped', () => {
  const dt = parseDtype('>i2');
  const buf = new Uint8Array([0x01, 0x00]);
  const v = dt.view(buf, 0, 1);
  assert(v[0] === 256, `expected 256, got ${v[0]}`);
});
await test('little-endian int16 unchanged', () => {
  const dt = parseDtype('<i2');
  const buf = new Uint8Array([0x01, 0x00]);
  assert(dt.view(buf, 0, 1)[0] === 1, 'LE should be 1');
});
await test('float16 decodes to Float32 value', () => {
  const dt = parseDtype('<f2');
  const buf = new Uint8Array([0x00, 0x3c]);
  assert(Math.abs(dt.view(buf, 0, 1)[0] - 1.0) < 1e-6, `expected 1.0, got ${dt.view(buf, 0, 1)[0]}`);
});

console.log('\n[codecs]');
await test('mapCodecs splits bytes endianness and compressor', () => {
  const r = mapCodecs([
    { name: 'bytes', configuration: { endian: 'big' } },
    { name: 'gzip', configuration: { level: 5 } },
  ]);
  assert(r.endianness === 'big', 'endian');
  assert(r.compressor && r.compressor.id === 'gzip', 'compressor id');
  assert(r.sharding === null, 'no sharding');
});
await test('decodeChunkBytes inflates gzip and strips crc32c', async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const gz = new Uint8Array(gzipSync(Buffer.from(payload)));
  const stored = new Uint8Array(gz.length + 4);
  stored.set(gz, 0);
  const out = await decodeChunkBytes(stored, [
    { name: 'gzip', configuration: {} },
    { name: 'crc32c', configuration: {} },
  ]);
  assert(out.length === 5 && out[4] === 5, `got ${Array.from(out)}`);
});

console.log('\n[v3-metadata]');
await test('dataTypeToTypestr maps names + endianness', () => {
  assert(dataTypeToTypestr('float64', 'little') === '<f8', 'f8 le');
  assert(dataTypeToTypestr('int16', 'big') === '>i2', 'i2 be');
  assert(dataTypeToTypestr('uint8', 'little') === '|u1', 'u1');
});
await test('indexArraysV3 translates a per-node zarr.json', () => {
  const enc = new TextEncoder();
  const arr = {
    shape: [2, 3],
    data_type: 'float64',
    zarr_format: 3,
    node_type: 'array',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 3] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 'NaN',
    dimension_names: ['lat', 'lon'],
    codecs: [
      { name: 'bytes', configuration: { endian: 'little' } },
      { name: 'zstd', configuration: { level: 0 } },
    ],
    attributes: { units: 'K' },
  };
  const entries = { 'precip/zarr.json': enc.encode(JSON.stringify(arr)) };
  const out = indexArraysV3(entries);
  assert(out.length === 1, 'one array');
  const m = out[0];
  assert(m.name === 'precip', 'name');
  assert(m.meta.dtype === '<f8', 'dtype');
  assert(m.meta._chunkKeyPrefix === 'c', 'prefix');
  assert(m.meta.dimension_separator === '/', 'sep');
  assert(m.meta.compressor.id === 'zstd', 'compressor');
  assert(JSON.stringify(m.meta._dimNames) === JSON.stringify(['lat', 'lon']), 'dims');
  assert(m.attrs.units === 'K', 'attrs');
});

const FX = (n) => rsv(process.cwd(), 'examples/testfile', n);

console.log('\n[integration: regular v3]');
for (const file of ['v3-regular-zstd.zarr.zip', 'v3-gzip.zarr.zip', 'v3-bigendian.zarr.zip']) {
  await test(`scan + read ${file}`, async () => {
    if (!existsSync(FX(file))) return;
    const buf = new Uint8Array(readFileSync(FX(file)));
    const scan = await zarrHelper.scan(buf);
    const vars = JSON.parse(zarrHelper.scanGetVarsJson(scan));
    const temp = vars.find((v) => v.name === 'temp');
    assert(temp, 'temp var present');
    assert(JSON.stringify(temp.shape) === JSON.stringify([2, 4, 5]), `shape ${temp.shape}`);
    const data = await zarrHelper._readArrayAsFloat32(scan, scan.arrays.find((a) => a.name === 'temp'));
    assert(data.length === 2 * 4 * 5, `len ${data.length}`);
    assert(Number.isFinite(data[0]), 'finite[0]');
    await zarrHelper.scanFree(scan);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
