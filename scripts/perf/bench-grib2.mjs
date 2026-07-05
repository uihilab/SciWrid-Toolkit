#!/usr/bin/env node
/* Whole-file "before" baseline for the Stage IV GRIB2 ladder: decode the full
 * file and extract one CONUS point; record wall time + bytes read per rung.
 * The current path decodes every message (all timesteps), so large rungs may
 * exceed the 32-bit WASM heap — that ceiling is recorded, and is itself the
 * motivation for the range-native follow-up. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { SciWridToolkit } from '../../lib/sciwrid-lib.js';

const DIR = process.env.GRIB2_DIR || 'E:/grib2';
const RUNGS = ['stage4_50mb', 'stage4_100mb', 'stage4_200mb', 'stage4_500mb', 'stage4_1gb', 'stage4_2gb'];
const LAT = 39.0, LON = -96.0;   // interior CONUS

const rows = [];
for (const name of RUNGS) {
  const file = `${DIR}/${name}.grib2`;
  let size; try { size = statSync(file).size; } catch { console.warn('skip', name); continue; }
  const bytes = new Uint8Array(readFileSync(file));   // whole-file read = bytes transferred
  const t0 = performance.now();
  let ok = false, err = null;
  const kit = new SciWridToolkit();
  try {
    await kit.read(bytes);
    const v = kit.vars.find(x => x.supported) || kit.vars[0];
    await kit.extract({ variable: v.name, lat: LAT, lon: LON });
    ok = true;
  } catch (e) { err = String(e.message || e); }
  const ms = performance.now() - t0;
  try { kit.close(); } catch {}
  rows.push({ name, size, transferred: size, timeMs: Math.round(ms), ok, err });
  console.log(`${name.padEnd(16)} ${(size/1e6).toFixed(0).padStart(5)} MB  ${ok ? Math.round(ms)+' ms' : 'FAILED: '+err}  (100% transferred)`);
}
const out = `${DIR}/bench-grib2-before.json`;
writeFileSync(out, JSON.stringify({ mode: 'whole-file', lat: LAT, lon: LON, rows }, null, 2));
console.log('wrote', out);
