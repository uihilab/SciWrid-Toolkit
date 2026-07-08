/*
 * scripts/perf/range-server.js — Range-capable static server for benchmarking.
 *
 * The demo server (scripts/serve.js) always reads the whole file and returns
 * 200, which the library's range-fetcher rejects (it requires 206). This server
 * speaks real HTTP Range so we can measure how many bytes each access mode
 * actually pulls from "the web":
 *
 *   - GET with `Range: bytes=a-b`  → 206 + Content-Range, streams only [a..b]
 *   - GET without Range            → 200, streams the whole file
 *   - HEAD                         → 200 + Content-Length + Accept-Ranges
 *
 * A shared `stats` object records, per request, the method/status/byte count so
 * the harness can attribute bytes-transferred to a single measured query.
 * Bytes are streamed (createReadStream), so 2 GB files never load into RAM.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, normalize, join } from 'node:path';

export function createStats() {
  const stats = {
    requests: 0,
    bytesServed: 0,
    byStatus: {},        // { 200: n, 206: n, 404: n }
    log: [],             // [{ method, status, range, bytes }]
    reset() {
      this.requests = 0;
      this.bytesServed = 0;
      this.byStatus = {};
      this.log = [];
    },
    record(entry) {
      this.requests += 1;
      this.bytesServed += entry.bytes || 0;
      this.byStatus[entry.status] = (this.byStatus[entry.status] || 0) + 1;
      this.log.push(entry);
    },
  };
  return stats;
}

/** Parse a single-range `bytes=a-b` / `bytes=a-` / `bytes=-n` header. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '') {                 // suffix range: last N bytes
    const n = Number(m[2]);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

/**
 * Start an in-process Range server.
 *
 * Files are served two ways:
 *   - register(absPath) → returns an opaque `/f/<id>` URL for ANY absolute path
 *     (so files on other drives, e.g. E:, are served safely without exposing
 *     the filesystem).
 *   - optional `root`: also serve files under a repo root by relative path.
 *
 * Returns { url, port, stats, register(absPath), urlFor(relPath), close() }.
 */
export function startRangeServer({ root, port = 0 } = {}) {
  const absRoot = root ? resolve(root) : null;
  const stats = createStats();
  const registry = new Map();   // id → absPath
  let nextId = 1;

  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    // Registered absolute-path files: /f/<id>
    let filePath;
    const reg = /^\/f\/(\d+)$/.exec(urlPath);
    if (reg) {
      filePath = registry.get(Number(reg[1]));
      if (!filePath) {
        stats.record({ method: req.method, status: 404, range: null, bytes: 0 });
        res.writeHead(404); res.end('Not found'); return;
      }
    } else if (absRoot) {
      filePath = normalize(join(absRoot, urlPath));
      if (!filePath.startsWith(absRoot)) {
        stats.record({ method: req.method, status: 403, range: null, bytes: 0 });
        res.writeHead(403); res.end('Forbidden'); return;
      }
    } else {
      stats.record({ method: req.method, status: 404, range: null, bytes: 0 });
      res.writeHead(404); res.end('Not found'); return;
    }

    let size;
    try { size = (await stat(filePath)).size; }
    catch {
      stats.record({ method: req.method, status: 404, range: null, bytes: 0 });
      res.writeHead(404); res.end('Not found'); return;
    }

    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    };

    if (req.method === 'HEAD') {
      stats.record({ method: 'HEAD', status: 200, range: null, bytes: 0 });
      res.writeHead(200, { ...baseHeaders, 'Content-Length': size });
      res.end(); return;
    }

    const range = parseRange(req.headers.range, size);
    if (range) {
      const len = range.end - range.start + 1;
      stats.record({ method: 'GET', status: 206, range: [range.start, range.end], bytes: len });
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': len,
      });
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    // Whole-file GET (the "naive" baseline path).
    stats.record({ method: 'GET', status: 200, range: null, bytes: size });
    res.writeHead(200, { ...baseHeaders, 'Content-Length': size });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const base = `http://127.0.0.1:${actualPort}`;
      resolveP({
        url: base,
        port: actualPort,
        stats,
        register: (absPath) => { const id = nextId++; registry.set(id, resolve(absPath)); return `${base}/f/${id}`; },
        urlFor: (relPath) => `${base}/${String(relPath).replace(/^[/\\]+/, '').replace(/\\/g, '/')}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
