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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
