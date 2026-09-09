/*
 * lib/encode/zarr.js — write a Dataset as a Zarr v2 store packed in a ZIP.
 *
 * One chunk per array (chunks === shape) and no compressor: these are
 * extraction results, not archives, and an uncompressed single chunk is the
 * shape every Zarr reader handles without negotiation.
 *
 *   .zgroup                 {"zarr_format": 2}
 *   .zattrs                 dataset.attrs
 *   <name>/.zarray          shape/chunks/dtype/compressor/fill_value/order
 *   <name>/.zattrs          _ARRAY_DIMENSIONS + units
 *   <name>/0[.0[.0]]        the one chunk, little-endian, C order
 *
 * _ARRAY_DIMENSIONS is what lets xarray — and this repo's own Zarr reader —
 * attach lat/lon/time to the data array.
 *
 * Missing data is an IEEE NaN in the chunk, with fill_value "NaN" in the
 * metadata, which is how Zarr v2 spells a float NaN fill.
 */
import { buildZip } from './zip-writer.js';
import { TIME_UNITS } from './dataset.js';

const enc = new TextEncoder();
const json = (obj) => enc.encode(JSON.stringify(obj, null, 2));

function f32le(values) {
  const b = new Uint8Array(values.length * 4);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  return b;
}

function f64le(values) {
  const b = new Uint8Array(values.length * 8);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, values[i], true);
  return b;
}

function zarray(shape, dtype) {
  return {
    zarr_format: 2,
    shape,
    chunks: shape.slice(),          /* one chunk holds the whole array */
    dtype,
    compressor: null,
    fill_value: 'NaN',
    order: 'C',
    filters: null,
    dimension_separator: '.',
  };
}

/* Chunk key for the single chunk: "0" in 1-D, "0.0" in 2-D, "0.0.0" in 3-D. */
const chunkKey = (rank) => new Array(rank).fill('0').join('.');

function array(entries, name, shape, dtype, dims, bytes, attrs = {}) {
  entries.push({ name: `${name}/.zarray`, bytes: json(zarray(shape, dtype)) });
  entries.push({ name: `${name}/.zattrs`,
    bytes: json({ _ARRAY_DIMENSIONS: dims, ...attrs }) });
  entries.push({ name: `${name}/${chunkKey(shape.length)}`, bytes });
}

export function encodeDatasetZarr(dataset) {
  const { coords, dims } = dataset;
  const entries = [
    { name: '.zgroup', bytes: json({ zarr_format: 2 }) },
    { name: '.zattrs', bytes: json(dataset.attrs) },
  ];

  array(entries, 'lat', [dims.lat], '<f4', ['lat'], f32le(coords.lat),
    { units: 'degrees_north', standard_name: 'latitude' });
  array(entries, 'lon', [dims.lon], '<f4', ['lon'], f32le(coords.lon),
    { units: 'degrees_east', standard_name: 'longitude' });
  if (coords.time)
    array(entries, 'time', [dims.time], '<f8', ['time'], f64le(coords.time),
      { units: TIME_UNITS, calendar: 'standard', standard_name: 'time' });

  for (const v of dataset.vars) {
    const shape = v.dims.map((d) => dims[d]);
    array(entries, v.name, shape, '<f4', v.dims, f32le(v.data),
      v.units == null ? {} : { units: v.units });
  }

  return buildZip(entries);
}
