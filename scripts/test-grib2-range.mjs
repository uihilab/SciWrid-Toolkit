#!/usr/bin/env node
/* Range-native GRIB2 tests. Standalone (not in `npm test`). Serves a real
 * Stage IV file over a file-backed Range server (no whole-file in memory). */
import http from 'node:http';
import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs';

const FILE = process.env.GRIB2_POLAR_FILE || 'E:/grib2/stage4_50mb.grib2';
const BIG  = process.env.GRIB2_BIG_FILE   || 'E:/grib2/stage4_1500mb.grib2';
const REF  = process.env.GRIB2_POLAR_REF  ||
  'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks/pybench/stage4_polar_ref.json';

let failed = 0;
const ok = (c, m) => { console[c ? 'log' : 'error'](`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failed++; };

export function startFileRangeServer(filePath) {
  const size = statSync(filePath).size;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (!range) { res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
                  createReadStream(filePath).pipe(res); return; }
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) { res.writeHead(416); res.end(); return; }
    const start = +m[1], end = Math.min(+m[2], size - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`,
                         'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    createReadStream(filePath, { start, end }).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1',
    () => r({ server, port: server.address().port, size })));
}

if (!existsSync(FILE)) { console.error('missing', FILE); process.exit(1); }

// Task 1: reader.size() + read() match the file.
{
  const { GrbRangeReader } = await import('../lib/grib2/grb-range-reader.js');
  const { server, port, size } = await startFileRangeServer(FILE);
  try {
    const r = new GrbRangeReader(`http://127.0.0.1:${port}/f.grib2`, { blockSize: 1 << 20 });
    ok(await r.size() === size, `reader.size() = ${size}`);
    const got = await r.read(0, 4);
    ok(got[0] === 0x47 && got[1] === 0x52 && got[2] === 0x49 && got[3] === 0x42, 'first bytes are "GRIB"');
    const mid = await r.read(1000, 8);
    const ref = readFileSync(FILE).subarray(1000, 1008);
    ok(Buffer.compare(Buffer.from(mid), ref) === 0, 'read(1000,8) matches file bytes');
    ok(r.stats().bytes > 0, `stats bytes=${r.stats().bytes}`);
  } finally { server.close(); }
}

// Task 2: index stage4_50mb.
{
  const { GrbRangeReader } = await import('../lib/grib2/grb-range-reader.js');
  const { indexMessages } = await import('../lib/grib2/grib2-index.js');
  const { server, port, size } = await startFileRangeServer(FILE);
  try {
    const r = new GrbRangeReader(`http://127.0.0.1:${port}/f.grib2`);
    const { messages, bytesRead } = await indexMessages(r);
    ok(messages.length === 173, `indexed ${messages.length} messages (expect 173)`);
    ok(messages.every(m => m.cat === messages[0].cat && m.num === messages[0].num),
       'single variable (uniform cat/num)');
    const last = messages[messages.length - 1];
    ok(last.offset + last.length === size, 'offsets + lengths tile the file exactly');
    ok(messages.every(m => m.time > 0), 'times parsed (unix seconds) for every message');
    ok(bytesRead < size * 0.05, `index pulled ${(100 * bytesRead / size).toFixed(2)}% of file (headers only)`);
  } finally { server.close(); }
}

// Task 3: single-time value matches oracle; time-range matches whole-file; transfer is tiny.
{
  const { grib2RangePointExtract } = await import('../lib/grib2/grib2-range.js');
  const { SciWridToolkit } = await import('../lib/sciwrid-lib.js');
  const ref = JSON.parse(readFileSync(REF, 'utf8'));
  const wet = ref.points.find(q => q.value && q.value > 0.01);

  const { server, port, size } = await startFileRangeServer(FILE);
  try {
    const url = `http://127.0.0.1:${port}/f.grib2`;
    const kit = new SciWridToolkit();
    await kit.read(new Uint8Array(readFileSync(FILE)));
    const vname = (kit.vars.find(x => x.supported) || kit.vars[0]).name;
    const whole = await kit.extract({ variable: vname, lat: wet.queryLat, lon: wet.queryLon });
    const wholeSeries = whole.timeseries || whole.variables[0].timeseries;

    const one = await grib2RangePointExtract(url, { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 });
    ok(one && one.timeseries.length === 1, 'single-time returns 1 step');
    ok(one && Math.abs(one.timeseries[0].value - wholeSeries[0].value) <= 1e-3,
       `single-time value ${one && one.timeseries[0].value} ≈ whole-file ${wholeSeries[0].value}`);
    ok(one && one._stats.bytes < size * 0.05, `single-time transfer ${one && (100 * one._stats.bytes / size).toFixed(2)}% ≪ 5%`);

    const rng = await grib2RangePointExtract(url, { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 3 });
    ok(rng && rng.timeseries.length === 4, 'range returns 4 steps');
    const same = rng && rng.timeseries.every((s, i) => {
      const w = wholeSeries[i].value;
      return (s.value == null && w == null) || (s.value != null && w != null && Math.abs(s.value - w) <= 1e-3);
    });
    ok(same, 'range values match whole-file (file order)');
    kit.close();
  } finally { server.close(); }
}

// Task 4: public extract() dispatches to range; 1.5GB full-timeseries works; fallback intact.
{
  const { extract } = await import('../lib/sciwrid-api.js');
  const { SciWridToolkit } = await import('../lib/sciwrid-lib.js');
  const ref = JSON.parse(readFileSync(REF, 'utf8'));
  const wet = ref.points.find(q => q.value && q.value > 0.01);

  {
    const { server, port } = await startFileRangeServer(FILE);
    try {
      const kit = new SciWridToolkit(); await kit.read(new Uint8Array(readFileSync(FILE)));
      const vname = (kit.vars.find(x => x.supported) || kit.vars[0]).name; kit.close();
      const out = await extract(`http://127.0.0.1:${port}/f.grib2`,
        { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 });
      ok(out && out._stats && out.timeseries.length === 1, 'extract() used the range path');
      ok(out && Math.abs(out.timeseries[0].value - wet.value) <= 1e-3, 'public range value matches oracle');
    } finally { server.close(); }
  }

  if (existsSync(BIG)) {
    const { server, port } = await startFileRangeServer(BIG);
    try {
      const kitB = new SciWridToolkit(); await kitB.read(new Uint8Array(readFileSync(FILE)));
      const vname = (kitB.vars.find(x => x.supported) || kitB.vars[0]).name; kitB.close();
      const out = await extract(`http://127.0.0.1:${port}/big.grib2`,
        { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 });
      ok(out && out.timeseries.length === 1 && out.timeseries[0].value != null,
         `1.5GB single-time over range: value=${out && out.timeseries[0].value}`);
      ok(out && out._stats.bytes < 20e6, `1.5GB pulled ${out && (out._stats.bytes/1e6).toFixed(1)} MB (index + 1 msg)`);
    } finally { server.close(); }
  } else { console.log('skip 1.5GB (fixture missing)'); }
}

// Follow-up: local seekable source — extract from a LOCAL path without loading
// the whole file (fixes local 1.5GB, which the whole-file path OOMs).
{
  const { extract } = await import('../lib/sciwrid-api.js');
  const { grib2RangePointExtractFile } = await import('../lib/grib2/grib2-range.js');
  const { SciWridToolkit } = await import('../lib/sciwrid-lib.js');
  const ref = JSON.parse(readFileSync(REF, 'utf8'));
  const wet = ref.points.find(q => q.value && q.value > 0.01);

  const kit = new SciWridToolkit(); await kit.read(new Uint8Array(readFileSync(FILE)));
  const vname = (kit.vars.find(x => x.supported) || kit.vars[0]).name; kit.close();

  // direct file reader on the small file, value matches oracle
  const one = await grib2RangePointExtractFile(FILE,
    { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 }, {});
  ok(one && Math.abs(one.timeseries[0].value - wet.value) <= 1e-3, `local file value ${one && one.timeseries[0].value} ≈ ${wet.value}`);
  ok(one && one._stats.bytes < statSync(FILE).size * 0.05, `local read ${one && (100*one._stats.bytes/statSync(FILE).size).toFixed(2)}% (headers + 1 msg)`);

  // public extract() with a bare LOCAL PATH routes through the local range path
  const viaApi = await extract(FILE, { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 });
  ok(viaApi && viaApi._stats && Math.abs(viaApi.timeseries[0].value - wet.value) <= 1e-3, 'extract(localPath) used the local range path');

  // the whole reason: a 1.5GB LOCAL file works (whole-file read() OOMs it)
  if (existsSync(BIG)) {
    const big = await extract(BIG, { variable: vname, lat: wet.queryLat, lon: wet.queryLon, t1: 0, t2: 0 });
    ok(big && big.timeseries.length === 1 && big.timeseries[0].value != null,
       `1.5GB LOCAL file over range: value=${big && big.timeseries[0].value}`);
  } else { console.log('skip 1.5GB local (fixture missing)'); }
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
