#!/usr/bin/env node
// scripts/test-time.js — CF time decoder tests.

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'assert'}: got ${a}, want ${b}`); }

console.log('[time-decoder]');

const { decodeTimes, parseCFUnits, normalizeCalendar } = await import('../lib/time-decoder.js');

await test('hours since standard epoch', () => {
  const r = decodeTimes([0, 24, 48], 'hours since 2024-01-01', 'standard');
  assertEq(r.values[0], '2024-01-01T00:00:00Z');
  assertEq(r.values[1], '2024-01-02T00:00:00Z');
  assertEq(r.values[2], '2024-01-03T00:00:00Z');
  assertEq(r.unitsRaw, 'hours since 2024-01-01');
  assertEq(r.calendar, 'standard');
});

await test('seconds since with sub-hour resolution', () => {
  const r = decodeTimes([3600, 5400], 'seconds since 2024-06-01 00:00:00', 'standard');
  assertEq(r.values[0], '2024-06-01T01:00:00Z');
  assertEq(r.values[1], '2024-06-01T01:30:00Z');
});

await test('standard calendar: respects leap years (2024)', () => {
  const r = decodeTimes([0, 365], 'days since 2024-01-01', 'standard');
  // 2024 is leap → day 365 is 2024-12-31
  assertEq(r.values[1], '2024-12-31T00:00:00Z');
});

await test('standard calendar: non-leap year (2023)', () => {
  const r = decodeTimes([365], 'days since 2023-01-01', 'standard');
  // 2023 is non-leap → day 365 is 2024-01-01
  assertEq(r.values[0], '2024-01-01T00:00:00Z');
});

await test('noleap calendar: NO leap day in 2024', () => {
  const r = decodeTimes([59, 60], 'days since 2024-01-01', 'noleap');
  // Day 59 = March 1 (31+28), day 60 = March 2 — NO Feb 29.
  assertEq(r.values[0], '2024-03-01T00:00:00Z');
  assertEq(r.values[1], '2024-03-02T00:00:00Z');
});

await test('360_day calendar: every month is 30 days', () => {
  const r = decodeTimes([30, 60, 90], 'days since 2024-01-01', '360_day');
  assertEq(r.values[0], '2024-02-01T00:00:00Z');
  assertEq(r.values[1], '2024-03-01T00:00:00Z');
  assertEq(r.values[2], '2024-04-01T00:00:00Z');
});

await test('calendar aliases: 365_day → noleap', () => {
  assertEq(normalizeCalendar('365_day'), 'noleap');
  assertEq(normalizeCalendar('365'), 'noleap');
  assertEq(normalizeCalendar('gregorian'), 'standard');
  assertEq(normalizeCalendar('proleptic_gregorian'), 'standard');
});

await test('unsupported calendar throws', () => {
  let err;
  try { decodeTimes([0], 'days since 2024-01-01', 'julian'); }
  catch (e) { err = e; }
  if (!err) throw new Error('expected throw');
  if (!/unsupported calendar/i.test(err.message)) throw new Error(`bad msg: ${err.message}`);
});

await test('unsupported units string throws with clear message', () => {
  let err;
  try { decodeTimes([0], 'weeks since 2024-01-01'); }
  catch (e) { err = e; }
  if (!err || !/unsupported time unit/i.test(err.message))
    throw new Error(`expected "unsupported time unit" error, got: ${err && err.message}`);
});

await test('parseCFUnits handles trailing Z', () => {
  const r = parseCFUnits('seconds since 1970-01-01T00:00:00Z');
  assertEq(r.epoch.year, 1970);
  assertEq(r.secondsPerUnit, 1);
});

await test('Float32Array input works', () => {
  const r = decodeTimes(new Float32Array([0, 1, 2]), 'days since 2024-01-01');
  assertEq(r.values[0], '2024-01-01T00:00:00Z');
  assertEq(r.values[2], '2024-01-03T00:00:00Z');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
