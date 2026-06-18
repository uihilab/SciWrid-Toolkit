#!/usr/bin/env node
// scripts/test-zarr-v3.js - Zarr v3 unit + integration tests.
import { parseDtype } from '../lib/zarr/metadata.js';
import { mapCodecs, decodeChunkBytes } from '../lib/zarr/codecs.js';
import { gzipSync } from 'node:zlib';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
