#!/usr/bin/env node
/**
 * scripts/serve.js — minimal static server for the browser demo.
 *
 *   npm run demo:web
 *   → open http://localhost:5173/   (the examples landing page)
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = 5173;

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css':  'text/css',
  '.md':   'text/markdown; charset=utf-8',
  '.grb2': 'application/octet-stream',
  '.grib2':'application/octet-stream',
  '.nc':   'application/octet-stream',
  '.nc3':  'application/octet-stream',
};

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // Default + directory requests resolve to the examples landing page.
  if (urlPath === '/') urlPath = '/examples/index.html';
  else if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = normalize(join(root, urlPath));

  // path traversal guard
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found: ' + urlPath);
  }
});

server.listen(port, () => {
  console.log(`Serving ${root}`);
  console.log(`→ http://localhost:${port}/   (examples landing page)`);
});
