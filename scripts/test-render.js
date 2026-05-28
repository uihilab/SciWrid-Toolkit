#!/usr/bin/env node
// scripts/test-render.js — tests for the render pipeline.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { console.log('SKIP'); return; }
    passed++; console.log('OK');
  } catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`); }

console.log('[colorramps]');
await test('viridis endpoints match canonical Matplotlib stops', async () => {
  const { resolveRamp, sampleRamp } = await import('../lib/render/colorramps.js');
  const r = resolveRamp('viridis');
  const c0 = sampleRamp(r, 0);
  const c1 = sampleRamp(r, 1);
  assertEq(c0[0], 68);    // viridis at 0: (68, 1, 84) — Matplotlib canonical
  assertEq(c1[2], 37);    // viridis at 1: (253, 231, 37)
});

await test('NaN → black (sentinel for missing data)', async () => {
  const { resolveRamp, sampleRamp } = await import('../lib/render/colorramps.js');
  const r = resolveRamp('viridis');
  const c = sampleRamp(r, NaN);
  assertEq(c[0], 0); assertEq(c[1], 0); assertEq(c[2], 0);
});

await test('custom ramp interpolates linearly', async () => {
  const { sampleRamp } = await import('../lib/render/colorramps.js');
  const ramp = [[0, [0, 0, 0]], [1, [255, 255, 255]]];
  const c = sampleRamp(ramp, 0.5);
  assertEq(c[0], 128); assertEq(c[1], 128); assertEq(c[2], 128);
});

await test('resolveRamp rejects unknown built-in names', async () => {
  const { resolveRamp } = await import('../lib/render/colorramps.js');
  let threw = false;
  try { resolveRamp('nope'); } catch { threw = true; }
  assert(threw, 'should throw on unknown ramp name');
});

console.log('\n[normalize]');
await test('autoRange ignores NaN and Infinity', async () => {
  const { autoRange } = await import('../lib/render/normalize.js');
  const r = autoRange(new Float32Array([1, NaN, 3, Infinity, -2, 4]));
  assertEq(r.vmin, -2); assertEq(r.vmax, 4);
});

await test('autoRange returns null for all-NaN', async () => {
  const { autoRange } = await import('../lib/render/normalize.js');
  assertEq(autoRange(new Float32Array([NaN, NaN])), null);
});

await test('autoRange handles flat grids without divide-by-zero', async () => {
  const { autoRange } = await import('../lib/render/normalize.js');
  const r = autoRange(new Float32Array([5, 5, 5]));
  assert(r.vmax > r.vmin, 'vmax > vmin even on flat input');
});

console.log('\n[gridToImageData]');
await test('gridToImageData produces width×height×4 bytes', async () => {
  const { gridToImageData } = await import('../lib/render/index.js');
  const grid = {
    data: new Float32Array([0, 0.5, 1.0, NaN]),
    width: 2, height: 2,
  };
  const img = gridToImageData(grid, { ramp: 'viridis' });
  assertEq(img.width, 2); assertEq(img.height, 2);
  assertEq(img.data.length, 16);
  // NaN pixel is transparent by default
  assertEq(img.data[15], 0); // alpha of pixel 3 (NaN)
});

await test('explicit vmin/vmax overrides autoRange', async () => {
  const { gridToImageData } = await import('../lib/render/index.js');
  const grid = { data: new Float32Array([0, 100]), width: 2, height: 1 };
  const img = gridToImageData(grid, { ramp: 'grayscale', vmin: 0, vmax: 1000 });
  // 100 of 1000 → t = 0.1 → ~grayscale 26
  assert(Math.abs(img.data[4] - 26) <= 1, `grayscale ramp at t=0.1 → got ${img.data[4]}`);
});

await test('all-NaN grid fills with nodataColor', async () => {
  const { gridToImageData } = await import('../lib/render/index.js');
  const grid = { data: new Float32Array([NaN, NaN, NaN, NaN]), width: 2, height: 2 };
  const img = gridToImageData(grid, { ramp: 'viridis', nodataColor: [9, 9, 9, 99] });
  assertEq(img.data[0], 9); assertEq(img.data[3], 99);
});

await test('gridToImageData is exported from the public API', async () => {
  const api = await import('../index.js');
  assert(typeof api.gridToImageData === 'function', 'gridToImageData should be a public export');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
