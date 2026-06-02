/*
 * demoNetcdf4File.js — end-to-end demo of the webparsers library against a
 * NetCDF4 / HDF5 file.  Mirrors demoGrib2File.js / demoNetcdf3File.js.
 *
 * NetCDF4 support uses h5wasm under the hood; the first call lazy-loads it
 * (Node 18+ can fetch from the CDN out of the box).  CF coordinate hookup
 * means lat/lon queries land on real grid cells — adjust REF_LAT / REF_LON
 * to a point inside your fixture's grid.
 *
 * Run:
 *   npm run demo:netcdf4
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, extract } from '../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '../..');


/* ---- Pick the fixture --------------------------------------------------
 * Drop your NetCDF4/HDF5 file (.nc / .nc4) into examples/netcdf/ and set
 * the filename here.
 * ---------------------------------------------------------------------- */
const FIXTURE_PATH = 'examples/netcdf/nws_precip_last24hours_conus.nc'; // TODO: set to your <fixture>.nc

/* ---- Reference point (change to match your fixture's coverage) ------- */
const REF_LAT = 0;   // TODO: pick a lat inside your grid
const REF_LON = 0;   // TODO: pick a lon inside your grid

const file = new Uint8Array(readFileSync(resolve(root, FIXTURE_PATH)));

console.log('--- SCAN ---');
const meta = await scan(file);
console.log(JSON.stringify(meta, null, 2));

const v = meta.variables.find(x => x.supported);
if (!v) {
  console.log('\nNo supported variables in this NetCDF4 file.');
} else {
  console.log(`\n--- EXTRACT '${v.name}' values [0..20] @ (lat=${REF_LAT}, lon=${REF_LON}) ---`);
  const result = await extract(file, {
    variable: v.name,
    lat: REF_LAT, lon: REF_LON,
    t1: 0, t2: 20,
  });
  console.log(JSON.stringify(result, null, 2));
}
