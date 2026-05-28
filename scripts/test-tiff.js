#!/usr/bin/env node
// scripts/test-tiff.js
//
// Smoke tests for the pure-JS TIFF reader.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures  = resolve(__dirname, '..', 'examples', 'testfile', 'tiff');

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`); }

console.log('[ifd-reader]');
await test('parses header + first IFD on u8-none-strip fixture', async () => {
  const { parseIFDs } = await import('../lib/tiff/ifd-reader.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-wgs84.tif')));
  const ifds = parseIFDs(buf);
  assertEq(ifds.length, 1, 'should have exactly one IFD');
  const t = ifds[0].tags;
  assertEq(t.get(256).values[0], 8, 'ImageWidth');
  assertEq(t.get(257).values[0], 4, 'ImageLength');
  assertEq(t.get(258).values[0], 8, 'BitsPerSample');
  assertEq(t.get(259).values[0], 1, 'Compression');
  assertEq(t.get(277).values[0], 1, 'SamplesPerPixel');
  assertEq(t.get(33922).values.length, 6, 'ModelTiepoint has 6 doubles');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
