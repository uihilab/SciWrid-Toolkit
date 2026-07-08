#!/usr/bin/env node
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { decodePointWKB } from '../lib/parquet/geometry.js';
import { parseGeoMetadata, resolveColumnRoles } from '../lib/parquet/metadata.js';
import { classifyGrid, groupTimes, nearestPointSeries, pivotMesh, rasterizeMeanBin } from '../lib/parquet/spatialize.js';
import * as pq from '../lib/parquet-helper.js';
import * as sciwrid from '../lib/sciwrid-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixture = (name) => new Uint8Array(readFileSync(resolve(root, 'examples/testfile/parquet', name)));

function wkbPoint(lon, lat) {
  const b = new Uint8Array(21);
  const dv = new DataView(b.buffer);
  b[0] = 1;
  dv.setUint32(1, 1, true);
  dv.setFloat64(5, lon, true);
  dv.setFloat64(13, lat, true);
  return b;
}

const p = decodePointWKB(wkbPoint(-90.1, 29.95));
assert.ok(Math.abs(p.lon + 90.1) < 1e-9 && Math.abs(p.lat - 29.95) < 1e-9, 'wkb point');
const poly = wkbPoint(0, 0); new DataView(poly.buffer).setUint32(1, 3, true);
assert.throws(() => decodePointWKB(poly), /Polygon|geometry/i, 'non-point rejected');
console.log('ok: geometry');

let r = resolveColumnRoles(['latitude', 'LON', 'time', 'temp', 'rh'], null, null);
assert.equal(r.latCol, 'latitude'); assert.equal(r.lonCol, 'LON');
assert.equal(r.timeCol, 'time'); assert.deepEqual(r.valueCols, ['temp', 'rh']);
const geo = parseGeoMetadata([{ key: 'geo', value: JSON.stringify({ primary_column: 'geometry', columns: { geometry: { encoding: 'WKB' } } }) }]);
assert.equal(geo.primaryColumn, 'geometry');
r = resolveColumnRoles(['geometry', 'lat', 'lon', 'v'], geo, null);
assert.equal(r.geometryCol, 'geometry'); assert.ok(r.warnings.length >= 1);
r = resolveColumnRoles(['a', 'b', 'c'], null, { lat: 'a', lon: 'b', variable: 'c' });
assert.equal(r.latCol, 'a'); assert.deepEqual(r.valueCols, ['c']);
assert.throws(() => resolveColumnRoles(['a', 'b'], null, { lat: 'zzz' }), /zzz/);
assert.throws(() => resolveColumnRoles(['x1', 'x2'], null, null), /coordinate or geometry/i);
console.log('ok: metadata roles');

const times = groupTimes([0, 0, 0, 0], 4);
const lat = [10, 10, 20, 20], lon = [0, 1, 0, 1], vals = [100, 101, 200, 201];
const cls = classifyGrid(lat, lon, times.frames, times.times.length);
assert.equal(cls.gridType, 'mesh');
const grid = pivotMesh(lat, lon, vals, times.frames, 1, cls.lats, cls.lons);
assert.deepEqual([...grid], [200, 201, 100, 101]);
const scatter = rasterizeMeanBin([10, 10], [0.1, 0.2], [2, 4], [0, 0], 0, [0, 9, 1, 11], 1, 1);
assert.equal(scatter[0], 3);
const ser = nearestPointSeries([10, 20, 10, 20], [0, 1, 0, 1], [1, 2, 3, 4], [0, 0, 1, 1], 2, 10, 0);
assert.deepEqual([...ser], [1, 3]);
console.log('ok: spatialize');

const meshBuf = fixture('mesh.parquet');
assert.equal(await pq.detectFormat(meshBuf), 'parquet');
let scan = await pq.scan(meshBuf);
let vars = JSON.parse(pq.scanGetVarsJson(scan));
assert.equal(vars[0].name, 'v');
assert.equal(vars[0].gridType, 'mesh');
assert.deepEqual(pq.geoBbox(scan), [0, 10, 3, 30]);
await pq.scanFree(scan);
console.log('ok: parquet scan');

const geoBuf = fixture('geo_point.parquet');
scan = await pq.scan(geoBuf);
assert.deepEqual(pq.geoBbox(scan), [0.2, 11.3, 3.1, 30.1]);
await pq.scanFree(scan);
console.log('ok: geoparquet scan');

const scatterBuf = fixture('scatter.parquet');
const ts = await pq.extract(scatterBuf, { variable: 'v', lat: 11.3, lon: 0.2 });
assert.deepEqual([...ts.values], [1, 2]);
const sg = await pq.extractGrid(scatterBuf, { variable: 'v', bbox: [0, 10, 4, 31], width: 4, height: 3, t: 0 });
assert.equal(sg.width, 4); assert.equal(sg.data.length, 12);
const mg = await pq.extractGrid(meshBuf, { variable: 'v', bbox: [0, 10, 4, 30], width: 4, height: 3, t: 0 });
assert.equal(mg.data[0], 3000); assert.equal(mg.data[3], 3003);
console.log('ok: parquet extract/grid');

const utmBuf = fixture('geo_utm.parquet');
scan = await pq.scan(utmBuf);
const bb = pq.geoBbox(scan);
assert.ok(bb[0] > 10 && bb[0] < 16 && bb[1] > 40 && bb[1] < 50, 'UTM33N to lon/lat');
await pq.scanFree(scan);
console.log('ok: parquet crs');

assert.equal(await sciwrid.detectFormat(meshBuf), 'parquet');
const sm = await sciwrid.scan(meshBuf);
assert.equal(sm.format, 'parquet');
assert.ok(sm.variables.some(v => v.name === 'v'));
const pg = await sciwrid.extractGrid(meshBuf, { variable: 'v', bbox: [0, 10, 4, 30], width: 4, height: 3, t: 0 });
assert.equal(pg.data[0], 3000);
console.log('ok: public api parquet');
