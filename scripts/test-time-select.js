#!/usr/bin/env node
// scripts/test-time-select.js — tests for date-based time selection.
let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { const r = await fn(); if (r === 'skip') { console.log('SKIP'); return; }
    passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`); }

console.log('[toEpochMs]');
await test('parses ISO string, Date, and epoch ms', async () => {
  const { toEpochMs } = await import('../lib/time-select.js');
  assertEq(toEpochMs('1970-01-01T00:00:00Z'), 0, 'iso epoch');
  assertEq(toEpochMs(new Date(172800000)), 172800000, 'Date');
  assertEq(toEpochMs(172800000), 172800000, 'number is ms');
});

await test('throws on unparseable date', async () => {
  const { toEpochMs } = await import('../lib/time-select.js');
  let threw = false;
  try { toEpochMs('not-a-date'); } catch { threw = true; }
  assert(threw, 'should throw on garbage');
});

console.log('\n[resolveTimeIndex]');
await test('nearest match picks the closest index', async () => {
  const { resolveTimeIndex } = await import('../lib/time-select.js');
  const axis = [0, 10, 20, 30];            // ms
  assertEq(resolveTimeIndex(axis, 0), 0);
  assertEq(resolveTimeIndex(axis, 12), 1); // closer to 10
  assertEq(resolveTimeIndex(axis, 16), 2); // closer to 20
  assertEq(resolveTimeIndex(axis, 999), 3);// clamps to last
  assertEq(resolveTimeIndex(axis, -999), 0);// clamps to first
});

await test('ties resolve to the lower index', async () => {
  const { resolveTimeIndex } = await import('../lib/time-select.js');
  assertEq(resolveTimeIndex([0, 10], 5), 0, 'tie → lower');
});

console.log('\n[axisFromMeta]');
await test('real CF times from variable.times.values', async () => {
  const { axisFromMeta } = await import('../lib/time-select.js');
  const meta = { format: 'grib2', variables: [
    { name: 'TMP', times: { values: ['2026-04-14T06:00:00Z', '2026-04-14T12:00:00Z'] } },
  ]};
  const axis = axisFromMeta(meta, 'TMP');
  assertEq(axis.kind, 'real');
  assertEq(axis.ms.length, 2);
  assertEq(axis.ms[0], Date.parse('2026-04-14T06:00:00Z'));
});

await test('file-level meta.times used when variable has none', async () => {
  const { axisFromMeta } = await import('../lib/time-select.js');
  const meta = { format: 'netcdf4', times: { values: ['2020-01-01T00:00:00Z'] },
    variables: [{ name: 'x' }] };
  const axis = axisFromMeta(meta, 'x');
  assertEq(axis.kind, 'real'); assertEq(axis.ms.length, 1);
});

await test('synthetic Zarr axis = t*86400*1000 ms from shape[0]', async () => {
  const { axisFromMeta } = await import('../lib/time-select.js');
  const meta = { format: 'zarr', variables: [{ name: 'z', shape: [3, 4, 5] }] };
  const axis = axisFromMeta(meta, 'z');
  assertEq(axis.kind, 'synthetic');
  assertEq(axis.ms.length, 3);
  assertEq(axis.ms[2], 2 * 86400 * 1000); // 2 days
});

await test('no time axis → kind "none"', async () => {
  const { axisFromMeta } = await import('../lib/time-select.js');
  const meta = { format: 'tiff', variables: [{ name: 'band_1' }] };
  const axis = axisFromMeta(meta, 'band_1');
  assertEq(axis.kind, 'none');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
