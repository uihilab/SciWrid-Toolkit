/*
 * make-netcdf3-fixture.js — writes examples/sample.nc3.
 *
 * The repo ships no NetCDF3 fixture, so .testkit/test-api.js skipped that
 * format entirely. This emits a small, valid NetCDF3 Classic file with real
 * CF coordinate variables so scan/extract/extractGrid have something to bite.
 *
 * Run: node scripts/make-netcdf3-fixture.js
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const NC_CHAR = 2, NC_FLOAT = 5;
const NC_DIMENSION = 10, NC_VARIABLE = 11, NC_ATTRIBUTE = 12;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const pad4 = (n) => (n % 4 === 0 ? 0 : 4 - (n % 4));
function name(s) {
  const b = Buffer.from(s, 'latin1');
  return Buffer.concat([u32(b.length), b, Buffer.alloc(pad4(b.length))]);
}
function attr(nm, type, values) {
  const parts = [name(nm), u32(type)];
  if (type === NC_CHAR) {
    const b = Buffer.from(values, 'latin1');
    parts.push(u32(b.length), b, Buffer.alloc(pad4(b.length)));
  } else {
    parts.push(u32(values.length));
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeFloatBE(v, i * 4));
    parts.push(b, Buffer.alloc(pad4(b.length)));
  }
  return Buffer.concat(parts);
}
const attrList = (list) => (list.length
  ? Buffer.concat([u32(NC_ATTRIBUTE), u32(list.length), ...list])
  : Buffer.concat([u32(0), u32(0)]));

const dims = [{ n: 'time', size: 3 }, { n: 'lat', size: 4 }, { n: 'lon', size: 5 }];
const dimList = Buffer.concat([
  u32(NC_DIMENSION), u32(dims.length),
  ...dims.map(d => Buffer.concat([name(d.n), u32(d.size)])),
]);

const beF32 = (arr) => {
  const b = Buffer.alloc(arr.length * 4);
  arr.forEach((v, i) => b.writeFloatBE(v, i * 4));
  return b;
};

const temp = new Float32Array(3 * 4 * 5);
for (let t = 0; t < 3; t++)
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 5; x++)
      temp[t * 20 + y * 5 + x] = 280 + t * 5 + y + x * 0.5;

const vars = [
  { n: 'time', dimids: [0], data: beF32(Float32Array.from([0, 6, 12])),
    attrs: [attr('units', NC_CHAR, 'hours since 2020-01-01 00:00:00'), attr('axis', NC_CHAR, 'T')] },
  { n: 'lat', dimids: [1], data: beF32(Float32Array.from([30, 31, 32, 33])),
    attrs: [attr('units', NC_CHAR, 'degrees_north'), attr('axis', NC_CHAR, 'Y')] },
  { n: 'lon', dimids: [2], data: beF32(Float32Array.from([-95, -94, -93, -92, -91])),
    attrs: [attr('units', NC_CHAR, 'degrees_east'), attr('axis', NC_CHAR, 'X')] },
  { n: 'temperature', dimids: [0, 1, 2], data: beF32(temp),
    attrs: [attr('units', NC_CHAR, 'K'), attr('long_name', NC_CHAR, 'Air Temperature')] },
];
for (const v of vars) v.vsize = v.data.length + pad4(v.data.length);

function buildHeader(begins) {
  const varList = Buffer.concat([
    u32(NC_VARIABLE), u32(vars.length),
    ...vars.map((v, i) => Buffer.concat([
      name(v.n), u32(v.dimids.length), ...v.dimids.map(u32),
      attrList(v.attrs), u32(NC_FLOAT), u32(v.vsize), u32(begins[i]),
    ])),
  ]);
  return Buffer.concat([
    Buffer.from([0x43, 0x44, 0x46, 0x01]),
    u32(0),
    dimList,
    attrList([attr('title', NC_CHAR, 'SciWrid NetCDF3 test fixture'),
              attr('Conventions', NC_CHAR, 'CF-1.6')]),
    varList,
  ]);
}

const headerLen = buildHeader(vars.map(() => 0)).length;
let off = headerLen;
const begins = vars.map((v) => { const b = off; off += v.vsize; return b; });

const out = Buffer.concat([
  buildHeader(begins),
  ...vars.map(v => Buffer.concat([v.data, Buffer.alloc(v.vsize - v.data.length)])),
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(root, 'examples/sample.nc3');
writeFileSync(dest, out);
console.log(`wrote ${dest} (${out.length} bytes)`);
