#!/usr/bin/env node
/**
 * scripts/test-zarr.js — smoke test for the Zarr v2 path (Sprint 4).
 *
 * Run from repo root:
 *   node scripts/test-zarr.js
 *
 * Requires the WASM to be built:
 *   python wasm/build.py
 *
 * Builds a tiny xarray-style v2 store in memory (no committed binary fixture,
 * no Python dependency) and exercises scan / extract / extractGrid against it.
 *
 * Covers:
 *   - scan() lists every array (data var + coord arrays)
 *   - data var attrs (incl. CRS strings) flow through to meta.variables[*].attrs
 *   - coord_source === 'explicit' when _ARRAY_DIMENSIONS links to real arrays
 *   - extract() at known lat/lon returns the expected cell value
 *   - extractGrid() bbox is interpreted in real degrees (not synthetic indices)
 *   - When coord arrays are missing, warnings[] is populated and
 *     coord_source === 'synthetic'
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  scan, extract, extractGrid,
  extractGridOutput, gridToJSON, gridToGeoTIFF,
} from '../wasm/webparsers-api.js';
import WebParsers from '../wasm/webparsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

const wasmBinary  = readFileSync(resolve(root, 'wasm/webparsers.wasm'));
const wf = { wasmFactory: () => WebParsers({ wasmBinary }) };

/* ---------------- Tiny test runner (matches test-grid.js style) ---------------- */
let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { skipped++; console.log('SKIP'); }
    else              { passed++;  console.log('OK');   }
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.error('    →', e.stack || e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertClose(a, b, eps, msg) {
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg || 'not close'}: got ${a}, want ${b} (|diff|=${Math.abs(a-b)})`);
  }
}

/* ---------------- ZIP builder: stored entries only, CRC=0 ----------------
 * The existing zarr-helper readZip ignores CRC and accepts method=0 stored
 * entries (wasm/zarr-helper.js:80-111), so we produce the minimal valid ZIP.
 * ----------------------------------------------------------------------- */
function buildZip(entries) {
  const enc = new TextEncoder();
  const localParts = [];
  const cdParts    = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = enc.encode(name);

    /* Local file header (30B fixed + name) */
    const lh   = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0,  0x04034b50, true);   // signature
    lhDV.setUint16(4,  20, true);           // version needed
    lhDV.setUint16(6,  0,  true);           // gp flag
    lhDV.setUint16(8,  0,  true);           // method (0 = stored)
    lhDV.setUint16(10, 0,  true);           // mtime
    lhDV.setUint16(12, 0,  true);           // mdate
    lhDV.setUint32(14, 0,  true);           // crc-32 (reader ignores)
    lhDV.setUint32(18, bytes.length, true); // comp size
    lhDV.setUint32(22, bytes.length, true); // uncomp size
    lhDV.setUint16(26, nameBytes.length, true);
    lhDV.setUint16(28, 0,  true);           // extra
    lh.set(nameBytes, 30);
    localParts.push(lh, bytes);

    /* Central directory entry (46B fixed + name) */
    const cd   = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0,  0x02014b50, true);
    cdDV.setUint16(4,  20, true);
    cdDV.setUint16(6,  20, true);
    cdDV.setUint16(8,  0,  true);
    cdDV.setUint16(10, 0,  true);
    cdDV.setUint16(12, 0,  true);
    cdDV.setUint16(14, 0,  true);
    cdDV.setUint32(16, 0,  true);
    cdDV.setUint32(20, bytes.length, true);
    cdDV.setUint32(24, bytes.length, true);
    cdDV.setUint16(28, nameBytes.length, true);
    cdDV.setUint16(30, 0,  true);
    cdDV.setUint16(32, 0,  true);
    cdDV.setUint16(34, 0,  true);
    cdDV.setUint16(36, 0,  true);
    cdDV.setUint32(38, 0,  true);
    cdDV.setUint32(42, offset, true);       // offset of local header
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + bytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.length;

  /* End-of-central-directory (22B) */
  const eocd   = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0,  0x06054b50, true);
  eocdDV.setUint16(4,  0, true);
  eocdDV.setUint16(6,  0, true);
  eocdDV.setUint16(8,  entries.length, true);
  eocdDV.setUint16(10, entries.length, true);
  eocdDV.setUint32(12, cdSize, true);
  eocdDV.setUint32(16, cdOffset, true);
  eocdDV.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of cdParts)    { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

const jsonBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const f32Bytes  = (arr) => { const u = new Uint8Array(arr.length * 4); new Float32Array(u.buffer).set(arr); return u; };
const f64Bytes  = (arr) => { const u = new Uint8Array(arr.length * 8); new Float64Array(u.buffer).set(arr); return u; };

/* ---------------- Fixture builder ----------------
 * temperature[2 time, 3 lat, 3 lon], Float32, one chunk, uncompressed.
 *   t=0 plane: rows by lat (30, 35, 40 N), cols by lon (-100, -95, -90 E)
 *     0 1 2
 *     3 4 5
 *     6 7 8
 *   t=1 plane: 10..18
 * Layout (C-order, row-major) matches what zarr-helper.readArrayAsFloat32 emits.
 * ----------------------------------------------------------------------- */
function buildFixture({ withCoords = true, withCrs = false } = {}) {
  const tempAttrs = {
    _ARRAY_DIMENSIONS: ['time', 'lat', 'lon'],
    units: 'K',
    long_name: 'air temperature',
  };
  if (withCrs) {
    tempAttrs.crs_wkt =
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  }

  const entries = [
    { name: '.zgroup', bytes: jsonBytes({ zarr_format: 2 }) },

    { name: 'temperature/.zarray', bytes: jsonBytes({
        zarr_format: 2,
        shape:       [2, 3, 3],
        chunks:      [2, 3, 3],
        dtype:       '<f4',
        compressor:  null,
        fill_value:  null,
        order:       'C',
        filters:     null,
        dimension_separator: '.',
    })},
    { name: 'temperature/.zattrs', bytes: jsonBytes(tempAttrs) },
    { name: 'temperature/0.0.0',  bytes: f32Bytes([
        0, 1, 2,    3, 4, 5,    6, 7, 8,
        10, 11, 12, 13, 14, 15, 16, 17, 18,
    ])},
  ];

  if (withCoords) {
    entries.push(
      { name: 'time/.zarray', bytes: jsonBytes({
          zarr_format: 2, shape: [2], chunks: [2], dtype: '<f8',
          compressor: null, fill_value: null, order: 'C', filters: null,
          dimension_separator: '.',
      })},
      { name: 'time/.zattrs', bytes: jsonBytes({
          _ARRAY_DIMENSIONS: ['time'],
          units: 'seconds since 1970-01-01',
      })},
      { name: 'time/0', bytes: f64Bytes([0, 3600]) },

      { name: 'lat/.zarray', bytes: jsonBytes({
          zarr_format: 2, shape: [3], chunks: [3], dtype: '<f4',
          compressor: null, fill_value: null, order: 'C', filters: null,
          dimension_separator: '.',
      })},
      { name: 'lat/.zattrs', bytes: jsonBytes({
          _ARRAY_DIMENSIONS: ['lat'], units: 'degrees_north',
      })},
      { name: 'lat/0', bytes: f32Bytes([30.0, 35.0, 40.0]) },

      { name: 'lon/.zarray', bytes: jsonBytes({
          zarr_format: 2, shape: [3], chunks: [3], dtype: '<f4',
          compressor: null, fill_value: null, order: 'C', filters: null,
          dimension_separator: '.',
      })},
      { name: 'lon/.zattrs', bytes: jsonBytes({
          _ARRAY_DIMENSIONS: ['lon'], units: 'degrees_east',
      })},
      { name: 'lon/0', bytes: f32Bytes([-100.0, -95.0, -90.0]) },
    );
  }

  return buildZip(entries);
}

/* ---------------- Helpers to introspect extract() result ----------------
 * Result shape varies (see test-grid.js:139-140 — `r.value` for scalar,
 * `r.timeseries?.[0]?.value` for per-time-step series).
 * ----------------------------------------------------------------------- */
function pickScalar(r) {
  const obj = Array.isArray(r) ? r[0] : (r && r.variables ? r.variables[0] : r);
  if (!obj) return undefined;
  if (typeof obj.value === 'number') return obj.value;
  if (Array.isArray(obj.timeseries) && obj.timeseries[0]) {
    if (typeof obj.timeseries[0].value === 'number') return obj.timeseries[0].value;
  }
  if (Array.isArray(obj.values) && obj.values.length) return obj.values[0];
  return undefined;
}

/* ============================================================================
 * Tests
 * ========================================================================== */

console.log('Building in-memory Zarr v2 fixture (xarray-style, _ARRAY_DIMENSIONS)...\n');
const zipBytes = buildFixture({ withCoords: true, withCrs: true });
console.log(`  fixture size: ${zipBytes.length} bytes\n`);

let meta;

await test('scan() finds 4 arrays (temperature + lat/lon/time)', async () => {
  meta = await scan(zipBytes, wf);
  assert(Array.isArray(meta.variables), 'meta.variables is not an array');
  const names = meta.variables.map(v => v.name).sort();
  assert(names.length === 4, `expected 4 arrays, got ${names.length}: ${names.join(',')}`);
  assert(names.includes('temperature'), 'missing temperature');
  assert(names.includes('time'),        'missing time');
  assert(names.includes('lat'),         'missing lat');
  assert(names.includes('lon'),         'missing lon');
});

await test('temperature metadata: dtype, shape, _ARRAY_DIMENSIONS', async () => {
  const v = meta.variables.find(x => x.name === 'temperature');
  assert(v, 'no temperature in meta');
  assert(v.dtype === '<f4', 'dtype mismatch: ' + v.dtype);
  assert(JSON.stringify(v.shape) === '[2,3,3]', 'shape mismatch: ' + JSON.stringify(v.shape));
  assert(v.attrs && Array.isArray(v.attrs._ARRAY_DIMENSIONS), '_ARRAY_DIMENSIONS missing from attrs');
  assert(v.coord_source === 'explicit',
    'coord_source should be "explicit", got: ' + v.coord_source);
});

await test('CRS attrs flow through scan() into meta.variables[*].attrs', async () => {
  const v = meta.variables.find(x => x.name === 'temperature');
  assert(typeof v.attrs.crs_wkt === 'string', 'crs_wkt missing from attrs');
  assert(/WGS\s*84/.test(v.attrs.crs_wkt), 'crs_wkt content unexpected: ' + v.attrs.crs_wkt);
});

await test('extract(lat=35°N, lon=-95°W, t=0) → 4.0 (center cell)', async () => {
  const r = await extract(zipBytes, {
    ...wf,
    variable: 'temperature',
    lat: 35.0, lon: -95.0,
    t1: 0, t2: 0,
  });
  const v = pickScalar(r);
  assert(v != null, 'no scalar value found in extract() result: ' + JSON.stringify(r).slice(0, 300));
  assertClose(v, 4.0, 1e-4, 'temperature at (35°N, 95°W, t=0)');
});

await test('extractGrid() interprets bbox in real degrees (not indices)', async () => {
  const g = await extractGrid(zipBytes, {
    ...wf,
    variable: 'temperature',
    bbox:    [-100, 30, -90, 40],
    width:   3, height: 3,
    time:    0,
    workers: 0,
  });
  assert(g.data instanceof Float32Array, 'data is not Float32Array');
  assert(g.data.length === 9, 'expected 9 cells, got ' + g.data.length);
  assert(g.width === 3 && g.height === 3, 'dims wrong');
  /* row 0 is at maxLat=40 (north-up); cell centers sample lat 38.33, 35.0, 31.67
   * which nearest-pick lats 40, 35, 30 → source rows 2, 1, 0.
   * Likewise lons -98.33, -95.0, -91.67 → cols 0, 1, 2.
   * Expected grid:
   *   row 0 (lat≈40): 6, 7, 8
   *   row 1 (lat≈35): 3, 4, 5
   *   row 2 (lat≈30): 0, 1, 2
   */
  assertClose(g.data[0], 6.0, 1e-3, 'cell[0,0] (≈40N,100W)');
  assertClose(g.data[4], 4.0, 1e-3, 'cell[1,1] center (≈35N,95W)');
  assertClose(g.data[8], 2.0, 1e-3, 'cell[2,2] (≈30N,90W)');
});

/* ---- Parity with grib2/nc3: ensure zarr goes through the same _extractArrays
 *      → worker-pool → output pipeline, with identical results regardless of
 *      worker count and identical serialiser support. ---- */

let referenceGrid;
await test('extractGrid workers: 1 matches workers: 0 (worker path works for zarr)', async () => {
  const g0 = await extractGrid(zipBytes, {
    ...wf, variable: 'temperature',
    bbox: [-100, 30, -90, 40], width: 3, height: 3, time: 0, workers: 0,
  });
  const g1 = await extractGrid(zipBytes, {
    ...wf, variable: 'temperature',
    bbox: [-100, 30, -90, 40], width: 3, height: 3, time: 0, workers: 1,
  });
  referenceGrid = g0.data;
  assert(g0.data.length === g1.data.length, 'lengths differ');
  for (let i = 0; i < g0.data.length; i++) {
    const a = g0.data[i], b = g1.data[i];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    assertClose(a, b, 1e-6, `cell[${i}] inline vs workers:1`);
  }
});

await test('gridToJSON round-trips a zarr-sourced grid', async () => {
  const g = await extractGrid(zipBytes, {
    ...wf, variable: 'temperature',
    bbox: [-100, 30, -90, 40], width: 3, height: 3, time: 0, workers: 0,
  });
  const json   = gridToJSON(g);
  const parsed = JSON.parse(json);
  assert(parsed.variable === 'temperature', 'variable mismatch: ' + parsed.variable);
  assert(parsed.width === 3 && parsed.height === 3, 'dims mismatch');
  assert(Array.isArray(parsed.bbox) && parsed.bbox.length === 4, 'bbox not [4]');
  assert(Array.isArray(parsed.data) && parsed.data.length === 9, 'data length != 9');
  for (let i = 0; i < parsed.data.length; i++) {
    const v = parsed.data[i];
    assert(v === null || typeof v === 'number', `data[${i}] not number/null: ${v}`);
  }
});

await test('gridToGeoTIFF emits valid TIFF magic for zarr-sourced grid', async () => {
  const g   = await extractGrid(zipBytes, {
    ...wf, variable: 'temperature',
    bbox: [-100, 30, -90, 40], width: 3, height: 3, time: 0, workers: 0,
  });
  const buf = gridToGeoTIFF(g);
  assert(buf instanceof Uint8Array, 'output is not Uint8Array');
  /* TIFF magic: little-endian 'II' + 42 */
  assert(buf[0] === 0x49 && buf[1] === 0x49, 'missing II header');
  assert(buf[2] === 42   && buf[3] === 0,    'missing TIFF magic 42');
});

await test('extractGridOutput("json") returns a JSON string for zarr', async () => {
  const s = await extractGridOutput(zipBytes, {
    ...wf, variable: 'temperature',
    bbox: [-100, 30, -90, 40], width: 3, height: 3, time: 0, workers: 0,
  }, 'json');
  assert(typeof s === 'string', 'not a string');
  const obj = JSON.parse(s);
  assert(obj.width === 3 && obj.height === 3, 'dims');
});

await test('extractGrid() without coord arrays falls back to synthetic axes', async () => {
  const bareZip = buildFixture({ withCoords: false, withCrs: false });
  const bareMeta = await scan(bareZip, wf);
  const v = bareMeta.variables.find(x => x.name === 'temperature');
  assert(v, 'no temperature in bare scan');
  assert(v.coord_source === 'synthetic',
    'expected coord_source=synthetic, got: ' + v.coord_source);
  assert(Array.isArray(v.warnings) && v.warnings.length > 0,
    'expected warnings to be a non-empty array');
  assert(v.warnings.some(w => /synthetic/i.test(w)),
    'expected synthetic-axis warning, got: ' + JSON.stringify(v.warnings));
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
