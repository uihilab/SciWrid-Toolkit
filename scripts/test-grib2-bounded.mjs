#!/usr/bin/env node
/* Bounded GRIB2 extraction: metadata pass, point-reduce, windowed decode.
 * Standalone. GRIB2_POLAR_FILE default E:/grib2/stage4_50mb.grib2. */
import { readFileSync } from 'node:fs';
import { SciWridToolkit } from '../lib/sciwrid-lib.js';

const FILE = process.env.GRIB2_POLAR_FILE || 'E:/grib2/stage4_50mb.grib2';
const REF  = process.env.GRIB2_POLAR_REF ||
  'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks/pybench/stage4_polar_ref.json';
const ref = JSON.parse(readFileSync(REF, 'utf8'));

let failed = 0;
const ok = (c, m) => { console[c ? 'log' : 'error'](`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failed++; };

const kit = new SciWridToolkit();
await kit.read(new Uint8Array(readFileSync(FILE)));
const w = kit.wasm;
const v = kit.vars.find(x => x.supported) || kit.vars[0];

// metadata pass: nt + curvilinear + nearest work with data = NULL
const meta = w.ccall('wp_grid_coords', 'number', ['number','number'], [kit.scanPtr, v.index]);
ok(meta !== 0, 'wp_grid_coords non-null');
const nt = w.ccall('wp_nt', 'number', ['number'], [meta]);
ok(nt > 0, `meta nt=${nt}`);
const nx = w.ccall('wp_nx', 'number', ['number'], [meta]);
ok(w.ccall('wp_is_curvilinear','number',['number'],[meta]) === 1, 'meta curvilinear');

// point-reduce for a wet oracle point -> matches eccodes value at timestep 0
const p = ref.points.find(q => q.value && q.value > 0.01);
const flat = w.ccall('wp_find_nearest_cell','number',['number','number','number'],[meta, p.queryLat, p.queryLon]);
const iy = Math.floor(flat / nx), ix = flat % nx;
w.ccall('wp_close', null, ['number'], [meta]);

const ds = w.ccall('wp_normalize_range','number',
  ['number','number','number','number','number','number'], [kit.scanPtr, v.index, 0, 0, iy, ix]);
ok(ds !== 0, 'point-reduce ds non-null');
ok(w.ccall('wp_nt','number',['number'],[ds]) === 1, 'point-reduce nt=1');
ok(w.ccall('wp_nx','number',['number'],[ds]) === 1, 'point-reduce nx=1');
const rptr = w.ccall('wp_query','number',['number','number','number','number','number'],[ds,0,0,0,0]);
const series = JSON.parse(w.UTF8ToString(rptr)); w.ccall('wp_free',null,['number'],[rptr]);
const got = series.timeseries[0].value;
ok(Math.abs(got - p.value) <= 1e-3, `point-reduce value ${got} ≈ ${p.value}`);
w.ccall('wp_close', null, ['number'], [ds]);
kit.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
