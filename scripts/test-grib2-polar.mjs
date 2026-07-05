#!/usr/bin/env node
/* Low-level validation of template-20 decode + 2D nearest, vs the eccodes oracle.
 * Standalone (not in `npm test`). Reads GRIB2_POLAR_FILE (default E:/grib2/stage4_50mb.grib2)
 * and the oracle stage4_polar_ref.json. */
import { readFileSync } from 'node:fs';
import { SciWridToolkit } from '../lib/sciwrid-lib.js';

const FILE = process.env.GRIB2_POLAR_FILE || 'E:/grib2/stage4_50mb.grib2';
const REF  = process.env.GRIB2_POLAR_REF  ||
  'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks/pybench/stage4_polar_ref.json';

let failed = 0;
const approx = (a, b, tol, msg) => {
  if (a == null || b == null || Math.abs(a - b) > tol) { console.error(`FAIL ${msg}: ${a} vs ${b}`); failed++; }
  else console.log(`ok   ${msg}: ${a} ≈ ${b}`);
};

const ref = JSON.parse(readFileSync(REF, 'utf8'));
const kit = new SciWridToolkit();
await kit.read(new Uint8Array(readFileSync(FILE)));
const wasm = kit.wasm;
const v = kit.vars.find(x => x.supported) || kit.vars[0];
const ds = wasm.ccall('wp_normalize', 'number', ['number', 'number'], [kit.scanPtr, v.index]);
if (!ds) { console.error('FAIL wp_normalize returned NULL'); kit.close(); console.log('\n1 FAILED'); process.exit(1); }

const nx = wasm.ccall('wp_nx', 'number', ['number'], [ds]);
const ny = wasm.ccall('wp_ny', 'number', ['number'], [ds]);
approx(nx, ref.nx, 0, 'nx');
approx(ny, ref.ny, 0, 'ny');
approx(wasm.ccall('wp_is_curvilinear', 'number', ['number'], [ds]), 1, 0, 'is_curvilinear');

// Corner coordinates (order-robust) vs oracle.
for (const c of ref.corners) {
  const iy = Math.floor(c.index / ref.nx), ix = c.index % ref.nx;
  approx(wasm.ccall('wp_cell_lat', 'number', ['number','number','number'], [ds, iy, ix]), c.lat, 0.02, `corner${c.index} lat`);
  approx(wasm.ccall('wp_cell_lon', 'number', ['number','number','number'], [ds, iy, ix]), c.lon, 0.02, `corner${c.index} lon`);
}

// 2D nearest cell → its coord should match the eccodes cell coord for each query point.
for (const p of ref.points) {
  const flat = wasm.ccall('wp_find_nearest_cell', 'number', ['number','number','number'], [ds, p.queryLat, p.queryLon]);
  const iy = Math.floor(flat / nx), ix = flat % nx;
  approx(wasm.ccall('wp_cell_lat', 'number', ['number','number','number'], [ds, iy, ix]), p.cellLat, 0.02, `nearest(${p.queryLat.toFixed(2)},${p.queryLon.toFixed(2)}) lat`);
  approx(wasm.ccall('wp_cell_lon', 'number', ['number','number','number'], [ds, iy, ix]), p.cellLon, 0.02, `nearest lon`);
}

wasm.ccall('wp_close', null, ['number'], [ds]);
kit.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
