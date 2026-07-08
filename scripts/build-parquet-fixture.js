#!/usr/bin/env node
import { parquetWriteBuffer } from 'hyparquet-writer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'testfile', 'parquet');
mkdirSync(OUT, { recursive: true });

function wkbPoint(lon, lat) {
  const b = new Uint8Array(21);
  const dv = new DataView(b.buffer);
  b[0] = 1;
  dv.setUint32(1, 1, true);
  dv.setFloat64(5, lon, true);
  dv.setFloat64(13, lat, true);
  return b;
}

function kv(meta) {
  if (!meta) return undefined;
  return Object.entries(meta).map(([key, value]) => ({ key, value }));
}

function write(name, columnData, kvMetadata, opts = {}) {
  const buf = parquetWriteBuffer({ columnData, kvMetadata: kv(kvMetadata), statistics: true, ...opts });
  writeFileSync(join(OUT, name), Buffer.from(buf));
}

const lats = [10, 20, 30], lons = [0, 1, 2, 3], times = [0, 86400];
const mLat = [], mLon = [], mT = [], mV = [];
for (const t of times) for (const la of lats) for (const lo of lons) {
  mLat.push(la); mLon.push(lo); mT.push(BigInt(t)); mV.push(la * 100 + lo + t / 86400);
}
write('mesh.parquet', [
  { name: 'lat', data: mLat, type: 'DOUBLE' },
  { name: 'lon', data: mLon, type: 'DOUBLE' },
  { name: 'time', data: mT, type: 'INT64' },
  { name: 'v', data: mV, type: 'DOUBLE' },
]);

const sLat = [11.3, 22.7, 30.1, 12.9, 28.4], sLon = [0.2, 1.8, 2.2, 3.1, 0.9];
const scLat = [], scLon = [], scT = [], scV = [];
for (const t of times) for (let i = 0; i < 5; i++) {
  scLat.push(sLat[i]); scLon.push(sLon[i]); scT.push(BigInt(t)); scV.push(i + 1 + t / 86400);
}
write('scatter.parquet', [
  { name: 'lat', data: scLat, type: 'DOUBLE' },
  { name: 'lon', data: scLon, type: 'DOUBLE' },
  { name: 'time', data: scT, type: 'INT64' },
  { name: 'v', data: scV, type: 'DOUBLE' },
]);

write('geo_point.parquet', [
  { name: 'geometry', data: sLat.map((la, i) => wkbPoint(sLon[i], la)), type: 'BYTE_ARRAY' },
  { name: 'v', data: [1, 2, 3, 4, 5], type: 'DOUBLE' },
], { geo: JSON.stringify({ version: '1.0.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB', geometry_types: ['Point'] } } }) });

write('geo_utm.parquet', [
  { name: 'geometry', data: [wkbPoint(500000, 5000000), wkbPoint(510000, 5010000)], type: 'BYTE_ARRAY' },
  { name: 'v', data: [1, 2], type: 'DOUBLE' },
], { geo: JSON.stringify({ version: '1.0.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB', geometry_types: ['Point'], crs: { id: { authority: 'EPSG', code: 32633 } } } } }) });

const idx = [...mV.keys()];
const shuffled = [...idx].sort((a, b) => ((a * 17 + 11) % 23) - ((b * 17 + 11) % 23));
const pick = (arr, order) => order.map(i => arr[i]);
const cols = (order) => [
  { name: 'lat', data: pick(mLat, order), type: 'DOUBLE' },
  { name: 'lon', data: pick(mLon, order), type: 'DOUBLE' },
  { name: 'time', data: pick(mT, order), type: 'INT64' },
  { name: 'v', data: pick(mV, order), type: 'DOUBLE' },
];
write('sorted_time.parquet', cols(idx), undefined, { rowGroupSize: 4 });
write('unsorted_time.parquet', cols(shuffled), undefined, { rowGroupSize: 4 });

console.log('parquet fixtures written to', OUT);

