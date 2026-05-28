#!/usr/bin/env node
// scripts/test-tiff-range.js — verify Range-aware COG-over-URL works
// and reads far less than the full file.

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '..', 'examples', 'testfile', 'tiff',
  'synthetic-f32-none-tile-cog-wgs84.tif');
const fileBytes = readFileSync(fixturePath);
const fileSize = statSync(fixturePath).size;

let bytesServed = 0;

const server = createServer((req, res) => {
  const range = req.headers.range;
  if (!range || req.method === 'HEAD') {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD') { res.end(); return; }
    bytesServed += fileSize;
    res.end(fileBytes);
    return;
  }
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (!m) { res.statusCode = 416; res.end(); return; }
  const start = Number(m[1]), end = Number(m[2]);
  const chunk = fileBytes.subarray(start, end + 1);
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', chunk.length);
  bytesServed += chunk.length;
  res.end(chunk);
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/cog.tif`;

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    →', e.stack || e.message); }
}

const { scan, extract } = await import('../lib/webparsers-api.js');

console.log(`[range — fixture ${fileSize} bytes]`);

const before = bytesServed;
await test('scan over Range URL reads << full file', async () => {
  const meta = await scan(url);
  if (meta.format !== 'tiff') throw new Error(`format=${meta.format}`);
  const used = bytesServed - before;
  if (used >= fileSize * 0.95)
    throw new Error(`scan read ${used}/${fileSize} bytes — Range not used`);
});

const before2 = bytesServed;
await test('extract over Range URL reads only IFD + one tile', async () => {
  const r = await extract(url, { variable: 'band_1', lat: 63.5, lon: 0.5 });
  if (r.value == null) throw new Error('expected non-null value');
  const used = bytesServed - before2;
  if (used >= fileSize * 0.5)
    throw new Error(`extract read ${used}/${fileSize} bytes — Range not used`);
});

// Tear down: close keep-alive sockets so the process can exit naturally on
// Windows (calling process.exit() with pending libuv handles trips a native
// assertion in this Node + undici combo).
if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
server.close();
// Dispose undici's global dispatcher to drop pooled connections.
try {
  const { getGlobalDispatcher } = await import('undici');
  await getGlobalDispatcher().close();
} catch (_) { /* undici not available; rely on natural exit */ }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
