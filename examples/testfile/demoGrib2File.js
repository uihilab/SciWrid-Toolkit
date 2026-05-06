import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, extract, extractOutput } from '../../wasm/webparsers-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

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

const file = new Uint8Array(readFileSync(resolve(root, 'examples/timeseries/gfs_timeseries.grb2')));

// console.log('--- SCAN ---');
// const meta = await scan(file, wf);
// console.log(JSON.stringify(meta, null, 2));

// console.log('\n--- EXTRACT (Berlin: 52.52, 13.40) ---');
// const v = meta.variables.find(x => x.supported).name;
// const point = await extract(file, { ...wf, variable: v, lat: 52.52, lon: 13.40 });
// console.log(JSON.stringify(point, null, 2));

// console.log('\n--- CSV ---');
// console.log(await extractOutput(file, { ...wf, variable: v, lat: 52.52, lon: 13.40 }, 'csv'));

const json = await extractOutput(file, { ...wf, variable: ['Pressure', 'Cloud ice'], t1: 0, t2: 1 }, 'json');
const outputPath = resolve(root, 'examples/testfile/test.json');
writeFileSync(outputPath, json);
console.log(`Wrote ${outputPath}`);
