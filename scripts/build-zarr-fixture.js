/*
 * build-zarr-fixture.js — generate a richer Zarr v2 (zip) test fixture.
 *
 * Produces examples/testfile/sample-zarr-rich.zarr.zip: a multi-variable,
 * multi-timestep store with real time/lat/lon coordinate arrays. Every ZIP
 * entry — including the .zarray/.zattrs/.zgroup metadata — is DEFLATE-
 * compressed (method 8), matching what real-world tools (zarr ZipStore with
 * ZIP_DEFLATED, `zip -r`, PowerShell Compress-Archive) emit. This is the
 * shape that today's `slim()` chokes on, so the file is both a usable demo
 * input and a faithful round-trip regression vehicle.
 *
 * Layout:
 *   .zgroup
 *   time/        shape [24]        <f8  (epoch seconds, hourly)
 *   lat/         shape [90]        <f4  (+89.0 .. -89.0, north->south)
 *   lon/         shape [180]       <f4  (-179.0 .. +179.0)
 *   temperature/ shape [24,90,180] <f4  chunks [6,90,180]   (4 time chunks)
 *   precip/      shape [24,90,180] <f4  chunks [6,90,180]
 *
 * Coordinate arrays are single-chunk and use compressor=null so the bbox
 * path can read them. Data chunks also use compressor=null (raw little-endian
 * float32) to keep the fixture self-contained (no numcodecs needed).
 *
 * Run:  node scripts/build-zarr-fixture.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');
const OUT       = resolve(root, 'examples/testfile/sample-zarr-rich.zarr.zip');

const enc = new TextEncoder();
const json = (o) => enc.encode(JSON.stringify(o, null, 4));

/* ── grid ─────────────────────────────────────────────────────────────── */
const NT = 24, NLAT = 90, NLON = 180;
const TCHUNK = 6;                      // 4 chunks along time

function f32(values) {
  const a = new Float32Array(values.length);
  a.set(values);
  return new Uint8Array(a.buffer);
}
function f64(values) {
  const a = new Float64Array(values.length);
  a.set(values);
  return new Uint8Array(a.buffer);
}

/* coordinate arrays */
const timeVals = Array.from({ length: NT }, (_, t) => 1_700_000_000 + t * 3600);
const latVals  = Array.from({ length: NLAT }, (_, j) => 89 - j * (178 / (NLAT - 1)));   // N->S
const lonVals  = Array.from({ length: NLON }, (_, i) => -179 + i * (358 / (NLON - 1)));

/* data: smooth fields so they compress realistically */
function field(base, amp) {
  // returns one [NT,NLAT,NLON] flat Float32Array
  const out = new Float32Array(NT * NLAT * NLON);
  let k = 0;
  for (let t = 0; t < NT; t++) {
    const phase = (t / NT) * 2 * Math.PI;
    for (let j = 0; j < NLAT; j++) {
      const latRad = (latVals[j] * Math.PI) / 180;
      for (let i = 0; i < NLON; i++) {
        const lonRad = (lonVals[i] * Math.PI) / 180;
        out[k++] = base + amp * Math.cos(latRad) * Math.sin(lonRad + phase);
      }
    }
  }
  return out;
}
const temperature = field(273.15, 30);   // Kelvin-ish
const precip      = field(5, 5);          // mm-ish

/* slice a [NT,NLAT,NLON] flat array into time-chunk byte payloads */
function timeChunks(flat) {
  const chunks = [];
  const sliceLen = NLAT * NLON;
  for (let c = 0; c * TCHUNK < NT; c++) {
    const t0 = c * TCHUNK;
    const t1 = Math.min(NT, t0 + TCHUNK);
    const buf = new Float32Array((t1 - t0) * sliceLen);
    buf.set(flat.subarray(t0 * sliceLen, t1 * sliceLen));
    chunks.push({ key: `${c}.0.0`, bytes: new Uint8Array(buf.buffer) });
  }
  return chunks;
}

function zarray(shape, chunks, dtype) {
  return {
    zarr_format: 2, shape, chunks, dtype,
    compressor: null, fill_value: null, order: 'C',
    filters: null, dimension_separator: '.',
  };
}

/* ── assemble entries ─────────────────────────────────────────────────── */
const entries = [
  { name: '.zgroup', bytes: json({ zarr_format: 2 }) },

  { name: 'time/.zarray', bytes: json(zarray([NT], [NT], '<f8')) },
  { name: 'time/.zattrs', bytes: json({ _ARRAY_DIMENSIONS: ['time'], units: 'seconds since 1970-01-01' }) },
  { name: 'time/0',       bytes: f64(timeVals) },

  { name: 'lat/.zarray', bytes: json(zarray([NLAT], [NLAT], '<f4')) },
  { name: 'lat/.zattrs', bytes: json({ _ARRAY_DIMENSIONS: ['lat'], units: 'degrees_north' }) },
  { name: 'lat/0',       bytes: f32(latVals) },

  { name: 'lon/.zarray', bytes: json(zarray([NLON], [NLON], '<f4')) },
  { name: 'lon/.zattrs', bytes: json({ _ARRAY_DIMENSIONS: ['lon'], units: 'degrees_east' }) },
  { name: 'lon/0',       bytes: f32(lonVals) },
];

for (const [vname, flat, units] of [
  ['temperature', temperature, 'K'],
  ['precip', precip, 'mm'],
]) {
  entries.push({ name: `${vname}/.zarray`, bytes: json(zarray([NT, NLAT, NLON], [TCHUNK, NLAT, NLON], '<f4')) });
  entries.push({ name: `${vname}/.zattrs`, bytes: json({ _ARRAY_DIMENSIONS: ['time', 'lat', 'lon'], units }) });
  for (const ch of timeChunks(flat))
    entries.push({ name: `${vname}/${ch.key}`, bytes: ch.bytes });
}

/* ── write a DEFLATE-compressed ZIP (method 8 for every entry) ─────────── */
function buildZip(items) {
  const locals = [], cds = [];
  let off = 0;
  for (const it of items) {
    const nameB = enc.encode(it.name);
    const comp  = deflateRawSync(it.bytes);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 8, true);                     // method = deflate
    dv.setUint32(14, 0, true);                    // CRC (reader ignores)
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, it.bytes.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    locals.push(lh, comp);

    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, it.bytes.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, off, true);
    cd.set(nameB, 46);
    cds.push(cd);

    off += lh.length + comp.length;
  }
  let cdSize = 0;
  for (const c of cds) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);

  const out = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of cds)    { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

mkdirSync(dirname(OUT), { recursive: true });
const zip = buildZip(entries);
writeFileSync(OUT, zip);
console.log(`Wrote ${OUT}`);
console.log(`  ${entries.length} entries, ${(zip.length / 1024).toFixed(0)} KB`);
console.log(`  variables: temperature, precip (+ coords time/lat/lon)`);
console.log(`  grid: time=${NT} lat=${NLAT} lon=${NLON}, time chunks of ${TCHUNK}`);
