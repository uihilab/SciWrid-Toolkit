#!/usr/bin/env node
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, normalize } from 'node:path';
import * as pqh from '../lib/parquet-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const parquetRoot = resolve(root, 'examples/testfile/parquet');
const f = (name) => resolve(parquetRoot, name);

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function startRangeServer(rootDir) {
  const absRoot = resolve(rootDir);
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^[/\\]+/, '');
    const filePath = normalize(join(absRoot, rel));
    if (!filePath.startsWith(absRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
    let size;
    try { size = (await stat(filePath)).size; }
    catch { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': size }); res.end(); return; }
    const range = parseRange(req.headers.range, size);
    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': len });
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(filePath).pipe(res);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  return {
    urlFor: (name) => `http://127.0.0.1:${port}/${name}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

const server = await startRangeServer(parquetRoot);
try {
  const wholeGrid = await pqh.extractGrid(new Uint8Array(readFileSync(f('sorted_time.parquet'))),
    { variable: 'v', bbox: [0, 10, 4, 30], width: 4, height: 3, t: 0 });
  const urlGrid = await pqh.extractGrid(server.urlFor('sorted_time.parquet'),
    { variable: 'v', bbox: [0, 10, 4, 30], width: 4, height: 3, t: 0 });
  assert.deepEqual([...urlGrid.data], [...wholeGrid.data], 'ranged == whole-file');
  const unsortedGrid = await pqh.extractGrid(server.urlFor('unsorted_time.parquet'),
    { variable: 'v', bbox: [0, 10, 4, 30], width: 4, height: 3, t: 0 });
  assert.deepEqual([...unsortedGrid.data], [...wholeGrid.data], 'unsorted fallback correct');
  console.log('ok: parquet range-native');
} finally {
  await server.close();
}
