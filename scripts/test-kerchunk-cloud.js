#!/usr/bin/env node
/*
 * scripts/test-kerchunk-cloud.js - cloud kerchunk + smart-extraction tests.
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FIXTURE = resolve(root, 'examples/testfile/kerchunk-fixture.parquet');
const BIN_FIX = resolve(root, 'examples/testfile/kerchunk-fixture.bin');

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { skipped++; console.log('SKIP'); }
    else { passed++; console.log('OK'); }
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.error('    ->', e.stack || e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function startRangeServer(buf) {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Length': buf.length });
      res.end(Buffer.from(buf));
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }
    const start = +m[1], end = +m[2];
    const slice = Buffer.from(buf).subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      'Content-Length': slice.length,
    });
    res.end(slice);
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

console.log('test-kerchunk-cloud.js\n');
if (!existsSync(FIXTURE) || !existsSync(BIN_FIX)) {
  console.error('Fixtures missing. Run: node scripts/build-kerchunk-fixture.js');
  process.exit(1);
}

await test('translateUrl maps s3:// and gs:// to public HTTPS, passes http(s) through', async () => {
  const { translateUrl } = await import('../lib/sources/range-fetcher.js');
  assert(translateUrl('s3://my-bucket/a/b.nc') === 'https://my-bucket.s3.amazonaws.com/a/b.nc',
    's3 translation wrong: ' + translateUrl('s3://my-bucket/a/b.nc'));
  assert(translateUrl('gs://my-bucket/a/b.nc') === 'https://storage.googleapis.com/my-bucket/a/b.nc',
    'gs translation wrong: ' + translateUrl('gs://my-bucket/a/b.nc'));
  assert(translateUrl('https://x/y') === 'https://x/y', 'https passthrough wrong');
  let threw = false;
  try { translateUrl('ftp://nope'); } catch { threw = true; }
  assert(threw, 'unsupported scheme should throw');
});

await test('fetchRange returns exactly the requested byte slice', async () => {
  const { fetchRange } = await import('../lib/sources/range-fetcher.js');
  const bin = readFileSync(BIN_FIX);
  const { server, port } = await startRangeServer(bin);
  try {
    const got = await fetchRange(`http://127.0.0.1:${port}/fixture.bin`, 26, 28);
    assert(got instanceof Uint8Array && got.length === 28, 'expected 28 bytes, got ' + got.length);
    for (let i = 0; i < 28; i++)
      if (got[i] !== bin[26 + i]) throw new Error('byte ' + i + ' mismatch');
  } finally {
    server.close();
  }
});

await test('fetchRange throws on a non-206 response', async () => {
  const { fetchRange } = await import('../lib/sources/range-fetcher.js');
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    let err;
    try { await fetchRange(`http://127.0.0.1:${port}/x`, 0, 4); } catch (e) { err = e; }
    assert(err && /206/.test(err.message), 'expected a 206 error, got ' + (err && err.message));
  } finally {
    server.close();
  }
});

await test('MemoryChunkCache returns stored bytes and evicts LRU by byte budget', async () => {
  const { MemoryChunkCache, cacheKey } = await import('../lib/sources/chunk-cache.js');
  const cache = new MemoryChunkCache(20);
  const k1 = cacheKey('u', 0, 8), k2 = cacheKey('u', 8, 8), k3 = cacheKey('u', 16, 8);
  cache.set(k1, new Uint8Array(8));
  cache.set(k2, new Uint8Array(8));
  assert(cache.get(k1), 'k1 should be present');
  cache.set(k3, new Uint8Array(8));
  assert(cache.get(k2) === null, 'k2 should have been evicted');
  assert(cache.get(k1) && cache.get(k3), 'k1 and k3 should remain');
});

await test('RemoteKerchunkRefStore fetches remote refs and serves repeats from cache', async () => {
  const { RemoteKerchunkRefStore } = await import('../lib/sources/remote-ref-store.js');
  const bin = readFileSync(BIN_FIX);
  const { server, port } = await startRangeServer(bin);
  try {
    const url = `http://127.0.0.1:${port}/fixture.bin`;
    let calls = 0;
    const fetchImpl = (u, opts) => { calls++; return globalThis.fetch(u, opts); };
    const stubIdx = {
      listMetaKeys: () => [], getMeta: () => null, listChunkKeys: () => ['0.1'],
      getRef: (v, k) => (v === 'tas' && k === '0.1')
        ? { kind: 'remote', url, offset: 26, length: 28 }
        : null,
    };
    const store = new RemoteKerchunkRefStore(stubIdx, [{ name: 'tas' }], { fetchImpl });
    const a = await store.getChunkBytes('tas', '0.1');
    assert(a && a.length === 28, 'first read length wrong');
    for (let i = 0; i < 28; i++) if (a[i] !== bin[26 + i]) throw new Error('byte ' + i + ' mismatch');
    const b = await store.getChunkBytes('tas', '0.1');
    assert(b && b.length === 28, 'second read length wrong');
    assert(calls === 1, 'expected 1 network fetch, got ' + calls);
    assert((await store.getChunkBytes('tas', '9.9')) === null, 'missing ref should return null');
    await store.close();
  } finally {
    server.close();
  }
});

await test('RemoteKerchunkRefStore returns inline bytes verbatim', async () => {
  const { RemoteKerchunkRefStore } = await import('../lib/sources/remote-ref-store.js');
  const payload = new Uint8Array([9, 8, 7]);
  const stubIdx = {
    listMetaKeys: () => [], getMeta: () => null, listChunkKeys: () => ['0.0'],
    getRef: () => ({ kind: 'inline', bytes: payload }),
  };
  const store = new RemoteKerchunkRefStore(stubIdx, [{ name: 'tas' }], {});
  assert((await store.getChunkBytes('tas', '0.0')) === payload, 'inline payload must pass through');
});

await test('openRefIndex keeps local file refs unchanged', async () => {
  const { openRefIndex } = await import('../lib/kerchunk/parquet-refs.js');
  const idx = await openRefIndex(FIXTURE);
  const ref = idx.getRef('tas', '0.0');
  assert(ref && ref.kind === 'file', 'local ref kind should stay file, got ' + (ref && ref.kind));
  assert(ref.offset === 0 && ref.length === 26, 'offset/length wrong: ' + JSON.stringify(ref));
  assert(ref.path.endsWith('kerchunk-fixture.bin'), 'path wrong: ' + ref.path);
});

await test('openRefIndexFromBuffer resolves relative chunk paths against the parquet URL', async () => {
  const { openRefIndexFromBuffer } = await import('../lib/kerchunk/parquet-refs.js');
  const idx = await openRefIndexFromBuffer(readFileSync(FIXTURE), 'https://host.example/data/refs.parquet');
  const ref = idx.getRef('tas', '0.0');
  assert(ref && ref.kind === 'remote', 'expected remote ref, got ' + (ref && ref.kind));
  assert(ref.url === 'https://host.example/data/kerchunk-fixture.bin',
    'relative URL resolution wrong: ' + ref.url);
  assert(ref.offset === 0 && ref.length === 26, 'offset/length wrong: ' + JSON.stringify(ref));
  assert(idx.getMeta('tas/.zarray') instanceof Uint8Array, 'meta should still be readable');
});

function startKerchunkFixtureServer() {
  const pq = readFileSync(FIXTURE);
  const bin = readFileSync(BIN_FIX);
  const server = http.createServer((req, res) => {
    if (req.url === '/refs.parquet') {
      res.writeHead(200, { 'Content-Length': pq.length });
      res.end(pq);
      return;
    }
    if (req.url === '/kerchunk-fixture.bin') {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!m) {
        res.writeHead(200, { 'Content-Length': bin.length });
        res.end(bin);
        return;
      }
      const s = +m[1], e = +m[2], slice = bin.subarray(s, e + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${s}-${e}/${bin.length}`,
        'Content-Length': slice.length,
      });
      res.end(slice);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

await test('kerchunkScanRemote serves a fixture over HTTP and lists tas/x/y', async () => {
  const { kerchunkScanRemote, scanGetVarsJson, scanFree } = await import('../lib/kerchunk-helper.js');
  const { server, port } = await startKerchunkFixtureServer();
  try {
    const sr = await kerchunkScanRemote(`http://127.0.0.1:${port}/refs.parquet`);
    const meta = JSON.parse(scanGetVarsJson(sr));
    const names = meta.map((v) => v.name).sort();
    assert(names.includes('tas') && names.includes('x') && names.includes('y'),
      'expected tas/x/y, got ' + names.join(','));
    const tas = meta.find((v) => v.name === 'tas');
    assert(tas.shape[0] === 4 && tas.shape[1] === 8, 'tas shape wrong: ' + JSON.stringify(tas.shape));
    await scanFree(sr);
  } finally {
    server.close();
  }
});

await test('kerchunkScanRemote to _readArrayAsFloat32 round-trips remote chunk values', async () => {
  const { kerchunkScanRemote, scanFree } = await import('../lib/kerchunk-helper.js');
  const { _readArrayAsFloat32 } = await import('../lib/zarr-helper.js');
  const { server, port } = await startKerchunkFixtureServer();
  try {
    const sr = await kerchunkScanRemote(`http://127.0.0.1:${port}/refs.parquet`);
    const tas = sr.arrays.find((a) => a.name === 'tas');
    const flat = await _readArrayAsFloat32(sr, tas);
    assert(flat.length === 32 && flat[0] === 0 && flat[7] === 7 && flat[31] === 31,
      'remote round-trip values wrong');
    await scanFree(sr);
  } finally {
    server.close();
  }
});

await test('readArrayWindowed fetches only the axis-0 chunk band for the window', async () => {
  const { kerchunkScan, scanFree } = await import('../lib/kerchunk-helper.js');
  const { readArrayWindowed } = await import('../lib/zarr/chunk-grid.js');
  const sr = await kerchunkScan(FIXTURE);
  const tas = sr.arrays.find((a) => a.name === 'tas');
  const fetched = [];
  const realGet = sr.source.getChunkBytes.bind(sr.source);
  sr.source.getChunkBytes = (name, key) => {
    if (name === 'tas') fetched.push(key);
    return realGet(name, key);
  };
  const win = await readArrayWindowed(sr, tas, 0, 0);
  assert(win.winStart === 0 && win.winLen === 2, 'window meta wrong: ' + JSON.stringify(win));
  assert(win.data.length === 16, 'expected 16 elements, got ' + win.data.length);
  assert(win.data[0] === 0 && win.data[15] === 15, 'window values wrong');
  const set = new Set(fetched);
  assert(set.has('0.0') && set.has('0.1'), 'should fetch row-0 chunks, got ' + fetched.join(','));
  assert(!set.has('1.0') && !set.has('1.1'), 'must not fetch row-1 chunks, got ' + fetched.join(','));
  await scanFree(sr);
});

await test('readArrayWindowed second band returns the next rows with shifted winStart', async () => {
  const { kerchunkScan, scanFree } = await import('../lib/kerchunk-helper.js');
  const { readArrayWindowed } = await import('../lib/zarr/chunk-grid.js');
  const sr = await kerchunkScan(FIXTURE);
  const tas = sr.arrays.find((a) => a.name === 'tas');
  const win = await readArrayWindowed(sr, tas, 1, 1);
  assert(win.winStart === 2 && win.winLen === 2, 'window meta wrong: ' + JSON.stringify(win));
  assert(win.data[0] === 16 && win.data[15] === 31, 'second-band values wrong');
  await scanFree(sr);
});

await test('readArrayWindowed rejects an out-of-range chunk band', async () => {
  const { kerchunkScan, scanFree } = await import('../lib/kerchunk-helper.js');
  const { readArrayWindowed } = await import('../lib/zarr/chunk-grid.js');
  const sr = await kerchunkScan(FIXTURE);
  const tas = sr.arrays.find((a) => a.name === 'tas');
  let err;
  try { await readArrayWindowed(sr, tas, 0, 9); } catch (e) { err = e; }
  assert(err && /chunk window/.test(err.message), 'expected a window-range error, got ' + (err && err.message));
  await scanFree(sr);
});

function makeMockWasm() {
  const HEAP = new ArrayBuffer(1 << 20);
  const HEAPF32 = new Float32Array(HEAP);
  const HEAPF64 = new Float64Array(HEAP);
  const HEAPU8 = new Uint8Array(HEAP);
  let top = 8;
  const captured = {};
  return {
    HEAPF32, HEAPF64,
    lengthBytesUTF8: (s) => Buffer.byteLength(s, 'utf8'),
    stringToUTF8: (s, ptr, max) => {
      const b = Buffer.from(s + '\0', 'utf8');
      HEAPU8.set(b.subarray(0, max), ptr);
    },
    ccall: (fn, _ret, _types, args) => {
      if (fn === 'wp_malloc') {
        const p = top;
        top += args[0];
        top = (top + 7) & ~7;
        return p;
      }
      if (fn === 'wp_free') return undefined;
      if (fn === 'wp_open_from_float_arrays') {
        const [, nx, ny, nt, , , tsPtr, dataPtr] = args;
        captured.nt = nt;
        captured.ny = ny;
        captured.nx = nx;
        captured.times = Array.from({ length: nt }, (_, i) => HEAPF64[tsPtr / 8 + i]);
        captured.data = Array.from({ length: nt * ny * nx }, (_, i) => HEAPF32[dataPtr / 4 + i]);
        return 1;
      }
      return 0;
    },
    _captured: captured,
  };
}

function makeNormalizeStub() {
  const meta = {
    zarr_format: 2, shape: [4, 2, 2], chunks: [2, 2, 2],
    dtype: '<f4', compressor: null, filters: null,
    fill_value: 'NaN', order: 'C', dimension_separator: '.',
  };
  const arrayInfo = { name: 'v', root: 'v/', meta, attrs: null };
  const rawOf = (vals) => new Uint8Array(Float32Array.from(vals).buffer);
  const chunkBytes = {
    '0.0.0': rawOf([0, 1, 2, 3, 4, 5, 6, 7]),
    '1.0.0': rawOf([8, 9, 10, 11, 12, 13, 14, 15]),
  };
  return { arrayInfo, chunkBytes };
}

await test('normalize(timeIndexRange) prunes to the covering chunk band and hands C the sub-window', async () => {
  const { normalize } = await import('../lib/zarr-helper.js');
  const { arrayInfo, chunkBytes } = makeNormalizeStub();
  const fetched = [];
  const stubSource = {
    listArrays: () => [arrayInfo],
    getChunkBytes: async (_name, key) => { fetched.push(key); return chunkBytes[key] || null; },
  };
  const wasm = makeMockWasm();
  const ds = await normalize({ source: stubSource, arrays: [arrayInfo] }, 0, wasm, { timeIndexRange: [0, 1] });
  assert(ds === 1, 'normalize should return dataset pointer from mock');
  assert(fetched.includes('0.0.0') && !fetched.includes('1.0.0'),
    'expected only 0.0.0 fetched, got ' + fetched.join(','));
  const c = wasm._captured;
  assert(c.nt === 2 && c.ny === 2 && c.nx === 2, 'dims wrong');
  assert(c.data.join(',') === '0,1,2,3,4,5,6,7', 'pruned data wrong: ' + c.data.join(','));
  assert(c.times.length === 2, 'expected 2 time values, got ' + c.times.length);
});

await test('normalize without opts still reads the full array (regression)', async () => {
  const { normalize } = await import('../lib/zarr-helper.js');
  const { arrayInfo, chunkBytes } = makeNormalizeStub();
  const stubSource = {
    listArrays: () => [arrayInfo],
    getChunkBytes: async (_name, key) => chunkBytes[key] || null,
  };
  const wasm = makeMockWasm();
  await normalize({ source: stubSource, arrays: [arrayInfo] }, 0, wasm);
  assert(wasm._captured.nt === 4, 'full read should have nt=4, got ' + wasm._captured.nt);
  assert(wasm._captured.data.length === 16, 'full read should have 16 elements');
});

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
