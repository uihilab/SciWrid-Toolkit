/*
 * demoNetcdf3File.js — end-to-end demo of the webparsers library against a
 * NetCDF3 Classic file.  Mirrors demoGrib2File.js / demoZarrFile.js so you
 * can compare how the same `scan` / `extract` calls drive every format.
 *
 * Unlike Zarr (synthetic axes), NetCDF3 has real lat/lon/time coordinates,
 * so geographic queries land on actual grid cells.  Adjust REF_LAT / REF_LON
 * to a point inside your fixture's grid.
 *
 * Run:
 *   npm run demo:netcdf3
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, extract } from '../../wasm/webparsers-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '../..');

/* ---- Bootstrap the WASM factory the same way demoGrib2File.js does ---- */
function loadWasmFactory() {
  const code = readFileSync(resolve(root, 'wasm/webparsers.js'), 'utf8');
  const fakeModule = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
  const factory = fakeModule.exports?.default ?? fakeModule.exports;
  if (typeof factory !== 'function') {
    throw new Error('Could not extract WebParsers factory from webparsers.js');
  }
  return factory;
}

const rawFactory = loadWasmFactory();
const wasmBinary = readFileSync(resolve(root, 'wasm/webparsers.wasm'));
const wf = { wasmFactory: () => rawFactory({ wasmBinary }) };

/* ---- Pick the fixture --------------------------------------------------
 * Drop your NetCDF3 (.nc / .nc3) file into examples/netcdf/ and set the
 * filename here.
 * ---------------------------------------------------------------------- */
const FIXTURE_PATH = 'examples/netcdf/'; // TODO: set to your <fixture>.nc3

/* ---- Reference point (change to match your fixture's coverage) ------- */
const REF_LAT = 0;   // TODO: pick a lat inside your grid
const REF_LON = 0;   // TODO: pick a lon inside your grid

const file = new Uint8Array(readFileSync(resolve(root, FIXTURE_PATH)));

console.log('--- SCAN ---');
const meta = await scan(file, wf);
console.log(JSON.stringify(meta, null, 2));

const v = meta.variables.find(x => x.supported);
if (!v) {
  console.log('\nNo supported variables in this NetCDF3 file.');
} else {
  console.log(`\n--- EXTRACT '${v.name}' values [0..20] @ (lat=${REF_LAT}, lon=${REF_LON}) ---`);
  const result = await extract(file, {
    ...wf,
    variable: v.name,
    lat: REF_LAT, lon: REF_LON,
    t1: 0, t2: 20,
  });
  console.log(JSON.stringify(result, null, 2));
}
