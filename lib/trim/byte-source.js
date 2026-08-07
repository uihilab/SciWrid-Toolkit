/*
 * lib/trim/byte-source.js
 *
 * Dual-runtime random-access byte source for the trim pipeline. The trim
 * codepath needs to read small headers and per-message/per-chunk byte
 * spans from potentially huge files without loading the whole thing.
 *
 * Interface (informal):
 *   {
 *     size(): number
 *     read(offset: number, length: number): Promise<Uint8Array>
 *     close(): Promise<void>     // optional
 *   }
 *
 * Implementations:
 *   fromUint8Array(buf)  — in-memory, zero-copy slices (Node + browser)
 *   fromBlob(blob)       — browser File/Blob via .slice() + .arrayBuffer()
 *   fromNodePath(path)   — Node fs with a tiny LRU of open file handles,
 *                          mirroring the pattern in lib/kerchunk/ref-store.js
 *
 * resolveByteSource(source) — accepts the same source shapes the rest of
 * the library does (Uint8Array | ArrayBuffer | Blob | URL | string).
 * URLs are fetched fully into memory in v1 (no HTTP Range yet); a
 * follow-up sprint can add a streaming variant.
 */

import { TrimError } from './errors.js';
import { SourceError } from '../errors.js';
import { remoteSize } from '../sources/range-fetcher.js';

/* ── In-memory source ─────────────────────────────────────────────────── */

export function fromUint8Array(buf) {
  if (!(buf instanceof Uint8Array))
    throw new TrimError('fromUint8Array: expected Uint8Array');
  return {
    size() { return buf.length; },
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buf.length)
        throw new TrimError(
          `byte-source: read [${offset}, ${offset + length}) out of range ` +
          `for buffer of length ${buf.length}`);
      return buf.subarray(offset, offset + length);
    },
    async close() { /* no-op */ },
  };
}

/* ── Browser Blob / File source ───────────────────────────────────────── */

export function fromBlob(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob))
    throw new TrimError('fromBlob: expected a Blob');
  return {
    size() { return blob.size; },
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > blob.size)
        throw new TrimError(
          `byte-source: read [${offset}, ${offset + length}) out of range ` +
          `for blob of size ${blob.size}`);
      const ab = await blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(ab);
    },
    async close() { /* no-op */ },
  };
}

/* ── Node fs path source (with tiny LRU of open file handles) ─────────── */

const FH_CACHE_MAX = 8;

export async function fromNodePath(path) {
  /* Lazy import so the browser bundle doesn't pull in node:fs. */
  const { promises: fs } = await import('node:fs');
  const stat   = await fs.stat(path);
  const total  = stat.size;
  const cache  = new Map();   /* path → FileHandle, LRU by insertion order */

  async function openCached(p) {
    if (cache.has(p)) {
      const fh = cache.get(p);
      cache.delete(p);
      cache.set(p, fh);
      return fh;
    }
    const fh = await fs.open(p, 'r');
    cache.set(p, fh);
    while (cache.size > FH_CACHE_MAX) {
      const [oldestPath, oldestFh] = cache.entries().next().value;
      cache.delete(oldestPath);
      try { await oldestFh.close(); } catch (_) {}
    }
    return fh;
  }

  return {
    size() { return total; },
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > total)
        throw new TrimError(
          `byte-source: read [${offset}, ${offset + length}) out of range ` +
          `for file of size ${total}`);
      const fh  = await openCached(path);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length)
        throw new TrimError(
          `byte-source: short read at offset ${offset}: ` +
          `expected ${length}, got ${bytesRead}`);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    },
    async close() {
      for (const fh of cache.values()) {
        try { await fh.close(); } catch (_) {}
      }
      cache.clear();
    },
  };
}

/* ── HTTP Range source (cloud-hosted COGs etc.) ────────────────────────── */

export async function fromHttpRange(url) {
  /* Size comes from the shared probe, which prefers HEAD because its
   * Content-Length is CORS-safelisted and therefore readable cross-origin.
   * `acceptsRange` is decided by the status code, which is always readable --
   * unlike Accept-Ranges, which CORS strips. */
  let total;
  try {
    total = await remoteSize(url);
  } catch (e) {
    throw new SourceError(`byte-source: cannot size ${url}: ${e.message}`);
  }

  let acceptsRange = false;
  try {
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    acceptsRange = probe.status === 206;
  } catch (_) {
    acceptsRange = false;
  }

  return {
    size() { return total; },
    acceptsRange,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > total)
        throw new TrimError(`byte-source: read [${offset},${offset+length}) out of range for size ${total}`);
      if (!acceptsRange) {
        // Server doesn't support Range — fall back to full body + slice.
        const r = await fetch(url);
        if (!r.ok) throw new SourceError(`byte-source: ${r.status}`);
        const all = new Uint8Array(await r.arrayBuffer());
        return all.subarray(offset, offset + length);
      }
      const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (r.status !== 206 && r.status !== 200)
        throw new SourceError(`byte-source: range fetch ${url} → ${r.status}`);
      const ab = await r.arrayBuffer();
      return new Uint8Array(ab);
    },
    async close() {},
  };
}

/* ── Source resolver — picks the right impl based on the input shape ── */

export async function resolveByteSource(source) {
  if (source instanceof Uint8Array)  return fromUint8Array(source);
  if (source instanceof ArrayBuffer) return fromUint8Array(new Uint8Array(source));
  if (typeof Blob !== 'undefined' && source instanceof Blob) return fromBlob(source);

  /* URL / string handling */
  const isURL = (typeof URL !== 'undefined') && (source instanceof URL);
  const str   = isURL ? source.href : (typeof source === 'string' ? source : null);
  if (str == null)
    throw new SourceError(
      'trim source: expected Uint8Array, ArrayBuffer, Blob, URL, or string ' +
      '(http(s):// URL or local path)');

  if (/^https?:\/\//i.test(str)) {
    /* Range-aware source: HEAD probes Content-Length and Accept-Ranges, then
     * read(offset,length) issues per-request Range fetches (with a full-body
     * fallback for servers that don't honor ranges). */
    return fromHttpRange(str);
  }
  if (str.startsWith('file://')) {
    const { fileURLToPath } = await import('node:url');
    return fromNodePath(fileURLToPath(str));
  }
  /* Treat anything else as a local path (Node only). */
  return fromNodePath(str);
}
