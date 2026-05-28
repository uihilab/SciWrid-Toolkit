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

console.log('\n[predictors]');
await test('horizontal predictor (uint8) inverts row deltas', async () => {
  const { unpredict } = await import('../lib/tiff/predictors.js');
  // 1 row × 4 cols, samplesPerPixel=1, uint8
  // original: [10, 20, 30, 35] → encoded: [10, 10, 10, 5]
  const enc = new Uint8Array([10, 10, 10, 5]);
  unpredict(enc, { predictor: 2, width: 4, height: 1, samplesPerPixel: 1, dtype: 'uint8' });
  const dec = enc;
  assertEq(dec[0], 10); assertEq(dec[1], 20); assertEq(dec[2], 30); assertEq(dec[3], 35);
});

await test('floating-point predictor (float32) reverses byte-shuffle deltas', async () => {
  const { unpredict } = await import('../lib/tiff/predictors.js');
  // Build a tiny 1×2 float32 row: [1.0, 2.0]
  const W = 2, H = 1;
  // Encoder side: byte-shuffle row, then per-byte horizontal-diff.
  // 1.0 LE bytes: [00, 00, 80, 3F]; 2.0 LE bytes: [00, 00, 00, 40]
  // After shuffle (group by byte index across samples):
  //   [00, 00, 00, 00, 80, 00, 3F, 40]
  // After per-byte horizontal diff:
  //   [00, 00, 00, 00, 80, 80, 3F, 01]
  const enc = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x80, 0x80, 0x3F, 0x01]);
  unpredict(enc, { predictor: 3, width: W, height: H, samplesPerPixel: 1, dtype: 'float32' });
  const dec = new Float32Array(enc.buffer, enc.byteOffset, W * H);
  assert(Math.abs(dec[0] - 1.0) < 1e-6, `dec[0]=${dec[0]}`);
  assert(Math.abs(dec[1] - 2.0) < 1e-6, `dec[1]=${dec[1]}`);
});

console.log('\n[extract]');
await test('extract returns correct uint8 value at known lat/lon', async () => {
  const { extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-wgs84.tif')));
  // Fixture: 8×4 grid at bbox [10,20,18,24], pixel 1°×1°, pixels[i] = (i*7+3)&0xff
  // (row 0 = top, north-up). lat=23.5, lon=10.5 → row 0, col 0 → pixels[0] = 3
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assertEq(r.value, 3);
  assertEq(r.variable, 'band_1');
});

await test('extract out-of-bounds returns null', async () => {
  const { extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-wgs84.tif')));
  const r = await extract(buf, { variable: 'band_1', lat: 0, lon: 0 });
  assertEq(r.value, null);
});

console.log('\n[f32+deflate+fp]');
await test('extract float32+deflate+fp at known pixel returns expected value', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.dtype, 'float32');
  assertEq(meta.compression, 'deflate');
  // f32[(r*W)+c] = (i%7)*0.5 + 1.25 where i = r*W+c (row 0 = top, north-up)
  // pixel (row=0, col=0) → lon ∈ [10,11), lat ∈ [23,24) → choose lat=23.5, lon=10.5
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assert(Math.abs(r.value - 1.25) < 1e-5, `got ${r.value}`);
  // pixel (row=1, col=3) → lat=22.5, lon=13.5 → i=11 → (11%7)*0.5 + 1.25 = 2 + 1.25 = 3.25
  const r2 = await extract(buf, { variable: 'band_1', lat: 22.5, lon: 13.5 });
  assert(Math.abs(r2.value - 3.25) < 1e-5, `got ${r2.value}`);
});

console.log('\n[projections]');
await test('UTM 15N round-trip is accurate to <1e-7 deg', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'utm', zone: 15, hemisphere: 'N', epsg: 32615 };
  for (const [lat, lon] of [[30, -93], [45, -89], [40, -95]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-7, `lat drift ${back.lat - lat}`);
    assert(Math.abs(back.lon - lon) < 1e-7, `lon drift ${back.lon - lon}`);
  }
});

await test('sinusoidal round-trip near equator', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'sinusoidal', centralMeridianDeg: 0, falseEasting: 0,
                falseNorthing: 0, earthRadiusM: 6371007.181, epsg: 32767 };
  for (const [lat, lon] of [[0, 0], [10, 5], [-20, 30]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-6, `lat`);
    assert(Math.abs(back.lon - lon) < 1e-6, `lon`);
  }
});

console.log('\n[utm + sinusoidal]');
await test('UTM 15N tile fixture: extract at known lat/lon', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-tile-utm15n.tif')));
  const meta = await scan(buf);
  assertEq(meta.crs.epsg, 32615);
  // Tiepoint pixel (0,0) at UTM (500000, 3320000). Inverse → ~lat=30.00094, lon=-93.0
  const { nativeToLatLon } = await import('../lib/tiff/projections.js');
  const ll = nativeToLatLon({ x: 500500, y: 3319500 }, { kind: 'utm', zone: 15, hemisphere: 'N', epsg: 32615 });
  const r = await extract(buf, { variable: 'band_1', lat: ll.lat, lon: ll.lon });
  // Pixel (row=0, col=0) value = 0 * 0.25 + 7 = 7
  assert(Math.abs(r.value - 7) < 1e-5, `got ${r.value}`);
});

await test('sinusoidal tile fixture: extract at known lat/lon', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-tile-sinusoidal.tif')));
  const meta = await scan(buf);
  assert(meta.crs.epsg === 32767 || /sinusoidal/i.test(meta.crs.name));
  // Tiepoint pixel (0,0) at native (0,0) → lat=0, lon=0. Pick a lat/lon ≈ center of pixel (0,0)
  // pixel scale 1000m → 1 px south is y=-1000 → lat = -1000/R rad. Pick lat slightly negative.
  const R = 6371007.181;
  const lat = -500 / R * (180 / Math.PI);   // ~half a pixel south
  const lon = 500  / R * (180 / Math.PI);   // ~half a pixel east
  const r = await extract(buf, { variable: 'band_1', lat, lon });
  assert(Math.abs(r.value - 7) < 1e-5, `got ${r.value}`);
});

console.log('\n[extractGrid]');
await test('extractGrid full image returns Float32Array of expected shape', async () => {
  const { extractGrid } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-strip-wgs84.tif')));
  const g = await extractGrid(buf, { variable: 'band_1' });
  assertEq(g.width, 8); assertEq(g.height, 4);
  assertEq(g.data.constructor, Float32Array);
  // pixel (row=0, col=0) → f32[0] = (0%7)*0.5 + 1.25 = 1.25
  assert(Math.abs(g.data[0] - 1.25) < 1e-5);
  // pixel (row=3, col=7) → i=31 → (31%7)*0.5 + 1.25 = (3)*0.5 + 1.25 = 2.75
  assert(Math.abs(g.data[3 * 8 + 7] - 2.75) < 1e-5);
});

await test('extractGrid with bbox clips correctly', async () => {
  const { extractGrid } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-strip-wgs84.tif')));
  // Fixture bbox [10,20,18,24]. Ask for [12,21,15,23] → 3 cols × 2 rows
  const g = await extractGrid(buf, { variable: 'band_1', bbox: [12, 21, 15, 23] });
  assertEq(g.width, 3); assertEq(g.height, 2);
});

console.log('\n[i16 + u8 tile]');
await test('Int16 strip: extract returns signed value', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-i16-none-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.dtype, 'int16');
  // pixel (row=0, col=0) → i=0 → (0-16)*13 = -208
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assertEq(r.value, -208);
});

await test('UInt8 tile: extract returns correct value from tile (1,1)', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-tile-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.layout, 'tile');
  // Pixel (row=5, col=5) is in tile (ty=1, tx=1). pixels[5*8+5] = (45*5+11)&0xff = 236
  // lat=24-5.5=18.5, lon=10+5.5=15.5
  const r = await extract(buf, { variable: 'band_1', lat: 18.5, lon: 15.5 });
  assertEq(r.value, 236);
});

console.log('\n[multiband]');
await test('multiband fixture: scan reports 3 bands with GDAL names', async () => {
  const { scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-multiband-u16-lzw-h-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.variable_names.length, 3);
  assertEq(meta.variable_names[0], 'B04_red');
  assertEq(meta.variable_names[1], 'B03_green');
  assertEq(meta.variable_names[2], 'B02_blue');
  assertEq(meta.dtype, 'uint16');
  assertEq(meta.compression, 'lzw');
});

await test('multiband fixture: extract returns distinct values per band', async () => {
  const { extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-multiband-u16-lzw-h-strip-wgs84.tif')));
  // pixel (r=0, c=0): band 0 = 0, band 1 = 5, band 2 = 11
  const r = await extract(buf, { variable: 'B04_red',   lat: 23.5, lon: 10.5 });
  const g = await extract(buf, { variable: 'B03_green', lat: 23.5, lon: 10.5 });
  const b = await extract(buf, { variable: 'B02_blue',  lat: 23.5, lon: 10.5 });
  assertEq(r.value, 0);
  assertEq(g.value, 5);
  assertEq(b.value, 11);
});

console.log('\n[unsupported-crs]');
await test('unsupported EPSG: scan throws UnsupportedCRSError with the EPSG', async () => {
  const { scan, UnsupportedCRSError } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-unsupported-crs.tif')));
  let caught;
  try { await scan(buf); }
  catch (e) { caught = e; }
  if (!caught) throw new Error('expected scan() to throw');
  if (!(caught instanceof UnsupportedCRSError))
    throw new Error(`wrong error type: ${caught.constructor.name} ${caught.message}`);
  assertEq(caught.epsg, 5489);
});

console.log('\n[big-endian]');
await test('big-endian TIFF: scan + extract', async () => {
  const { scan, extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-none-strip-be-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.format, 'tiff');
  assertEq(meta.width, 8);
  assertEq(meta.dtype, 'uint8');
  // Same value as the LE fixture: pixels[0] = (0*7+3)&0xff = 3
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assertEq(r.value, 3);
});

await test('BigTIFF (magic 43) scan + extract', async () => {
  const { scan, extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-bigtiff-u8-none-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.format, 'tiff');
  assertEq(meta.width, 8);
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assertEq(r.value, 3);
});

console.log('\n[packbits]');
await test('packbits decoder: canonical Apple example', async () => {
  const { decode } = await import('../lib/tiff/decoders/packbits.js');
  // Apple PackBits spec example:
  //   FE AA            → -2 → repeat 0xAA three times
  //   02 80 00 2A      → 2 → copy 3 literals
  //   FD AA            → -3 → repeat 0xAA four times
  //   03 80 00 2A 22   → 3 → copy 4 literals
  //   F7 AA            → -9 → repeat 0xAA ten times
  const compressed = new Uint8Array([
    0xFE, 0xAA, 0x02, 0x80, 0x00, 0x2A, 0xFD, 0xAA,
    0x03, 0x80, 0x00, 0x2A, 0x22, 0xF7, 0xAA,
  ]);
  const out = await decode(compressed);
  // Expected (24 bytes):
  //   3× AA + 3 literals (80, 00, 2A) + 4× AA + 4 literals (80, 00, 2A, 22) + 10× AA
  const expected = [
    0xAA, 0xAA, 0xAA,
    0x80, 0x00, 0x2A,
    0xAA, 0xAA, 0xAA, 0xAA,
    0x80, 0x00, 0x2A, 0x22,
    0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA,
  ];
  assertEq(out.length, expected.length, 'length');
  for (let i = 0; i < expected.length; i++) assertEq(out[i], expected[i], `out[${i}]`);
});

await test('PackBits TIFF: scan + extract', async () => {
  const { scan, extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-u8-packbits-strip-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.compression, 'packbits');
  // Row 0 (top), col 0 = pixels[0] = 0xaa (i<16 → 0xaa)
  const r = await extract(buf, { variable: 'band_1', lat: 23.5, lon: 10.5 });
  assertEq(r.value, 0xaa);
  // Row 3 (bottom), col 7 = pixels[31] = 31 & 7 = 7 (i>=16 path)
  const r2 = await extract(buf, { variable: 'band_1', lat: 20.5, lon: 17.5 });
  assertEq(r2.value, 7);
});

console.log('\n[jpeg]');
await test('JPEG TIFF: scan reports 3 bands, extract returns plausible RGB', async () => {
  const fpath = resolve(fixtures, 'synthetic-u8-jpeg-strip-wgs84.tif');
  let exists = true;
  try { readFileSync(fpath); } catch { exists = false; }
  if (!exists) return 'skip';   // jpeg-js was unavailable at fixture build time
  const { scan, extract } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(fpath));
  const meta = await scan(buf);
  assertEq(meta.compression, 'jpeg');
  assertEq(meta.variable_names.length, 3);
  // Fixture is 16×16 RGB with R = c*16, G = r*16, B = (r+c)*8.
  // Sample a center pixel ~(r=8, c=8) → R ≈ 128, G ≈ 128, B ≈ 128.
  // Bbox: pixel (0,0) at (lon=10, lat=24), 1°/px → center at (lon=18, lat=16).
  // Use the center: lat = 24 - 8.5 = 15.5, lon = 10 + 8.5 = 18.5.
  const r = await extract(buf, { variable: 'band_1', lat: 15.5, lon: 18.5 });
  const g = await extract(buf, { variable: 'band_2', lat: 15.5, lon: 18.5 });
  const b = await extract(buf, { variable: 'band_3', lat: 15.5, lon: 18.5 });
  // JPEG is lossy — tolerate ±30 around the smooth ramp's expected values.
  assert(Math.abs(r.value - 128) < 30, `R=${r.value}`);
  assert(Math.abs(g.value - 128) < 30, `G=${g.value}`);
  assert(Math.abs(b.value - 128) < 30, `B=${b.value}`);
});

console.log('\n[webp]');
await test('WebP decoder throws UnsupportedFormatError in Node', async () => {
  // Skip this test if the environment provides createImageBitmap (e.g. happy-dom).
  if (typeof createImageBitmap !== 'undefined') return 'skip';
  const { decode } = await import('../lib/tiff/decoders/webp.js');
  const { UnsupportedFormatError } = await import('../lib/errors.js');
  let caught;
  try { await decode(new Uint8Array([0, 1, 2, 3])); }
  catch (e) { caught = e; }
  if (!caught) throw new Error('expected throw');
  if (!(caught instanceof UnsupportedFormatError))
    throw new Error(`wrong error type: ${caught.constructor.name}`);
  if (!/browser/i.test(caught.message))
    throw new Error(`expected "browser" in message: ${caught.message}`);
});

console.log('\n[lcc]');
await test('LCC projection round-trip is accurate to <1e-7 deg', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'lcc', sp1: 38.5, sp2: 38.5, lat0: 38.5, lon0: -97.5,
                falseEasting: 0, falseNorthing: 0, epsg: 32767 };
  for (const [lat, lon] of [[35, -100], [42, -90], [38.5, -97.5]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-7, `lat drift ${back.lat - lat}`);
    assert(Math.abs(back.lon - lon) < 1e-7, `lon drift ${back.lon - lon}`);
  }
});

await test('LCC tile fixture: extract at native (0,0) returns pixel (0,0) value', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const { nativeToLatLon } = await import('../lib/tiff/projections.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-tile-lcc.tif')));
  const meta = await scan(buf);
  assertEq(meta.crs.epsg, 32767);
  assert(/Lambert/i.test(meta.crs.name), 'CRS name should mention Lambert');
  // Pixel (0, 0) is at tiepoint native (0, 0) and pixel scale 3000m, so the
  // pixel CENTER (0.5, 0.5) is at native (1500, -1500). Convert to lat/lon.
  const geo = { kind: 'lcc', sp1: 38.5, sp2: 38.5, lat0: 38.5, lon0: -97.5,
                falseEasting: 0, falseNorthing: 0, epsg: 32767 };
  const ll = nativeToLatLon({ x: 1500, y: -1500 }, geo);
  const r = await extract(buf, { variable: 'band_1', lat: ll.lat, lon: ll.lon });
  // f32[0] = 0 * 0.5 + 1.0 = 1.0
  assert(Math.abs(r.value - 1.0) < 1e-5, `got ${r.value}`);
});

console.log('\n[polar-stereo]');
await test('Polar stereographic round-trip (EPSG 3413, north)', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'polar-stereo', hemisphere: 'N', trueScaleLat: 70, lon0: -45,
                falseEasting: 0, falseNorthing: 0, epsg: 3413 };
  for (const [lat, lon] of [[75, -45], [80, 0], [70, 90], [85, 180]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-6, `lat drift ${back.lat - lat}`);
    // lon wrap: ±180 collapse
    const dLon = Math.abs(((back.lon - lon + 540) % 360) - 180);
    assert(dLon < 1e-6, `lon drift ${dLon} (got ${back.lon}, want ${lon})`);
  }
});

await test('Polar stereographic (south, EPSG 3031) round-trip', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'polar-stereo', hemisphere: 'S', trueScaleLat: -71, lon0: 0,
                falseEasting: 0, falseNorthing: 0, epsg: 3031 };
  for (const [lat, lon] of [[-75, 0], [-80, 90], [-71, -45]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-6, `lat drift ${back.lat - lat}`);
    const dLon = Math.abs(((back.lon - lon + 540) % 360) - 180);
    assert(dLon < 1e-6, `lon drift ${dLon}`);
  }
});

await test('Polar stereographic 3413 fixture: extract at known pixel', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const { nativeToLatLon } = await import('../lib/tiff/projections.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-tile-polarstereo-3413.tif')));
  const meta = await scan(buf);
  assertEq(meta.crs.epsg, 3413);
  // Pixel (0,0) center is at native (6250, -6250).
  const geo = { kind: 'polar-stereo', hemisphere: 'N', trueScaleLat: 70, lon0: -45,
                falseEasting: 0, falseNorthing: 0, epsg: 3413 };
  const ll = nativeToLatLon({ x: 6250, y: -6250 }, geo);
  const r = await extract(buf, { variable: 'band_1', lat: ll.lat, lon: ll.lon });
  // f32[0] = 0 * 0.5 + 1.0 = 1.0
  assert(Math.abs(r.value - 1.0) < 1e-5, `got ${r.value}`);
});

console.log('\n[albers]');
await test('Albers projection round-trip is accurate to <1e-6 deg', async () => {
  const { latLonToNative, nativeToLatLon } = await import('../lib/tiff/projections.js');
  const geo = { kind: 'albers', sp1: 29.5, sp2: 45.5, lat0: 23, lon0: -96,
                falseEasting: 0, falseNorthing: 0, epsg: 32767 };
  for (const [lat, lon] of [[35, -100], [42, -90], [30, -95]]) {
    const xy = latLonToNative({ lat, lon }, geo);
    const back = nativeToLatLon(xy, geo);
    assert(Math.abs(back.lat - lat) < 1e-6, `lat drift ${back.lat - lat}`);
    assert(Math.abs(back.lon - lon) < 1e-6, `lon drift ${back.lon - lon}`);
  }
});

await test('Albers fixture: extract at native (0,0) returns pixel (0,0) value', async () => {
  const { extract, scan } = await import('../lib/webparsers-api.js');
  const { nativeToLatLon } = await import('../lib/tiff/projections.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-deflate-fp-tile-albers.tif')));
  const meta = await scan(buf);
  assert(/Albers/i.test(meta.crs.name), 'CRS name should mention Albers');
  // Pixel (0,0) center at native (15, -15), pixel scale 30m.
  const geo = { kind: 'albers', sp1: 29.5, sp2: 45.5, lat0: 23, lon0: -96,
                falseEasting: 0, falseNorthing: 0, epsg: 32767 };
  const ll = nativeToLatLon({ x: 15, y: -15 }, geo);
  const r = await extract(buf, { variable: 'band_1', lat: ll.lat, lon: ll.lon });
  assert(Math.abs(r.value - 1.0) < 1e-5, `got ${r.value}`);
});

console.log('\n[cog-overviews]');
await test('2-IFD COG fixture: scan surfaces overview metadata', async () => {
  const { scan } = await import('../lib/webparsers-api.js');
  const buf = new Uint8Array(readFileSync(resolve(fixtures, 'synthetic-f32-none-tile-cog-2ifd-wgs84.tif')));
  const meta = await scan(buf);
  assertEq(meta.format, 'tiff');
  assertEq(meta.width, 16);
  assertEq(meta.height, 16);
  assert(Array.isArray(meta.overviews), 'overviews should be an array');
  assertEq(meta.overviews.length, 1);
  assertEq(meta.overviews[0].width, 8);
  assertEq(meta.overviews[0].height, 8);
  assertEq(meta.overviews[0].ratio, 2);
  assertEq(meta.cog, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
