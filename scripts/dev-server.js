#!/usr/bin/env node
/**
 * scripts/dev-server.js -- staging server for the browser demos.
 *
 *   npm run dev              serve lib/ source        http://127.0.0.1:5173/
 *   npm run dev:dist         serve the built dist/    http://127.0.0.1:5173/
 *   node scripts/dev-server.js --port 8080 --dist --quiet
 *
 * This is the local stand-in for a staging site: run it on the develop branch,
 * click through the demos, then merge to main. It differs from a plain static
 * server in three ways that matter to this library.
 *
 * 1. IT SPEAKS HTTP RANGE.
 *    scripts/serve.js always returned 200 with the whole body. The library's
 *    range-fetcher requires 206, so the entire range-native path -- and
 *    examples/range-demo.html with it -- could not be exercised locally at all.
 *    A feature you cannot run on your own dev server is a feature nobody
 *    checks before merging. HEAD, 206, 416 and Accept-Ranges are all handled.
 *
 * 2. IT CAN SERVE WHAT SHIPS, NOT WHAT YOU WROTE.
 *    The demos import ../index.js and ../lib/*.js -- source. Consumers get
 *    dist/. Those drift, because dist/ is committed and rebuilt by hand. With
 *    --dist the four library entry points are aliased to dist/index.js, so the
 *    same demo pages run against the bundle a consumer would install.
 *
 * 3. IT DOES NOT CACHE.
 *    Demos are edited and reloaded constantly; a 304 on a stale bundle costs
 *    more time than it saves.
 *
 * Byte accounting is printed per request (method, status, range, bytes) so the
 * range demos can be watched pulling kilobytes out of a multi-megabyte file.
 * That number is the feature's whole claim, and here it is visible by default.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
// The browser demos live in docs/, which is exactly what GitHub Pages serves as
// the site root. Serve that folder at "/" so the authored relative links
// (map-demo.html, api-demo.html, ./idalia/...) resolve locally the same way they
// do in production — rather than only working when nested under /docs/.
const docsRoot = join(root, 'docs');
// A few things a demo may import live ABOVE docs/ (the built bundle, lib source,
// the wasm glue). Requests for these fall back to the repo root, so --dist and
// any local-source import keep working.
const REPO_PATHS = ['/dist', '/lib', '/index.js', '/wasm', '/assets', '/examples'];

/* ---- args ---------------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const port = Number(opt('port', process.env.PORT || 5173));
const useDist = flag('dist');
const quiet = flag('quiet');

/* When --dist is on, the demos' source imports resolve to the built bundle.
 * dist/index.js exports the union of all four modules' public names (checked:
 * scan/extract/extractGrid/trim/detectFormat/SciWridToolkit/resolveRamp/
 * sampleRamp/RAMPS and the error classes), so one alias target covers them. */
const DIST_ALIASES = {
  '/index.js':             '/dist/index.js',
  '/lib/sciwrid-api.js':   '/dist/index.js',
  '/lib/sciwrid-lib.js':   '/dist/index.js',
  '/lib/render/index.js':  '/dist/index.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
  '.grb2': 'application/octet-stream',
  '.grib2':'application/octet-stream',
  '.nc':   'application/octet-stream',
  '.nc3':  'application/octet-stream',
  '.nc4':  'application/octet-stream',
  '.zip':  'application/zip',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
};

/** Parse a single-range `bytes=a-b` / `bytes=a-` / `bytes=-n` header.
 *  Returns {start,end}, or 'unsatisfiable' when the range is past EOF (416),
 *  or null when there is no usable Range header at all (fall through to 200). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;                        // multi-range etc: serve whole
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
  if (start >= size) return 'unsatisfiable';  // 416 -- the EOF probe relies on it
  if (start > end) return null;
  return { start, end: Math.min(end, size - 1) };
}

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

let served = 0;
let bytesOut = 0;

function log(method, status, urlPath, range, bytes) {
  if (quiet) return;
  const tag = status === 206 ? '206' : String(status);
  const r = range ? ` [${range.start}-${range.end}]` : '';
  const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  console.log(`  ${method} ${tag} ${urlPath}${r}  ${kb}`);
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  else if (urlPath.endsWith('/')) urlPath += 'index.html';

  if (useDist && DIST_ALIASES[urlPath]) urlPath = DIST_ALIASES[urlPath];

  // Resolve under docs/ (the site root) by default; fall back to the repo root
  // for the library paths that live above it.
  const fromRepoRoot = REPO_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + '/'));
  const filePath = normalize(join(fromRepoRoot ? root : docsRoot, urlPath));
  if (!filePath.startsWith(root)) {                       // traversal guard
    log(req.method, 403, urlPath, null, 0);
    res.writeHead(403, NO_CACHE); res.end('Forbidden'); return;
  }

  let size;
  try { size = (await stat(filePath)).size; }
  catch {
    log(req.method, 404, urlPath, null, 0);
    res.writeHead(404, NO_CACHE); res.end('Not found: ' + urlPath); return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const base = { ...NO_CACHE, 'Accept-Ranges': 'bytes', 'Content-Type': type };

  if (req.method === 'HEAD') {
    log('HEAD', 200, urlPath, null, 0);
    res.writeHead(200, { ...base, 'Content-Length': size });
    res.end(); return;
  }

  const range = parseRange(req.headers.range, size);

  if (range === 'unsatisfiable') {
    log(req.method, 416, urlPath, null, 0);
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
    res.end(); return;
  }

  if (range) {
    const len = range.end - range.start + 1;
    served++; bytesOut += len;
    log(req.method, 206, urlPath, range, len);
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': len,
    });
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  served++; bytesOut += size;
  log(req.method, 200, urlPath, null, size);
  res.writeHead(200, { ...base, 'Content-Length': size });
  createReadStream(filePath).pipe(res);
});

/* A stale dev server (or Vite on the same default port) holding 5173 used to
 * crash this one with an unhandled EADDRINUSE stack trace. Fall back to the next
 * few ports instead, and only give up with a readable message. */
const MAX_PORT_TRIES = 10;

function start(tryPort, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  port ${tryPort} in use — trying ${tryPort + 1}…`);
      start(tryPort + 1, attemptsLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPorts ${port}–${tryPort} are all in use.`);
      console.error(`A dev server may already be running. Free a port or pass --port <n>.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(tryPort, '127.0.0.1', () => {
    const mode = useDist ? 'dist/ (as published)' : 'lib/ source';
    console.log(`SciWrid dev server`);
    console.log(`  site    ${docsRoot}  (served at /)`);
    console.log(`  serving ${mode}`);
    console.log(`  ranges  enabled (HEAD, 206, 416)`);
    console.log(`  -> http://127.0.0.1:${tryPort}/`);
    if (tryPort !== port) console.log(`  note: requested port ${port} was busy, used ${tryPort}`);
    if (useDist) console.log(`  note: run "npm run build" first if lib/ changed`);
    console.log('');
  });
}

start(port, MAX_PORT_TRIES);

process.on('SIGINT', () => {
  console.log(`\n${served} responses, ${(bytesOut / 1048576).toFixed(2)} MB served`);
  server.close(() => process.exit(0));
});
