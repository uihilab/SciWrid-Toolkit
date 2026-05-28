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

console.log('\n[scan]');
await test('detectFormat returns "tiff" for LE TIFF', async () => {
  const { detectFormat } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-wgs84.tif')));
  assertEq(await detectFormat(buf), 'tiff');
});

await test('scan returns metadata for u8-none-strip fixture', async () => {
  const { scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.format, 'tiff');
  assertEq(meta.width, 8);
  assertEq(meta.height, 4);
  assertEq(meta.dtype, 'uint8');
  assertEq(meta.compression, 'none');
  assertEq(meta.layout, 'strip');
  assertEq(meta.crs.epsg, 4326);
  assert(Array.isArray(meta.variable_names) && meta.variable_names.length === 1);
  assertEq(meta.variable_names[0], 'band_1');
  // bbox in WGS84
  assertEq(meta.bbox[0], 10);   // minLon
  assertEq(meta.bbox[3], 24);   // maxLat
});

console.log('\n[decoders]');
await test('none decoder is identity', async () => {
  const { decode } = await import('../lib/tiff/decoders/none.js');
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = await decode(a);
  assertEq(b.length, 4); assertEq(b[2], 3);
});

await test('deflate decoder round-trips a known deflate stream', async () => {
  const { decode } = await import('../lib/tiff/decoders/deflate.js');
  // Pre-built deflate of "hello world" (raw deflate, no zlib wrapper)
  const compressed = new Uint8Array([
    0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf,
    0x2f, 0xca, 0x49, 0x01, 0x00,
  ]);
  const out = await decode(compressed, 11);
  const s = new TextDecoder().decode(out);
  assertEq(s, 'hello world');
});

// Hand-rolled TIFF-LZW encoder (MSB-first, early-change) used only by tests
// to verify decoder round-trip on known inputs.
function tiffLzwEncode(bytes) {
  const CLEAR = 256, EOI = 257;
  // String table: Map<string, code>
  const table = new Map();
  let nextCode;
  let codeWidth = 9;
  function reset() {
    table.clear();
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
    nextCode = 258;
    codeWidth = 9;
  }
  const bits = [];
  function emit(code) {
    for (let i = codeWidth - 1; i >= 0; i--) bits.push((code >>> i) & 1);
  }
  reset();
  emit(CLEAR);
  let w = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = String.fromCharCode(bytes[i]);
    const wc = w + c;
    if (table.has(wc)) {
      w = wc;
    } else {
      emit(table.get(w));
      table.set(wc, nextCode++);
      // TIFF early-change semantics (matches libtiff): bump width when the
      // just-assigned entry's index == (1<<width)-1. After post-increment,
      // nextCode == (1<<width).
      if (nextCode === (1 << codeWidth) && codeWidth < 12) codeWidth++;
      w = c;
    }
  }
  if (w !== '') emit(table.get(w));
  emit(EOI);
  // Pack bits MSB-first into bytes
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

await test('lzw decoder round-trips a hand-encoded TIFF-LZW stream', async () => {
  const { decode } = await import('../lib/tiff/decoders/lzw.js');
  const input = new Uint8Array([7, 7, 7, 8, 8, 7, 7, 6, 6]);
  const enc = tiffLzwEncode(input);
  const out = await decode(enc);
  assertEq(out.length, input.length, 'length');
  for (let i = 0; i < input.length; i++) assertEq(out[i], input[i], `out[${i}]`);
});

await test('lzw decoder handles a 4 KiB repeating pattern (covers width bump)', async () => {
  const { decode } = await import('../lib/tiff/decoders/lzw.js');
  const input = new Uint8Array(4096);
  for (let i = 0; i < input.length; i++) input[i] = (i * 31 + 7) & 0xff;
  const enc = tiffLzwEncode(input);
  const out = await decode(enc);
  assertEq(out.length, input.length, 'length');
  for (let i = 0; i < input.length; i++) assertEq(out[i], input[i], `out[${i}]`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
