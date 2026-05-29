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

console.log('\n[api integration: GFS fixture]');
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const gfsPath = resolve(__dirname, '..', 'examples', 'timeseries', 'gfs_timeseries.grb2');

await test('extract({ date }) equals extract({ t1, t2 }) for the same step', async () => {
  if (!existsSync(gfsPath)) return 'skip';
  const { scan, extract } = await import('../lib/webparsers-api.js');
  const bytes = new Uint8Array(readFileSync(gfsPath));
  const variable = 'Pressure reduced to MSL';
  const meta = await scan(bytes);
  const times = (meta.times?.values) || meta.variables.find(v => v.name === variable)?.times?.values;
  if (!times || times.length < 2) return 'skip';
  const byIdx  = await extract(bytes, { variable, t1: 1, t2: 1 });
  const byDate = await extract(bytes, { variable, date: times[1] });
  assert(JSON.stringify(byDate) === JSON.stringify(byIdx),
    `date and index disagree:\n  date: ${JSON.stringify(byDate)}\n  idx:  ${JSON.stringify(byIdx)}`);
});

await test('extract throws when date and t1 are both given', async () => {
  if (!existsSync(gfsPath)) return 'skip';
  const { extract, WebparsersError } = await import('../lib/webparsers-api.js');
  const bytes = new Uint8Array(readFileSync(gfsPath));
  let err = null;
  try { await extract(bytes, { variable: 'Pressure reduced to MSL', date: '2026-04-14T06:00:00Z', t1: 0 }); }
  catch (e) { err = e; }
  assert(err instanceof WebparsersError, `wrong/no error: ${err}`);
});

await test('extractGrid({ date }) equals extractGrid({ time }) for the same step', async () => {
  if (!existsSync(gfsPath)) return 'skip';
  const { scan, extractGrid } = await import('../lib/webparsers-api.js');
  const bytes = new Uint8Array(readFileSync(gfsPath));
  const variable = 'Pressure reduced to MSL';
  const meta = await scan(bytes);
  const times = (meta.times?.values) || meta.variables.find(v => v.name === variable)?.times?.values;
  if (!times || times.length < 2) return 'skip';
  const opts = { variable, bbox: [-100, 30, -80, 45], width: 8, height: 8 };
  const g1 = await extractGrid(bytes, { ...opts, time: 1 });
  const gd = await extractGrid(bytes, { ...opts, date: times[1] });
  let same = g1.data.length === gd.data.length;
  for (let i = 0; same && i < g1.data.length; i++) {
    const a = g1.data[i], b = gd.data[i];
    if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) same = false;
  }
  assert(same, 'date-selected grid differs from index-selected grid');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
