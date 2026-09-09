/*
 * lib/encode/netcdf3.js — write a Dataset as a NetCDF-3 classic (CDF-1) file.
 *
 * Two layouts, both CF-1.8:
 *
 *   grid    lat(lat), lon(lon), <var>(lat, lon)          — no record dimension
 *   series  lat(lat=1), lon(lon=1), time(time), <var>(time, lat, lon)
 *           with time as the UNLIMITED dimension, so the file reads as a
 *           station time series rather than a stack of bands.
 *
 * MISSING DATA is written as an IEEE NaN rather than the CF default fill
 * (9.96921e36) with a _FillValue attribute. Both are legal; NaN is the one
 * that survives a round-trip through every reader without the reader having
 * to apply _FillValue, and xarray/ncdump show it as missing either way.
 *
 * Byte layout and the header grammar: see lib/encode/cdf-writer.js.
 */
import {
  HeaderWriter, pad4, NC_TYPE, TYPE_SIZE,
  TAG_ABSENT, TAG_NC_DIMENSION, TAG_NC_VARIABLE,
} from './cdf-writer.js';
import { TIME_UNITS } from './dataset.js';

const MAGIC = Uint8Array.of(0x43, 0x44, 0x46, 0x01);   /* 'CDF' + version 1 */

function f32be(values) {
  const b = new Uint8Array(values.length * 4);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], false);
  return b;
}

function f64be(values) {
  const b = new Uint8Array(values.length * 8);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, values[i], false);
  return b;
}

function padTo4(bytes) {
  const pad = pad4(bytes.length);
  if (!pad) return bytes;
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes, 0);
  return out;
}

/*
 * Assemble a file from a declarative description.
 *
 *   dims    [ { name, length } ]            length 0 marks the record dim
 *   vars    [ { name, type, dimIds, attrs, bytes?, slabs? } ]
 *             bytes  — a fixed variable's whole array
 *             slabs  — a record variable's per-record slabs, one per record
 *   numrecs  record count (0 when there is no record dimension)
 */
function assemble({ numrecs, dims, gatts, vars }) {
  const hw = new HeaderWriter(1);
  hw.push(MAGIC);
  hw.u32(numrecs);

  /* dim_list */
  if (!dims.length) { hw.u32(TAG_ABSENT); hw.u32(0); } else {
    hw.u32(TAG_NC_DIMENSION);
    hw.u32(dims.length);
    for (const d of dims) { hw.writeName(d.name); hw.u32(d.length); }
  }

  /* gatt_list */
  hw.writeAttrList(gatts);

  /* var_list */
  if (!vars.length) { hw.u32(TAG_ABSENT); hw.u32(0); } else {
    hw.u32(TAG_NC_VARIABLE);
    hw.u32(vars.length);
    vars.forEach((v, i) => {
      hw.writeName(v.name);
      hw.u32(v.dimIds.length);
      for (const id of v.dimIds) hw.u32(id);
      hw.writeAttrList(v.attrs);
      hw.u32(v.type);
      /* vsize: a fixed variable's whole array, or one record's slab, padded */
      const vsize = v.slabs
        ? padTo4(v.slabs[0] ?? new Uint8Array(TYPE_SIZE[v.type])).length
        : padTo4(v.bytes).length;
      hw.u32(vsize);
      hw.writeBeginPlaceholder(i);
    });
  }

  const header = hw.build();

  /* Offsets: fixed variables contiguously after the header, then the record
   * block, where record r holds every record variable's slab in order. */
  const begins = new Array(vars.length);
  let offset = header.length;
  vars.forEach((v, i) => {
    if (v.slabs) return;
    begins[i] = offset;
    offset += padTo4(v.bytes).length;
  });
  const recordStart = offset;
  let recsize = 0;
  vars.forEach((v, i) => {
    if (!v.slabs) return;
    begins[i] = recordStart + recsize;
    recsize += padTo4(v.slabs[0] ?? new Uint8Array(TYPE_SIZE[v.type])).length;
  });

  const total = recordStart + recsize * numrecs;
  const out = new Uint8Array(total);
  out.set(header, 0);
  vars.forEach((v, i) => {
    hw.patchBegin(out.subarray(0, header.length), i, begins[i]);
    if (v.slabs) {
      v.slabs.forEach((slab, r) => out.set(padTo4(slab), begins[i] + r * recsize));
    } else {
      out.set(padTo4(v.bytes), begins[i]);
    }
  });
  return out;
}

function writeGrid(dataset) {
  const { lat, lon } = dataset.coords;
  const dims = [{ name: 'lat', length: lat.length }, { name: 'lon', length: lon.length }];
  const vars = [
    { name: 'lat', type: NC_TYPE.float, dimIds: [0], bytes: f32be(lat),
      attrs: { units: 'degrees_north', standard_name: 'latitude', axis: 'Y' } },
    { name: 'lon', type: NC_TYPE.float, dimIds: [1], bytes: f32be(lon),
      attrs: { units: 'degrees_east', standard_name: 'longitude', axis: 'X' } },
  ];
  for (const v of dataset.vars) {
    vars.push({
      name: v.name, type: NC_TYPE.float, dimIds: [0, 1], bytes: f32be(v.data),
      attrs: { units: v.units, coordinates: 'lat lon' },
    });
  }
  return assemble({ numrecs: 0, dims, gatts: dataset.attrs, vars });
}

function writeSeries(dataset) {
  const { time, lat, lon } = dataset.coords;
  const nt = time.length;
  /* dim 0 is the record dimension: length 0 in the header, numrecs elsewhere */
  const dims = [
    { name: 'time', length: 0 },
    { name: 'lat',  length: lat.length },
    { name: 'lon',  length: lon.length },
  ];
  const v = dataset.vars[0];
  const vars = [
    { name: 'lat', type: NC_TYPE.float, dimIds: [1], bytes: f32be(lat),
      attrs: { units: 'degrees_north', standard_name: 'latitude', axis: 'Y' } },
    { name: 'lon', type: NC_TYPE.float, dimIds: [2], bytes: f32be(lon),
      attrs: { units: 'degrees_east', standard_name: 'longitude', axis: 'X' } },
    { name: 'time', type: NC_TYPE.double, dimIds: [0],
      slabs: Array.from({ length: nt }, (_, r) => f64be([time[r]])),
      attrs: { units: TIME_UNITS, calendar: 'standard', standard_name: 'time', axis: 'T' } },
    { name: v.name, type: NC_TYPE.float, dimIds: [0, 1, 2],
      slabs: Array.from({ length: nt }, (_, r) => f32be([v.data[r]])),
      attrs: { units: v.units, coordinates: 'time lat lon' } },
  ];
  return assemble({ numrecs: nt, dims, gatts: dataset.attrs, vars });
}

export function encodeDatasetNetCDF3(dataset) {
  return dataset.kind === 'series' ? writeSeries(dataset) : writeGrid(dataset);
}
