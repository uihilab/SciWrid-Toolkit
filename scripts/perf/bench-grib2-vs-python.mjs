#!/usr/bin/env node
/* webparsers point-timeseries extraction across the Stage IV ladder, for the
 * webparsers-vs-Python comparison. Measures, per rung:
 *   - whole-file (bounded) full-timeseries: read(bytes)+extract  (OOMs big files)
 *   - range-native full-timeseries: grib2RangePointExtract       (streams, works big)
 *   - range-native single-time: transfer % (the range sweet spot)
 * Writes bench-grib2-wp.json. Python eccodes numbers come from
 * pybench/bench_grib2_eccodes.py (bench-grib2-eccodes.json). */
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

const k0 = new SciWridToolkit();
await k0.read(new Uint8Array(readFileSync(`${DIR}/stage4_50mb.grib2`)));
const vname = (k0.vars.find(x => x.supported) || k0.vars[0]).name; k0.close();

const rows = [];
for (const name of RUNGS) {
  const file = `${DIR}/${name}.grib2`;
  let size; try { size = statSync(file).size; } catch { continue; }

  // whole-file bounded, full timeseries
  let whole = { ok: false, timeMs: 0 };
  try {
    const t0 = performance.now();
    const kit = new SciWridToolkit();
    await kit.read(new Uint8Array(readFileSync(file)));
    const o = await kit.extract({ variable: vname, lat: LAT, lon: LON });
    const n = (o.timeseries || o.variables[0].timeseries).length;
    whole = { ok: true, timeMs: Math.round(performance.now() - t0), steps: n };
    kit.close();
  } catch (e) { whole = { ok: false, timeMs: 0, err: String(e.message || e) }; }

  // range-native, full timeseries + single time
  const { s, port } = await serve(file);
  let rangeFull = { ok: false, timeMs: 0 }, rangeOne = { ok: false, timeMs: 0, transferred: 0 };
  try {
    let t0 = performance.now();
    const full = await grib2RangePointExtract(`http://127.0.0.1:${port}/${name}`, { variable: vname, lat: LAT, lon: LON });
    rangeFull = { ok: !!full, timeMs: Math.round(performance.now() - t0), steps: full ? full.timeseries.length : 0 };
    t0 = performance.now();
    const one = await grib2RangePointExtract(`http://127.0.0.1:${port}/${name}`, { variable: vname, lat: LAT, lon: LON, t1: 0, t2: 0 });
    rangeOne = { ok: !!one, timeMs: Math.round(performance.now() - t0), transferred: one ? one._stats.bytes : 0 };
  } catch (e) { rangeFull.err = String(e.message || e); }
  finally { s.close(); }

  rows.push({ name, size, whole, rangeFull, rangeOne });
  console.log(`${name.padEnd(15)} ${(size/1e6).toFixed(0).padStart(5)}MB | whole ${whole.ok ? whole.timeMs+'ms' : 'OOM'} | rangeFull ${rangeFull.ok ? rangeFull.timeMs+'ms' : 'FAIL'} | range1 ${rangeOne.timeMs}ms ${(100*rangeOne.transferred/size).toFixed(2)}%`);
}
writeFileSync(`${DIR}/bench-grib2-wp.json`, JSON.stringify({ lat: LAT, lon: LON, rows }, null, 2));
console.log('wrote', `${DIR}/bench-grib2-wp.json`);
