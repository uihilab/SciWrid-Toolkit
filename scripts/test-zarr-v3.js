#!/usr/bin/env node
// scripts/test-zarr-v3.js - Zarr v3 unit + integration tests.
import { parseDtype } from '../lib/zarr/metadata.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
