#!/usr/bin/env node
// scripts/test-map-bbox.js - tests for the map-demo pure bbox helpers.

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.stack || e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`); }

const COVERAGE = [-180, -90, 180, 90]; // [minLon, minLat, maxLon, maxLat]

console.log('[validateBbox]');

await test('valid box inside coverage returns clamped [minLon,minLat,maxLon,maxLat]', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 29, maxLat: 31, minLon: -91, maxLon: -89 }, COVERAGE);
  assertEq(r.error, null, 'error');
  assertEq(JSON.stringify(r.bbox), JSON.stringify([-91, 29, -89, 31]), 'bbox');
});

await test('non-numeric input is rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: NaN, maxLat: 31, minLon: -91, maxLon: -89 }, COVERAGE);
  assertEq(r.bbox, null, 'bbox');
  assert(/all four/i.test(r.error), 'error mentions all four numbers');
});

await test('min >= max on latitude is rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 31, maxLat: 31, minLon: -91, maxLon: -89 }, COVERAGE);
  assertEq(r.bbox, null, 'bbox');
  assert(/lat/i.test(r.error), 'error mentions lat');
});

await test('min >= max on longitude is rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 29, maxLat: 31, minLon: -89, maxLon: -91 }, COVERAGE);
  assertEq(r.bbox, null, 'bbox');
  assert(/lon/i.test(r.error), 'error mentions lon');
});

await test('latitude outside coverage is rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 29, maxLat: 95, minLon: -91, maxLon: -89 }, COVERAGE);
  assertEq(r.bbox, null, 'bbox');
  assert(/lat/i.test(r.error), 'error mentions lat');
});

await test('longitude outside coverage is rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 29, maxLat: 31, minLon: -181, maxLon: -89 }, COVERAGE);
  assertEq(r.bbox, null, 'bbox');
  assert(/lon/i.test(r.error), 'error mentions lon');
});

await test('tiny float overshoot within epsilon is clamped, not rejected', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const r = validateBbox({ minLat: 29, maxLat: 90 + 1e-12, minLon: -91, maxLon: -89 }, COVERAGE);
  assertEq(r.error, null, 'error');
  assertEq(r.bbox[3], 90, 'maxLat clamped to coverage');
});

await test('non-global coverage narrows the allowed range', async () => {
  const { validateBbox } = await import('../examples/map-demo-bbox.js');
  const cov = [-100, 25, -80, 40];
  const ok = validateBbox({ minLat: 28, maxLat: 35, minLon: -95, maxLon: -85 }, cov);
  assertEq(ok.error, null, 'in-range ok');
  const bad = validateBbox({ minLat: 28, maxLat: 35, minLon: -110, maxLon: -85 }, cov);
  assertEq(bad.bbox, null, 'out-of-range rejected');
});

console.log('[resolutionBucket]');

await test('rounds to the nearest 32 by default', async () => {
  const { resolutionBucket } = await import('../examples/map-demo-bbox.js');
  assertEq(resolutionBucket(100), 96, '100 -> 96');
  assertEq(resolutionBucket(112), 128, '112 -> 128');
  assertEq(resolutionBucket(96), 96, '96 -> 96 (exact multiple)');
});

await test('same value buckets identically (pan no-op detection)', async () => {
  const { resolutionBucket } = await import('../examples/map-demo-bbox.js');
  assertEq(resolutionBucket(513), resolutionBucket(519), 'near-equal px share a bucket');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
