#!/usr/bin/env node
/* Range-native vs whole-file on the Stage IV ladder, served over a local
 * file-backed Range server. Reports transfer % and wall time for a single-time
 * point query. */
import http from 'node:http';
import { createReadStream, statSync, readFileSync, writeFileSync } from 'node:fs';
import { grib2RangePointExtract } from '../../lib/grib2/grib2-range.js';
import { SciWridToolkit } from '../../lib/sciwrid-lib.js';

const DIR = process.env.GRIB2_DIR || 'E:/grib2';
const RUNGS = ['stage4_50mb', 'stage4_200mb', 'stage4_500mb', 'stage4_1gb', 'stage4_1500mb'];
const LAT = 38.46, LON = -118.95;

function serve(file) {
  const size = statSync(file).size;
  const s = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' }); createReadStream(file).pipe(res); return; }
    const a = +m[1], b = Math.min(+m[2], size - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start: a, end: b }).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port, size })));
}

const rows = [];
const kit = new SciWridToolkit();
await kit.read(new Uint8Array(readFileSync(`${DIR}/stage4_50mb.grib2`)));
const vname = (kit.vars.find(x => x.supported) || kit.vars[0]).name; kit.close();

for (const name of RUNGS) {
  const file = `${DIR}/${name}.grib2`;
  let size; try { size = statSync(file).size; } catch { continue; }
  const { s, port } = await serve(file);
  try {
    const t0 = performance.now();
    const out = await grib2RangePointExtract(`http://127.0.0.1:${port}/${name}`,
      { variable: vname, lat: LAT, lon: LON, t1: 0, t2: 0 });
    const ms = performance.now() - t0;
    const pulled = out ? out._stats.bytes : 0;
    rows.push({ name, size, transferred: pulled, timeMs: Math.round(ms), ok: !!out });
    console.log(`${name.padEnd(16)} ${(size/1e6).toFixed(0).padStart(5)} MB  pulled ${(pulled/1e6).toFixed(2)} MB (${(100*pulled/size).toFixed(2)}%)  ${Math.round(ms)} ms`);
  } catch (e) { console.log(`${name} FAILED ${e.message}`); }
  finally { s.close(); }
}
writeFileSync(`${DIR}/bench-grib2-range.json`, JSON.stringify({ mode: 'range-single-time', lat: LAT, lon: LON, rows }, null, 2));
console.log('wrote', `${DIR}/bench-grib2-range.json`);
