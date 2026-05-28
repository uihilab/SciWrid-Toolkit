#!/usr/bin/env node
/**
 * scripts/test-slim.js — smoke tests for the slim() pipeline (Sprint 5).
 *
 * Run from repo root:
 *   node scripts/test-slim.js
 *
 * Covers all four formats:
 *   GRIB2   — real fixture (examples/timeseries/gfs_timeseries.grb2 if present)
 *   NetCDF3 — synthesized fixture (hand-built CDF in this file)
 *   Zarr    — synthesized fixture (hand-built zip-of-zarr in this file)
 *   NetCDF4 — synthesized fixture (built with h5wasm)
 *
 * Per format we verify:
 *   - output round-trips through scan() and re-detects as the same format
 *   - kept variables are present, dropped variables are absent
 *   - time slicing produces the expected timesteps and values
 *   - boundary widening (Zarr) surfaces a clear warning
 *   - bad inputs surface clear typed errors
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  scan, extract, slim,
  SlimError, VariableNotFoundError, UnsupportedFormatError,
} from '../lib/webparsers-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

/* ── tiny test runner ─────────────────────────────────────────────────── */
let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { skipped++; console.log('SKIP'); }
    else              { passed++;  console.log('OK');   }
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.error('    →', e.stack || e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/* ── fixture helpers ─────────────────────────────────────────────────── */

const enc = new TextEncoder();
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n>>>0, false); return b; };
const f32be = (arr) => { const b = new Uint8Array(arr.length*4); const dv = new DataView(b.buffer); for (let i=0;i<arr.length;i++) dv.setFloat32(i*4, arr[i], false); return b; };
const concat = (...bufs) => { let n=0; for (const b of bufs) n+=b.length; const o=new Uint8Array(n); let p=0; for (const b of bufs) {o.set(b,p);p+=b.length;} return o; };
const pad4 = (n) => (4 - (n%4))%4;
const padded = (bytes) => { const p = pad4(bytes.length); return p?concat(bytes,new Uint8Array(p)):bytes; };

/* ── NetCDF3 fixture ─────────────────────────────────────────────────── */

function buildNC3Fixture() {
  function writeName(name) { const b = enc.encode(name); return concat(u32be(b.length), padded(b)); }
  function writeAttList(atts) {
    if (!atts.length) return concat(u32be(0), u32be(0));
    const parts = [u32be(0x0C), u32be(atts.length)];
    for (const a of atts)
      parts.push(writeName(a.name), u32be(a.type), u32be(a.nelems), padded(a.bytes));
    return concat(...parts);
  }

  const NDIMS = 3, NVARS = 3, NUMRECS = 4;
  const magic = new Uint8Array([0x43,0x44,0x46,0x01]);
  const dimList = concat(u32be(0x0A), u32be(NDIMS),
    writeName('time'), u32be(0), writeName('lat'),  u32be(2), writeName('lon'),  u32be(3));
  const gattList = writeAttList([
    { name: 'title', type: 2, nelems: 5, bytes: enc.encode('hello') },
  ]);
  const TAS_V = 2*3*4, HEIGHT_V = 2*3*4, TIME_V = 4;

  function makeVarDefs(tasB, heightB, timeB) {
    const tas = concat(writeName('tas'), u32be(3), u32be(0), u32be(1), u32be(2),
      writeAttList([{ name: 'units', type: 2, nelems: 1, bytes: enc.encode('K') }]),
      u32be(5), u32be(TAS_V), u32be(tasB));
    const height = concat(writeName('height'), u32be(2), u32be(1), u32be(2),
      writeAttList([]), u32be(5), u32be(HEIGHT_V), u32be(heightB));
    const time = concat(writeName('time'), u32be(1), u32be(0),
      writeAttList([{ name: 'units', type: 2, nelems: 19, bytes: enc.encode('hours since 2025-01') }]),
      u32be(5), u32be(TIME_V), u32be(timeB));
    return concat(u32be(0x0B), u32be(NVARS), tas, height, time);
  }

  /* First pass with zero begins → measure header length */
  const header0 = concat(magic, u32be(NUMRECS), dimList, gattList, makeVarDefs(0,0,0));
  const headerLen   = header0.length;
  const heightBegin = headerLen;
  const recordStart = heightBegin + HEIGHT_V;
  const tasBegin    = recordStart;
  const timeBegin   = recordStart + TAS_V;

  const header = concat(magic, u32be(NUMRECS), dimList, gattList,
    makeVarDefs(tasBegin, heightBegin, timeBegin));
  if (header.length !== headerLen) throw new Error('NC3 header length drift');

  const heightData = f32be([100,200,300, 400,500,600]);
  const records = [];
  for (let r = 0; r < NUMRECS; r++) {
    records.push(f32be([10+r,11+r,12+r, 13+r,14+r,15+r]));
    records.push(f32be([r]));
  }
  return concat(header, heightData, ...records);
}

/* ── Zarr (zip-of-zarr) fixture ──────────────────────────────────────── */

function jsonBytes(obj) { return enc.encode(JSON.stringify(obj)); }

function buildZip(entries) {
  const localParts = [], cdParts = [];
  let off = 0;
  for (const { name, bytes } of entries) {
    const nb = enc.encode(name);
    const lh = new Uint8Array(30 + nb.length); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 0, true);
    dv.setUint32(18, bytes.length, true); dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nb.length, true); lh.set(nb, 30);
    localParts.push(lh, bytes);
    const cd = new Uint8Array(46 + nb.length); const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint32(20, bytes.length, true); cdv.setUint32(24, bytes.length, true);
    cdv.setUint16(28, nb.length, true); cdv.setUint32(42, off, true); cd.set(nb, 46);
    cdParts.push(cd);
    off += lh.length + bytes.length;
  }
  const cdSize = cdParts.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22); const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true); edv.setUint32(12, cdSize, true);
  edv.setUint32(16, off, true);
  const out = new Uint8Array(off + cdSize + 22); let p = 0;
  for (const x of localParts) { out.set(x, p); p += x.length; }
  for (const x of cdParts)    { out.set(x, p); p += x.length; }
  out.set(eocd, p);
  return out;
}

function buildZarrFixture() {
  const zarrayMeta = {
    zarr_format: 2, shape: [4, 2, 2], chunks: [2, 2, 2],
    dtype: '<f4', compressor: null, fill_value: null, order: 'C', filters: null,
    dimension_separator: '.',
  };
  const c0 = (() => { const u=new Uint8Array(8*4); new Float32Array(u.buffer).set([1,2,3,4, 5,6,7,8]); return u; })();
  const c1 = (() => { const u=new Uint8Array(8*4); new Float32Array(u.buffer).set([9,10,11,12, 13,14,15,16]); return u; })();
  return buildZip([
    { name: '.zgroup', bytes: jsonBytes({ zarr_format: 2 }) },
    { name: 'temperature/.zarray', bytes: jsonBytes(zarrayMeta) },
    { name: 'temperature/.zattrs', bytes: jsonBytes({ _ARRAY_DIMENSIONS: ['time','lat','lon'], units: 'K' }) },
    { name: 'temperature/0.0.0', bytes: c0 },
    { name: 'temperature/1.0.0', bytes: c1 },
    { name: 'precip/.zarray',  bytes: jsonBytes(zarrayMeta) },
    { name: 'precip/.zattrs',  bytes: jsonBytes({ _ARRAY_DIMENSIONS: ['time','lat','lon'], units: 'mm' }) },
    { name: 'precip/0.0.0',    bytes: c0 },
    { name: 'precip/1.0.0',    bytes: c1 },
  ]);
}

/* ── NetCDF4 fixture (lazy h5wasm, skipped if unavailable) ───────────── */

async function buildNC4Fixture() {
  let h5mod;
  try { h5mod = await import('h5wasm'); }
  catch (_) { return null; }
  const h5 = h5mod.default ?? h5mod;
  const { FS } = await h5.ready;

  const fname = `_slim_fixture_${Date.now()}.nc`;
  const NT = 5, NY = 4, NX = 6;
  const f = new h5.File(fname, 'w');

  const tas = new Float32Array(NT*NY*NX);
  for (let t=0;t<NT;t++) for (let y=0;y<NY;y++) for (let x=0;x<NX;x++)
    tas[t*NY*NX + y*NX + x] = 100 + t*100 + y*10 + x;
  const ds = f.create_dataset({ name:'tas', data:tas, shape:[NT,NY,NX], dtype:'<f4' });
  ds.create_attribute('units', 'K');

  const heightData = new Float32Array(NY*NX);
  for (let i=0;i<NY*NX;i++) heightData[i] = 1000+i;
  f.create_dataset({ name:'height', data:heightData, shape:[NY,NX], dtype:'<f4' });

  const tArr = new Float64Array(NT);
  for (let i=0;i<NT;i++) tArr[i] = i*3600;
  const tds = f.create_dataset({ name:'time', data:tArr, shape:[NT], dtype:'<f8' });
  tds.create_attribute('units', 'seconds since 2025-01-01');

  const lat = new Float32Array(NY);
  for (let i=0;i<NY;i++) lat[i] = 30 + i*5;
  const lon = new Float32Array(NX);
  for (let i=0;i<NX;i++) lon[i] = -100 + i*5;
  f.create_dataset({ name:'lat', data:lat, shape:[NY], dtype:'<f4' });
  f.create_dataset({ name:'lon', data:lon, shape:[NX], dtype:'<f4' });

  f.flush(); f.close();
  const bytes = new Uint8Array(FS.readFile(fname));
  FS.unlink(fname);
  return { bytes, h5, FS, NT, NY, NX };
}

/* ====================================================================== */
/* Tests                                                                   */
/* ====================================================================== */

console.log('webparsers/slim smoke test\n');

/* ---------------- Dispatcher / validation ---------------- */

console.log('[dispatcher]');

await test('opts is required', async () => {
  let err;
  try { await slim(new Uint8Array([0xff,0xff,0xff,0xff]), undefined); }
  catch (e) { err = e; }
  assert(err instanceof SlimError, 'expected SlimError, got ' + (err?.constructor.name));
});

await test('opts.variables must be a non-empty string array', async () => {
  let err;
  try { await slim(new Uint8Array([0xff]), { variables: [] }); }
  catch (e) { err = e; }
  assert(err instanceof SlimError && /non-empty/.test(err.message));
});

await test('t2 < t1 throws SlimError', async () => {
  let err;
  try { await slim(new Uint8Array([0xff]), { variables: ['x'], t1: 5, t2: 1 }); }
  catch (e) { err = e; }
  assert(err instanceof SlimError && /t2.*>=.*t1/i.test(err.message));
});

await test('unknown magic bytes → UnsupportedFormatError', async () => {
  const garbage = new Uint8Array([0xff,0xff,0xff,0xff,0,0,0,0,0,0,0,0,0,0,0,0]);
  let err;
  try { await slim(garbage, { variables: ['x'] }); }
  catch (e) { err = e; }
  assert(err instanceof UnsupportedFormatError);
});

/* ---------------- GRIB2 ---------------- */

console.log('\n[grib2]');

const grbPath = resolve(root, 'examples/timeseries/gfs_timeseries.grb2');
const hasGrb  = existsSync(grbPath);

await test('GRIB2: keep one variable round-trips through scan()', async () => {
  if (!hasGrb) return 'skip';
  const data = new Uint8Array(readFileSync(grbPath));
  const meta = await scan(data);
  const v = meta.variables.find(x => x.supported)?.name;
  assert(v, 'no supported variable in fixture');
  const r = await slim(data, { variables: [v] });
  assert(r.format === 'grib2');
  assert(r.bytes.length < data.length, 'slimmed should be smaller');
  const meta2 = await scan(r.bytes);
  assert(meta2.format === 'grib2');
  assert(meta2.variable_names.includes(v), 'slimmed should contain ' + v);
});

await test('GRIB2: time slice keeps the expected number of messages', async () => {
  if (!hasGrb) return 'skip';
  const data = new Uint8Array(readFileSync(grbPath));
  const meta = await scan(data);
  const v = meta.variables.find(x => x.supported && x.messages > 1)?.name;
  if (!v) return 'skip';
  const r = await slim(data, { variables: [v], t1: 0, t2: 1 });
  const meta2 = await scan(r.bytes);
  const v2 = meta2.variables.find(x => x.name === v);
  assert(v2 && v2.messages === 2, `expected 2 messages, got ${v2?.messages}`);
  assert(r.warnings.length > 0 && /timesteps/.test(r.warnings[0]));
});

await test('GRIB2: unknown variable → VariableNotFoundError', async () => {
  if (!hasGrb) return 'skip';
  const data = new Uint8Array(readFileSync(grbPath));
  let err;
  try { await slim(data, { variables: ['NOPE'] }); }
  catch (e) { err = e; }
  assert(err instanceof VariableNotFoundError);
});

/* ---------------- NetCDF3 ---------------- */

console.log('\n[netcdf3]');

await test('NetCDF3: keep a record var only', async () => {
  const fx = buildNC3Fixture();
  const r = await slim(fx, { variables: ['tas'] });
  assert(r.format === 'netcdf3');
  const m = await scan(r.bytes);
  assert(m.variable_names.includes('tas'));
  assert(!m.variable_names.includes('height'));
  const e = await extract(r.bytes, { variable: 'tas', lat: 0, lon: 0, t1: 0, t2: 3 });
  /* original tas[t,0,0] = 10+t → [10,11,12,13] */
  const ts = e.timeseries?.map(p => p.value) ?? [];
  assert(JSON.stringify(ts) === '[10,11,12,13]', 'expected [10,11,12,13], got ' + JSON.stringify(ts));
});

await test('NetCDF3: time slice on record var', async () => {
  const fx = buildNC3Fixture();
  const r = await slim(fx, { variables: ['tas','time'], t1: 1, t2: 2 });
  const e = await extract(r.bytes, { variable: 'tas', lat: 0, lon: 0, t1: 0, t2: 1 });
  const ts = e.timeseries?.map(p => p.value) ?? [];
  /* slimmed t=0,1 = original t=1,2 → values 11, 12 */
  assert(JSON.stringify(ts) === '[11,12]', 'expected [11,12], got ' + JSON.stringify(ts));
});

await test('NetCDF3: non-record var round-trip', async () => {
  const fx = buildNC3Fixture();
  const r = await slim(fx, { variables: ['height'] });
  const e = await extract(r.bytes, { variable: 'height', lat: 0, lon: 0 });
  const v = e.timeseries?.[0]?.value ?? e.value;
  assert(v === 100, 'expected 100, got ' + v);
});

await test('NetCDF3: unknown variable → VariableNotFoundError', async () => {
  const fx = buildNC3Fixture();
  let err;
  try { await slim(fx, { variables: ['NOPE'] }); }
  catch (e) { err = e; }
  assert(err instanceof VariableNotFoundError);
});

/* ---------------- Zarr ---------------- */

console.log('\n[zarr]');

await test('Zarr: drop one of two vars', async () => {
  const fx = buildZarrFixture();
  const r = await slim(fx, { variables: ['temperature'] });
  assert(r.format === 'zarr');
  const m = await scan(r.bytes);
  assert(m.variable_names.includes('temperature'));
  assert(!m.variable_names.includes('precip'));
});

await test('Zarr: aligned time slice updates .zarray shape', async () => {
  const fx = buildZarrFixture();
  const r = await slim(fx, { variables: ['temperature'], t1: 0, t2: 1 });
  assert(r.warnings.length === 0, 'aligned slice should not warn');
  const m = await scan(r.bytes);
  const v = m.variables.find(x => x.name === 'temperature');
  assert(JSON.stringify(v.shape) === '[2,2,2]', 'expected shape [2,2,2], got ' + JSON.stringify(v.shape));
  const e = await extract(r.bytes, { variable: 'temperature', lat: 0, lon: 0, t1: 0, t2: 1 });
  const ts = e.timeseries?.map(p => p.value) ?? [];
  /* chunk c0 = [1,2,3,4, 5,6,7,8] reshaped [2,2,2]; at (y=0,x=0): 1 and 5 */
  assert(JSON.stringify(ts) === '[1,5]', 'expected [1,5], got ' + JSON.stringify(ts));
});

await test('Zarr: time slice crossing chunk boundary surfaces a widening warning', async () => {
  const fx = buildZarrFixture();
  const r = await slim(fx, { variables: ['temperature'], t1: 1, t2: 2 });
  assert(r.warnings.some(w => /widened/.test(w)),
    'expected a widening warning; got ' + JSON.stringify(r.warnings));
});

await test('Zarr: bbox without lat/lon coord arrays throws clearly', async () => {
  const buf = buildZarrFixture();
  let err;
  try { await slim(buf, { variables: ['temperature'], bbox: [-180, -90, 180, 90] }); }
  catch (e) { err = e; }
  assert(err instanceof SlimError, `wrong error: ${err && err.constructor.name}: ${err && err.message}`);
  assert(/lat\/lon/i.test(err.message), `expected lat/lon in message: ${err.message}`);
});

await test('Zarr: unknown variable → VariableNotFoundError', async () => {
  const fx = buildZarrFixture();
  let err;
  try { await slim(fx, { variables: ['NOPE'] }); }
  catch (e) { err = e; }
  assert(err instanceof VariableNotFoundError);
});

/* ---------------- NetCDF4 ---------------- */

console.log('\n[netcdf4]');

const nc4 = await buildNC4Fixture();

await test('NetCDF4: keep tas+time+coords round-trips', async () => {
  if (!nc4) return 'skip';
  const r = await slim(nc4.bytes, { variables: ['tas','time','lat','lon'] });
  assert(r.format === 'netcdf4');
  /* verify via h5wasm direct read */
  const dbg = `_slim_dbg_${Date.now()}.nc`;
  nc4.FS.writeFile(dbg, r.bytes);
  const f = new nc4.h5.File(dbg, 'r');
  const tas = f.get('tas');
  assert(Number(tas.shape[0]) === nc4.NT);
  assert(Number(tas.shape[1]) === nc4.NY);
  assert(Number(tas.shape[2]) === nc4.NX);
  const time = f.get('time');
  assert(Number(time.shape[0]) === nc4.NT);
  f.close(); nc4.FS.unlink(dbg);
});

await test('NetCDF4: time slice cuts axis 0 and preserves coord lengths', async () => {
  if (!nc4) return 'skip';
  const r = await slim(nc4.bytes, { variables: ['tas','time','lat','lon'], t1: 1, t2: 3 });
  const dbg = `_slim_dbg_${Date.now()}.nc`;
  nc4.FS.writeFile(dbg, r.bytes);
  const f = new nc4.h5.File(dbg, 'r');
  const tas = f.get('tas');
  const tasShape = Array.from(tas.shape, x => Number(x));
  assert(JSON.stringify(tasShape) === `[3,${nc4.NY},${nc4.NX}]`,
    'expected tas shape [3, NY, NX], got ' + JSON.stringify(tasShape));
  /* tas raw first value should be original t=1, y=0, x=0 = 200 */
  const v0 = Array.from(tas.value)[0];
  assert(v0 === 200, 'expected first slimmed value 200, got ' + v0);
  const time = f.get('time');
  assert(Number(time.shape[0]) === 3);
  /* lat / lon shapes must be untouched */
  assert(Number(f.get('lat').shape[0]) === nc4.NY);
  assert(Number(f.get('lon').shape[0]) === nc4.NX);
  f.close(); nc4.FS.unlink(dbg);
});

await test('NetCDF4: attributes survive', async () => {
  if (!nc4) return 'skip';
  const r = await slim(nc4.bytes, { variables: ['tas'] });
  const dbg = `_slim_dbg_${Date.now()}.nc`;
  nc4.FS.writeFile(dbg, r.bytes);
  const f = new nc4.h5.File(dbg, 'r');
  const tas = f.get('tas');
  assert(tas.attrs.units?.value === 'K', 'expected tas.units = K');
  f.close(); nc4.FS.unlink(dbg);
});

await test('NetCDF4: unknown variable → VariableNotFoundError', async () => {
  if (!nc4) return 'skip';
  let err;
  try { await slim(nc4.bytes, { variables: ['NOPE'] }); }
  catch (e) { err = e; }
  assert(err instanceof VariableNotFoundError);
});

/* ---------------- TIFF (v2: band selection) ---------------- */
console.log('\n[tiff]');
await test('TIFF slim: keep 1 of 3 bands (LZW + horizontal predictor)', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-multiband-u16-lzw-h-strip-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  const out = await slim(buf, { variables: ['B04_red'] });
  assert(out.format === 'tiff', `format=${out.format}`);
  assert(out.bytes instanceof Uint8Array);
  assert(out.bytes.length < buf.length, `slim should shrink the file (got ${out.bytes.length} vs ${buf.length})`);
  assert(out.stats.variablesKept === 1, `kept=${out.stats.variablesKept}`);
  assert(out.stats.variablesDropped === 2, `dropped=${out.stats.variablesDropped}`);
});

await test('TIFF slim: re-scan returns just the kept band', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-multiband-u16-lzw-h-strip-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  const out = await slim(buf, { variables: ['B04_red'] });
  const m = await scan(out.bytes);
  assert(m.format === 'tiff');
  assert(m.variable_names.length === 1, `expected 1 band, got ${m.variable_names.length}`);
  assert(m.variable_names[0] === 'B04_red', `got name '${m.variable_names[0]}'`);
});

await test('TIFF slim: kept band values match the original', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-multiband-u16-lzw-h-strip-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  const orig = await extract(buf, { variable: 'B04_red', lat: 23.5, lon: 10.5 });
  const out  = await slim(buf, { variables: ['B04_red'] });
  const slimmed = await extract(out.bytes, { variable: 'B04_red', lat: 23.5, lon: 10.5 });
  assert(orig.value === slimmed.value,
    `band value drift after slim: orig=${orig.value}, slimmed=${slimmed.value}`);
});

await test('TIFF slim: unknown variable throws VariableNotFoundError', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-multiband-u16-lzw-h-strip-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  let err;
  try { await slim(buf, { variables: ['NOPE'] }); }
  catch (e) { err = e; }
  assert(err instanceof VariableNotFoundError,
    `wrong error: ${err && err.constructor.name}: ${err && err.message}`);
});

await test('TIFF slim: spatial bbox clips a tile-layout COG to a smaller window', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-f32-none-tile-cog-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  // Source: 64×64 single-band Float32, tiles 16×16. Drop to ~16×16 window
  // (one tile in each direction) by asking for bbox [16, 32, 32, 48] in WGS84.
  // (Source covers [0, 0, 64, 64] in degrees.)
  const out = await slim(buf, { variables: ['band_1'], bbox: [16, 32, 32, 48] });
  assert(out.bytes.length < buf.length, `bbox slim should shrink the file (got ${out.bytes.length} vs ${buf.length})`);
  const m = await scan(out.bytes);
  // After clipping (snapped to tile grid), the width/height should be 16.
  assert(m.width === 16,  `expected width=16 after bbox clip, got ${m.width}`);
  assert(m.height === 16, `expected height=16 after bbox clip, got ${m.height}`);
});

await test('TIFF slim: planar=2 byte-copies the kept band group (no re-encode)', async () => {
  const tiffPath = resolve(root, 'examples/testfile/tiff/synthetic-multiband-u16-planar2-strip-wgs84.tif');
  if (!existsSync(tiffPath)) return 'skip';
  const buf = new Uint8Array(readFileSync(tiffPath));
  const out = await slim(buf, { variables: ['green'] });
  const m = await scan(out.bytes);
  assert(m.variable_names.length === 1, `expected 1 band, got ${m.variable_names.length}`);
  assert(m.variable_names[0] === 'green');
  // The kept band's pixel value at (row=0, col=0) was 200 in the source.
  const r = await extract(out.bytes, { variable: 'green', lat: 23.5, lon: 10.5 });
  assert(r.value === 200, `expected 200, got ${r.value}`);
});

/* ---------------- Summary ---------------- */

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
