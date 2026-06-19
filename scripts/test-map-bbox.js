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

console.log('[mercatorWarpGrid]');

// Build a 1-column equirectangular grid whose value at each row IS that row's
// source latitude, so a warped row's value reads back as the latitude it samples.
async function latGrid(minLat, maxLat, H = 2048) {
  const data = new Float32Array(H);
  for (let r = 0; r < H; r++) data[r] = maxLat - ((r + 0.5) / H) * (maxLat - minLat);
  return { data, width: 1, height: H, bbox: [-180, minLat, 180, maxLat] };
}

await test('equator stays centered; poles map to the Mercator-clamped edges', async () => {
  const { mercatorWarpGrid, MERCATOR_MAX_LAT } = await import('../examples/map-demo-bbox.js');
  const H = 2048;
  const w = mercatorWarpGrid(await latGrid(-90, 90, H));
  assert(Math.abs(w.data[H >> 1]) < 0.3, `middle row should be ~equator, got ${w.data[H >> 1]}`);
  assert(Math.abs(w.data[0] - MERCATOR_MAX_LAT) < 0.3, `top row should be ~+${MERCATOR_MAX_LAT}, got ${w.data[0]}`);
  assert(Math.abs(w.data[H - 1] + MERCATOR_MAX_LAT) < 0.3, `bottom row should be ~-${MERCATOR_MAX_LAT}, got ${w.data[H - 1]}`);
});

await test('mid-latitude data is pushed poleward vs the equirect (linear) placement', async () => {
  const { mercatorWarpGrid } = await import('../examples/map-demo-bbox.js');
  const H = 2048;
  const w = mercatorWarpGrid(await latGrid(-90, 90, H));
  // Output row H/4 sits at linear latitude +42.5 in the clamped box, but in
  // Mercator that screen position is a HIGHER latitude — so the value there
  // (the latitude actually sampled) must exceed the linear 42.5.
  const linearLatAtQuarter = 42.526; // 85.05 - 0.25*170.1
  assert(w.data[H >> 2] > linearLatAtQuarter + 5,
    `expected reprojected lat well above linear ${linearLatAtQuarter}, got ${w.data[H >> 2]}`);
});

await test('rows stay monotonically north→south after warp', async () => {
  const { mercatorWarpGrid } = await import('../examples/map-demo-bbox.js');
  const w = mercatorWarpGrid(await latGrid(-90, 90, 512));
  let ok = true;
  for (let r = 1; r < w.height; r++) if (w.data[r] > w.data[r - 1] + 1e-6) { ok = false; break; }
  assert(ok, 'warped rows must be non-increasing in latitude (north→south)');
});

await test('near-equator sub-box is barely changed (small Mercator distortion)', async () => {
  const { mercatorWarpGrid } = await import('../examples/map-demo-bbox.js');
  const H = 1024;
  const w = mercatorWarpGrid(await latGrid(-10, 10, H));
  // Within ±10°, Mercator ≈ linear, so the middle row stays ~equator and the
  // shift is sub-degree — matching the "sub-box renders fine" observation.
  assert(Math.abs(w.data[H >> 1]) < 0.1, `middle ~equator, got ${w.data[H >> 1]}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
