import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, extract, extractOutput } from '../../wasm/webparsers-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const file = new Uint8Array(readFileSync(resolve(root, 'examples/timeseries/icon_global_icosahedral_single-level_2026050800_003_T_2M.grib2')));

console.log('--- SCAN ---');
const meta = await scan(file);
console.log(JSON.stringify(meta, null, 2));

console.log('\n--- EXTRACT (Berlin: 52.52, 13.40) ---');
const v = meta.variables.find(x => x.supported).name;
const point = await extract(file, { variable: v, lat: 52.52, lon: 13.40 });
console.log(JSON.stringify(point, null, 2));

// console.log('\n--- CSV ---');
// console.log(await extractOutput(file, { variable: v, lat: 52.52, lon: 13.40 }, 'csv'));

// const json = await extractOutput(file, { variable: ['Pressure', 'Cloud ice'], t1: 0, t2: 1 }, 'json');
// const outputPath = resolve(root, 'examples/testfile/test.json');
// writeFileSync(outputPath, json);
// console.log(`Wrote ${outputPath}`);
