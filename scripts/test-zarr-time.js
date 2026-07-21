#!/usr/bin/env node
/**
 * scripts/test-zarr-time.js — regression test for CF time decoding on the
 * Zarr *extract* path.
 *
 * Run from repo root:
 *   node scripts/test-zarr-time.js
 *
 * Requires the WASM to be built:
 *   python wasm/build.py
 *
 * Background: scan() decoded CF times correctly (zarr-helper.js:139 calls
 * decodeTimes) but extract() passed the raw time-coordinate value straight to
 * the C engine, which interprets that buffer as unix epoch SECONDS. For an
 * axis of `days since 2001-01-01` with value 0 that rendered as 1970-01-01.
 *
 * scripts/test-zarr.js could never catch this: its fixture uses
 * `seconds since 1970-01-01`, the one CF units string for which the raw
 * value already IS epoch seconds.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scan, extract } from '../lib/sciwrid-api.js';
import SciWridToolkit from '../wasm/sciwrid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

const wasmBinary = readFileSync(resolve(root, 'wasm/sciwrid.wasm'));
const wf = { wasmFactory: () => SciWridToolkit({ wasmBinary }) };

/* ---------------- Tiny test runner (matches test-zarr.js style) ---------------- */
let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/* ---------------- ZIP builder: stored entries only, CRC=0 ----------------
 * Same minimal-ZIP contract as scripts/test-zarr.js — the zarr reader ignores
 * CRC and accepts method=0 stored entries.
 * ----------------------------------------------------------------------- */
function buildZip(entries) {
  const enc = new TextEncoder();
  const localParts = [], cdParts = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name);

    const lh   = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0,  0x04034b50, true);
    lhDV.setUint16(4,  20, true);
    lhDV.setUint16(8,  0,  true);            // method 0 = stored
    lhDV.setUint32(18, bytes.length, true);
    lhDV.setUint32(22, bytes.length, true);
    lhDV.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    localParts.push(lh, bytes);

    const cd   = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0,  0x02014b50, true);
    cdDV.setUint16(4,  20, true);
    cdDV.setUint16(6,  20, true);
    cdDV.setUint32(20, bytes.length, true);
    cdDV.setUint32(24, bytes.length, true);
    cdDV.setUint16(28, nameBytes.length, true);
    cdDV.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + bytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.length;

  const eocd   = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0,  0x06054b50, true);
  eocdDV.setUint16(8,  entries.length, true);
  eocdDV.setUint16(10, entries.length, true);
  eocdDV.setUint32(12, cdSize, true);
  eocdDV.setUint32(16, cdOffset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of cdParts)    { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

const jsonBytes = (o) => new TextEncoder().encode(JSON.stringify(o));
const f32Bytes  = (a) => { const u = new Uint8Array(a.length * 4); new Float32Array(u.buffer).set(a); return u; };
const f64Bytes  = (a) => { const u = new Uint8Array(a.length * 8); new Float64Array(u.buffer).set(a); return u; };

/* ---------------- Fixture ----------------
 * precip[2 time, 3 lat, 3 lon], Float32, one chunk, uncompressed.
 * The time axis units/values are the parameter under test.
 * ---------------------------------------- */
function buildFixture(units, timeValues) {
  const arrMeta = (shape, dtype) => ({
    zarr_format: 2, shape, chunks: shape, dtype,
    compressor: null, fill_value: null, order: 'C', filters: null,
    dimension_separator: '.',
  });

  return buildZip([
    { name: '.zgroup', bytes: jsonBytes({ zarr_format: 2 }) },

    { name: 'precip/.zarray', bytes: jsonBytes(arrMeta([2, 3, 3], '<f4')) },
    { name: 'precip/.zattrs', bytes: jsonBytes({
        _ARRAY_DIMENSIONS: ['time', 'lat', 'lon'],
        units: 'mm/day', long_name: 'Total precipitation',
    })},
    { name: 'precip/0.0.0', bytes: f32Bytes([
        0, 1, 2,    3, 4, 5,    6, 7, 8,
        10, 11, 12, 13, 14, 15, 16, 17, 18,
    ])},

    { name: 'time/.zarray', bytes: jsonBytes(arrMeta([2], '<f8')) },
    { name: 'time/.zattrs', bytes: jsonBytes({
        _ARRAY_DIMENSIONS: ['time'], units, calendar: 'standard',
    })},
    { name: 'time/0', bytes: f64Bytes(timeValues) },

    { name: 'lat/.zarray', bytes: jsonBytes(arrMeta([3], '<f4')) },
    { name: 'lat/.zattrs', bytes: jsonBytes({
        _ARRAY_DIMENSIONS: ['lat'], units: 'degrees_north',
    })},
    { name: 'lat/0', bytes: f32Bytes([30.0, 35.0, 40.0]) },

    { name: 'lon/.zarray', bytes: jsonBytes(arrMeta([3], '<f4')) },
    { name: 'lon/.zattrs', bytes: jsonBytes({
        _ARRAY_DIMENSIONS: ['lon'], units: 'degrees_east',
    })},
    { name: 'lon/0', bytes: f32Bytes([-100.0, -95.0, -90.0]) },
  ]);
}

const times = (r) => (r && Array.isArray(r.timeseries)) ? r.timeseries : [];

console.log('\nZarr CF-time decoding (extract path)\n');

await test('scan() and extract() agree on `days since 2001-01-01`', async () => {
  const bytes = buildFixture('days since 2001-01-01', [0, 1]);

  const s = await scan(bytes, wf);
  assert(s.times.values[0] === '2001-01-01T00:00:00Z',
    `scan t0: got ${s.times.values[0]}`);

  const r  = await extract(bytes, { ...wf, variable: 'precip', lat: 35.0, lon: -95.0 });
  const ts = times(r);
  assert(ts.length === 2, `expected 2 steps, got ${JSON.stringify(r)}`);
  assert(ts[0].time === '2001-01-01T00:00:00Z',
    `extract t0: got ${ts[0].time}, want 2001-01-01T00:00:00Z`);
  assert(ts[1].time === '2001-01-02T00:00:00Z',
    `extract t1: got ${ts[1].time}, want 2001-01-02T00:00:00Z`);
});

await test('`hours since 1900-01-01` survives without Float32 truncation', async () => {
  /* 1900-01-01 + 884652 h = 2000-12-02T12:00:00Z (cross-checked against
   * Python cftime.num2date, the CF reference implementation). As epoch
   * seconds that is ~9.76e8, far above Float32's 2^24 exact-integer limit,
   * so a Float32 round-trip of the decoded value would visibly corrupt it. */
  const bytes = buildFixture('hours since 1900-01-01', [884652, 884653]);
  const ts = times(await extract(bytes,
    { ...wf, variable: 'precip', lat: 35.0, lon: -95.0 }));
  assert(ts[0].time === '2000-12-02T12:00:00Z',
    `got ${ts[0].time}, want 2000-12-02T12:00:00Z`);
  assert(ts[1].time === '2000-12-02T13:00:00Z',
    `got ${ts[1].time}, want 2000-12-02T13:00:00Z`);
});

await test('legacy `seconds since 1970-01-01` still correct (no regression)', async () => {
  const bytes = buildFixture('seconds since 1970-01-01', [0, 3600]);
  const ts = times(await extract(bytes,
    { ...wf, variable: 'precip', lat: 35.0, lon: -95.0 }));
  assert(ts[0].time === '1970-01-01T00:00:00Z', `got ${ts[0].time}`);
  assert(ts[1].time === '1970-01-01T01:00:00Z', `got ${ts[1].time}`);
});

await test('extracted VALUES are unaffected by the time fix', async () => {
  const bytes = buildFixture('days since 2001-01-01', [0, 1]);
  const ts = times(await extract(bytes,
    { ...wf, variable: 'precip', lat: 35.0, lon: -95.0 }));
  // centre cell of each 3x3 plane: 4 at t=0, 14 at t=1
  assert(ts[0].value === 4,  `t0 value: got ${ts[0].value}, want 4`);
  assert(ts[1].value === 14, `t1 value: got ${ts[1].value}, want 14`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
