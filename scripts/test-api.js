#!/usr/bin/env node
/**
 * scripts/test-api.js — smoke test for the functional API (Sprint 3).
 *
 * Run from repo root:
 *   node scripts/test-api.js
 *
 * Exercises detectFormat / scan / extract / extractOutput on whatever
 * fixtures exist under examples/. Missing fixtures are skipped, not failed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  detectFormat,
  scan,
  extract,
  extractOutput,
  UnsupportedFormatError,
} from '../lib/sciwrid-api.js';

/* The Emscripten module is built with MODULARIZE=1 + EXPORT_ES6=1, so it's a
 * real ES module that uses import.meta.url to resolve the .wasm. Import it
 * directly — no CJS-eval shim needed. */
import SciWridToolkit from '../wasm/sciwrid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

const wasmBinary  = readFileSync(resolve(root, 'wasm/sciwrid.wasm'));
const wasmFactory = () => SciWridToolkit({ wasmBinary });
const wf = { wasmFactory };

/* ---- Tiny test runner ------------------------------------------------- */
let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const res = await fn();
    if (res === 'skip') { skipped++; console.log('SKIP'); }
    else                { passed++;  console.log('OK');   }
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.error('    →', e.stack || e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function buildNC4Fixture() {
  let h5mod;
  try { h5mod = await import('h5wasm'); }
  catch (_) { return null; }
  const h5 = h5mod.default ?? h5mod;
  const { FS } = await h5.ready;

  const fname = `_api_nc4_${Date.now()}.nc`;
  const NT = 5, NY = 3, NX = 4;
  const f = new h5.File(fname, 'w');

  const tas = new Float32Array(NT * NY * NX);
  for (let t = 0; t < NT; t++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++)
        tas[t * NY * NX + y * NX + x] = 100 + t * 100 + y * 10 + x;
  const ds = f.create_dataset({ name: 'tas', data: tas, shape: [NT, NY, NX], dtype: '<f4' });
  ds.create_attribute('units', 'K');

  const time = new Float64Array(NT);
  for (let i = 0; i < NT; i++) time[i] = i * 3600;
  const tds = f.create_dataset({ name: 'time', data: time, shape: [NT], dtype: '<f8' });
  tds.create_attribute('units', 'seconds since 2025-01-01');

  const lat = new Float32Array([30, 35, 40]);
  const lon = new Float32Array([-100, -95, -90, -85]);
  f.create_dataset({ name: 'lat', data: lat, shape: [NY], dtype: '<f4' });
  f.create_dataset({ name: 'lon', data: lon, shape: [NX], dtype: '<f4' });

  f.flush(); f.close();
  const bytes = new Uint8Array(FS.readFile(fname));
  FS.unlink(fname);
  return { bytes, h5 };
}

/* ---- Fixtures --------------------------------------------------------- */
const FIXTURES = [
  { format: 'grib2',   name: 'GRIB2 (CONUS)',  path: 'examples/conus_20240202_24h.grb2' },
  { format: 'grib2',   name: 'GRIB2 (ICON unstructured)', path: 'examples/icon_global_icosahedral_single-level_2025121900_000_T_2M.grib2' },
  { format: 'netcdf3', name: 'NetCDF3', path: 'examples/sample.nc3' },
  { format: 'netcdf4', name: 'NetCDF4', path: 'examples/sample.nc'  },
];

console.log('sciwrid-toolkit/api smoke test\n');

for (const fx of FIXTURES) {
  const abs = resolve(root, fx.path);
  console.log(`[${fx.format}] ${fx.name}  (${fx.path})`);
  if (!existsSync(abs)) {
    console.log('  fixture not present, skipping all checks for this format\n');
    skipped += 4;
    continue;
  }

  const bytes = new Uint8Array(readFileSync(abs));

  await test('detectFormat returns expected format', async () => {
    const f = await detectFormat(bytes);
    assert(f === fx.format, `expected ${fx.format}, got ${f}`);
  });

  let supportedVar;
  await test('scan returns metadata + variables', async () => {
    const meta = await scan(bytes, wf);
    assert(meta.format === fx.format, `format mismatch: ${meta.format}`);
    assert(Array.isArray(meta.variables) && meta.variables.length > 0, 'no variables');
    assert(typeof meta.total_variables === 'number', 'total_variables missing');
    supportedVar = meta.variables.find(v => v.supported)?.name;
  });

  await test('extract returns a result', async () => {
    if (!supportedVar) return 'skip';
    const result = await extract(bytes, { ...wf, variable: supportedVar });
    assert(result, 'no result returned');
    assert(typeof result === 'object', 'result not an object');
  });

  await test('extractOutput("csv") returns CSV string', async () => {
    if (!supportedVar) return 'skip';
    const csv = await extractOutput(bytes, { ...wf, variable: supportedVar }, 'csv');
    assert(typeof csv === 'string', 'csv not a string');
    assert(csv.startsWith('variable,'), `csv missing header: ${csv.slice(0, 60)}`);
  });

  console.log('');
}

/* ---- Error-path tests (don't require fixtures) ------------------------ */
console.log('[errors]');

await test('UnsupportedFormatError on garbage bytes', async () => {
  const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  try { await scan(junk, wf); }
  catch (e) {
    assert(e instanceof UnsupportedFormatError, `wrong error type: ${e.constructor.name}`);
    return;
  }
  throw new Error('expected UnsupportedFormatError');
});

await test('detectFormat returns null on garbage', async () => {
  const f = await detectFormat(new Uint8Array([0, 1, 2, 3]));
  assert(f === null, `expected null, got ${f}`);
});

console.log('\n[netcdf4 native slices]');

await test('NetCDF4 extract uses h5wasm hyperslabs for requested time range', async () => {
  const fx = await buildNC4Fixture();
  if (!fx) return 'skip';

  const calls = [];
  const proto = fx.h5.Dataset.prototype;
  const original = proto.slice;
  proto.slice = function(ranges) {
    calls.push({ path: this.path, ranges: JSON.parse(JSON.stringify(ranges)) });
    return original.call(this, ranges);
  };
  try {
    const result = await extract(fx.bytes, { ...wf, variable: 'tas', lat: 35, lon: -95, t1: 1, t2: 2 });
    const vals = result.timeseries.map((p) => p.value);
    assert(JSON.stringify(vals) === '[211,311]', 'expected [211,311], got ' + JSON.stringify(vals));
  } finally {
    proto.slice = original;
  }

  const tasCall = calls.find((c) => c.path === '/tas');
  const timeCall = calls.find((c) => c.path === '/time');
  assert(tasCall, 'expected tas slice call');
  assert(timeCall, 'expected time slice call');
  assert(JSON.stringify(tasCall.ranges[0]) === '[1,3]',
    'expected tas time range [1,3], got ' + JSON.stringify(tasCall.ranges));
  assert(JSON.stringify(timeCall.ranges[0]) === '[1,3]',
    'expected time range [1,3], got ' + JSON.stringify(timeCall.ranges));
});

/* ---- Summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
