#!/usr/bin/env node
/* Public-API value validation for polar-stereographic extract vs eccodes oracle.
 * Standalone (not in `npm test`). */
import { readFileSync } from 'node:fs';
import { SciWridToolkit } from '../lib/sciwrid-lib.js';

const FILE = process.env.GRIB2_POLAR_FILE || 'E:/grib2/stage4_50mb.grib2';
const REF  = process.env.GRIB2_POLAR_REF  ||
  'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks/pybench/stage4_polar_ref.json';

const ref = JSON.parse(readFileSync(REF, 'utf8'));
const kit = new SciWridToolkit();
await kit.read(new Uint8Array(readFileSync(FILE)));
const v = kit.vars.find(x => x.supported) || kit.vars[0];

let failed = 0;
for (const p of ref.points) {
  const out = await kit.extract({ variable: v.name, lat: p.queryLat, lon: p.queryLon });
  const series = out.timeseries || (out.variables && out.variables[0].timeseries);
  const got = series && series.length ? series[0].value : null;
  const exp = p.value;
  const ok = (exp == null && got == null) ||
             (exp != null && got != null && Math.abs(got - exp) <= 1e-3 * Math.max(1, Math.abs(exp)));
  console[ok ? 'log' : 'error'](`${ok ? 'ok  ' : 'FAIL'} (${p.queryLat.toFixed(2)},${p.queryLon.toFixed(2)}) got=${got} exp=${exp}`);
  if (!ok) failed++;
}
kit.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
