/*
 * demoZarrFile.js — end-to-end demo of the webparsers library against a
 * Zarr v2 (zip) file.  Mirrors demoGrib2File.js so you can compare how the
 * same `scan` / `extract` / `extractOutput` calls drive both formats.
 *
 * Today's helper supports null / gzip / zlib compressors only.  Generate
 * fixtures with `compressor=Zlib()` (zarr-python) or `numcodecs.Zlib` —
 * blosc / zstd / lz4 will throw a clear "Unsupported Zarr compressor" error
 * until Sprint 5 lands the codec libs.
 *
 * Run:
 *   npm run demo:zarr
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, extract } from '../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '../..');


/* ---- Pick the fixture --------------------------------------------------
 * Drop your zlib-compressed Zarr-zip into examples/zarr/ and set the
 * filename here.  Leaving it empty will fail with a clear ENOENT.
 * ---------------------------------------------------------------------- */
const FIXTURE_PATH = 'examples/zarr/'; // TODO: set to your <fixture>.zip

const file = new Uint8Array(readFileSync(resolve(root, FIXTURE_PATH)));

console.log('--- SCAN ---');
const meta = await scan(file);
console.log(JSON.stringify(meta, null, 2));

/* ---- Extract first 21 values of the first supported variable ---------
 * Zarr today uses synthetic axes: lats[j]=j, lons[i]=i, times[t]=t*86400.
 * So passing lat=0, lon=0 lands on grid point (0, 0); t1=0..t2=20 walks
 * the first 21 timesteps.  If the fixture has nt < 21, the lib clamps
 * t2 to nt-1 and returns whatever's available.
 * ---------------------------------------------------------------------- */
const v = meta.variables.find(x => x.supported);
if (!v) {
  console.log('\nNo supported variables in this Zarr.');
} else {
  console.log(`\n--- EXTRACT '${v.name}' values [0..20] @ (j=0, i=0) ---`);
  const result = await extract(file, {
    variable: v.name,
    lat: 0, lon: 0,
    t1: 0, t2: 20,
  });
  console.log(JSON.stringify(result, null, 2));
}
