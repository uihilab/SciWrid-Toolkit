#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as pq from '../../lib/parquet-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parquetDir = resolve(__dirname, 'parquet');
const read = (name) => new Uint8Array(readFileSync(resolve(parquetDir, name)));

for (const name of ['mesh.parquet', 'scatter.parquet']) {
  const buf = read(name);
  const scan = await pq.scan(buf);
  try {
    console.log(name, pq.scanGetVarsJson(scan));
    const g = await pq.extractGrid(buf, { variable: 'v', bbox: pq.geoBbox(scan), width: 4, height: 3, t: 0 });
    console.log('grid', g.width + 'x' + g.height, Array.from(g.data.slice(0, 6)));
  } finally {
    await pq.scanFree(scan);
  }
}
