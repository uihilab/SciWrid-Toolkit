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
} from '../wasm/webparsers-api.js';

/* The Emscripten module is built with MODULARIZE=1 + EXPORT_ES6=1, so it's a
 * real ES module that uses import.meta.url to resolve the .wasm. Import it
 * directly — no CJS-eval shim needed. */
import WebParsers from '../wasm/webparsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

const wasmBinary  = readFileSync(resolve(root, 'wasm/webparsers.wasm'));
const wasmFactory = () => WebParsers({ wasmBinary });
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

/* ---- Fixtures --------------------------------------------------------- */
const FIXTURES = [
  { format: 'grib2',   name: 'GRIB2 (CONUS)',  path: 'examples/conus_20240202_24h.grb2' },
  { format: 'grib2',   name: 'GRIB2 (ICON unstructured)', path: 'examples/icon_global_icosahedral_single-level_2025121900_000_T_2M.grib2' },
  { format: 'netcdf3', name: 'NetCDF3', path: 'examples/sample.nc3' },
  { format: 'netcdf4', name: 'NetCDF4', path: 'examples/sample.nc'  },
];

console.log('webparsers/api smoke test\n');

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

/* ---- Summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
