#!/usr/bin/env node
/* Whole-file vs range-native on the Stage IV ladder, same point.
 * - whole-file: read(bytes) + extract point  (loads the whole file -> OOMs big)
 * - range:      grib2RangePointExtract over a local file-backed Range server
 * Writes bench-grib2-compare.json for plotting. */
import http from 'node:http';
import { createReadStream, statSync, readFileSync, writeFileSync } from 'node:fs';
import { grib2RangePointExtract } from '../../lib/grib2/grib2-range.js';
import { SciWridToolkit } from '../../lib/sciwrid-lib.js';

const DIR = process.env.GRIB2_DIR || 'E:/grib2';
const RUNGS = ['stage4_50mb', 'stage4_100mb', 'stage4_200mb', 'stage4_500mb',
               'stage4_1gb', 'stage4_1500mb', 'stage4_2gb'];
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

// resolve the variable name from the smallest rung
const k0 = new SciWridToolkit();
await k0.read(new Uint8Array(readFileSync(`${DIR}/stage4_50mb.grib2`)));
const vname = (k0.vars.find(x => x.supported) || k0.vars[0]).name; k0.close();

const rows = [];
for (const name of RUNGS) {
  const file = `${DIR}/${name}.grib2`;
  let size; try { size = statSync(file).size; } catch { continue; }

  // whole-file point extract (loads the whole file)
  let whole = { ok: false, timeMs: 0, transferred: size };
  try {
    const t0 = performance.now();
    const kit = new SciWridToolkit();
    await kit.read(new Uint8Array(readFileSync(file)));
    await kit.extract({ variable: vname, lat: LAT, lon: LON, t1: 0, t2: 0 });
    whole = { ok: true, timeMs: Math.round(performance.now() - t0), transferred: size };
    kit.close();
  } catch (e) { whole = { ok: false, timeMs: 0, transferred: size, err: String(e.message || e) }; }

  // range-native single-time (serves the file, fetches only what it needs)
  let range = { ok: false, timeMs: 0, transferred: 0 };
  const { s, port } = await serve(file);
  try {
    const t0 = performance.now();
    const out = await grib2RangePointExtract(`http://127.0.0.1:${port}/${name}`,
      { variable: vname, lat: LAT, lon: LON, t1: 0, t2: 0 });
    range = { ok: !!out, timeMs: Math.round(performance.now() - t0), transferred: out ? out._stats.bytes : 0 };
  } catch (e) { range = { ok: false, timeMs: 0, transferred: 0, err: String(e.message || e) }; }
  finally { s.close(); }

  rows.push({ name, size, whole, range });
  console.log(`${name.padEnd(16)} ${(size / 1e6).toFixed(0).padStart(5)} MB | ` +
    `whole ${whole.ok ? whole.timeMs + 'ms' : 'OOM'.padEnd(6)} | ` +
    `range ${range.timeMs}ms pulled ${(range.transferred / 1e6).toFixed(2)}MB (${(100 * range.transferred / size).toFixed(2)}%)`);
}
writeFileSync(`${DIR}/bench-grib2-compare.json`, JSON.stringify({ lat: LAT, lon: LON, rows }, null, 2));
console.log('wrote', `${DIR}/bench-grib2-compare.json`);
