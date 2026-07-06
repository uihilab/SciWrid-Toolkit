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

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
