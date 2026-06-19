#!/usr/bin/env node
// scripts/build-zarr-v3-fixture.js - generate small Zarr v3 ZIP fixtures.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import Zstd from 'numcodecs/zstd';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const OUTDIR = resolve(root, 'examples/testfile');
const enc = new TextEncoder();
const json = (o) => enc.encode(JSON.stringify(o, null, 2));

const NT = 2, NLAT = 4, NLON = 5;
const timeVals = Array.from({ length: NT }, (_, t) => 1_700_000_000 + t * 3600);
const latVals = Array.from({ length: NLAT }, (_, j) => 30 - j);
const lonVals = Array.from({ length: NLON }, (_, i) => -95 + i);

function field() {
  const a = new Float64Array(NT * NLAT * NLON);
  for (let k = 0; k < a.length; k++) a[k] = 273 + (k % 11);
  return a;
}

const f64 = (vals) => new Uint8Array(Float64Array.from(vals).buffer);

function arrayMeta({ shape, chunk, data_type, codecs }) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: chunk } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: data_type.startsWith('float') ? 'NaN' : 0,
    codecs,
    attributes: {},
    dimension_names: shape.length === 1 ? null : ['time', 'lat', 'lon'],
    storage_transformers: [],
  };
}

const ZSTD = [
  { name: 'bytes', configuration: { endian: 'little' } },
  { name: 'zstd', configuration: { level: 3 } },
];
const GZIP = [
  { name: 'bytes', configuration: { endian: 'little' } },
  { name: 'gzip', configuration: { level: 5 } },
];
const RAW_LE = [{ name: 'bytes', configuration: { endian: 'little' } }];
const RAW_BE = [{ name: 'bytes', configuration: { endian: 'big' } }];

async function zstdEnc(u8) {
  const out = await Zstd.fromConfig({ level: 3 }).encode(u8);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
function gzipEnc(u8) { return new Uint8Array(gzipSync(Buffer.from(u8))); }

async function coordEntries(codecs, encFn) {
  const mk = (name, vals, dim) => ([
    {
      name: `${name}/zarr.json`,
      bytes: json({
        ...arrayMeta({ shape: [vals.length], chunk: [vals.length], data_type: 'float64', codecs }),
        dimension_names: [dim],
        attributes: name === 'time' ? { units: 'seconds since 1970-01-01' }
          : name === 'lat' ? { units: 'degrees_north' }
          : { units: 'degrees_east' },
      }),
    },
    { name: `${name}/c/0`, bytes: null, rawVals: vals },
  ]);
  const entries = [...mk('time', timeVals, 'time'), ...mk('lat', latVals, 'lat'), ...mk('lon', lonVals, 'lon')];
  for (const e of entries) {
    if (e.rawVals) {
      e.bytes = await encFn(f64(e.rawVals));
      delete e.rawVals;
    }
  }
  return entries;
}

async function buildStore(prefix, dataCodecs, coordCodecs, coordEncFn, tempBytes, tempDtype) {
  const entries = [
    {
      name: 'zarr.json',
      bytes: json({ zarr_format: 3, node_type: 'group', attributes: {}, consolidated_metadata: null }),
    },
    ...await coordEntries(coordCodecs, coordEncFn),
    {
      name: 'temp/zarr.json',
      bytes: json(arrayMeta({
        shape: [NT, NLAT, NLON],
        chunk: [NT, NLAT, NLON],
        data_type: tempDtype,
        codecs: dataCodecs,
      })),
    },
    { name: 'temp/c/0/0/0', bytes: tempBytes },
  ];
  return entries.map((e) => ({ name: `${prefix}.zarr/${e.name}`, bytes: e.bytes }));
}

function buildZip(items) {
  const locals = [], cds = [];
  let off = 0;
  for (const it of items) {
    const nameB = enc.encode(it.name);
    const comp = deflateRawSync(it.bytes);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 8, true);
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
  for (const c of cds) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

mkdirSync(OUTDIR, { recursive: true });
const tempLE = f64(field());
const tempBE = (() => {
  const i16 = Int16Array.from(field(), (v) => v | 0);
  const u8 = new Uint8Array(i16.length * 2);
  const dv = new DataView(u8.buffer);
  for (let i = 0; i < i16.length; i++) dv.setInt16(i * 2, i16[i], false);
  return u8;
})();

function buildShardedTemp() {
  const flat = field();
  const inner = [1, 2, 5], outer = [2, 4, 5];
  const innerGrid = outer.map((o, i) => Math.ceil(o / inner[i]));
  const nInner = innerGrid.reduce((a, b) => a * b, 1);
  const strides = [NLAT * NLON, NLON, 1];
  const parts = [];
  const index = new BigUint64Array(nInner * 2);
  let cursor = 0, k = 0;

  for (let it = 0; it < innerGrid[0]; it++) {
    for (let ij = 0; ij < innerGrid[1]; ij++) {
      for (let ii = 0; ii < innerGrid[2]; ii++, k++) {
        if (it === 1 && ij === 1) {
          index[k * 2] = 0xFFFFFFFFFFFFFFFFn;
          index[k * 2 + 1] = 0n;
          continue;
        }
        const buf = new Float64Array(inner[0] * inner[1] * inner[2]);
        let w = 0;
        for (let a = 0; a < inner[0]; a++) {
          for (let b = 0; b < inner[1]; b++) {
            for (let c = 0; c < inner[2]; c++) {
              const gt = it * inner[0] + a;
              const gj = ij * inner[1] + b;
              const gi = ii * inner[2] + c;
              if (gt < NT && gj < NLAT && gi < NLON)
                buf[w] = flat[gt * strides[0] + gj * strides[1] + gi * strides[2]];
              w++;
            }
          }
        }
        const bytes = new Uint8Array(buf.buffer);
        parts.push(bytes);
        index[k * 2] = BigInt(cursor);
        index[k * 2 + 1] = BigInt(bytes.length);
        cursor += bytes.length;
      }
    }
  }

  const idxBytes = new Uint8Array(index.buffer);
  const idxWithCrc = new Uint8Array(idxBytes.length + 4);
  idxWithCrc.set(idxBytes, 0);
  const total = new Uint8Array(cursor + idxWithCrc.length);
  let p = 0;
  for (const part of parts) { total.set(part, p); p += part.length; }
  total.set(idxWithCrc, cursor);
  return { bytes: total, inner };
}

const sharded = buildShardedTemp();
const SHARD_CODECS = [{
  name: 'sharding_indexed',
  configuration: {
    chunk_shape: sharded.inner,
    index_location: 'end',
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    index_codecs: [
      { name: 'bytes', configuration: { endian: 'little' } },
      { name: 'crc32c', configuration: {} },
    ],
  },
}];

const stores = [
  ['v3-regular-zstd', ZSTD, ZSTD, zstdEnc, await zstdEnc(tempLE), 'float64'],
  ['v3-gzip', GZIP, GZIP, gzipEnc, gzipEnc(tempLE), 'float64'],
  ['v3-bigendian', RAW_BE, RAW_LE, (b) => b, tempBE, 'int16'],
  ['v3-sharded', SHARD_CODECS, ZSTD, zstdEnc, sharded.bytes, 'float64'],
];

for (const [name, dataCodecs, coordCodecs, coordEncFn, tempBytes, tempDtype] of stores) {
  const zip = buildZip(await buildStore(name, dataCodecs, coordCodecs, coordEncFn, tempBytes, tempDtype));
  const out = resolve(OUTDIR, `${name}.zarr.zip`);
  writeFileSync(out, zip);
  console.log(`Wrote ${out} (${zip.length} bytes)`);
}
