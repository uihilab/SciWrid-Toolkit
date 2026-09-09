/*
 * lib/encode/netcdf4.js — write a Dataset as NetCDF-4 (HDF5), via h5wasm.
 *
 * Layout mirrors the NetCDF-3 writer:
 *   grid    lat(lat), lon(lon), <var>(lat, lon)
 *   series  lat(1), lon(1), time(time), <var>(time, lat, lon), CF time units
 *
 * ── A LIMITATION YOU SHOULD KNOW ABOUT ──────────────────────────────────
 * netCDF-C names a variable's dimensions from the HDF5 attribute
 * DIMENSION_LIST, whose type is H5T_VLEN{H5T_REFERENCE}: one variable-length
 * sequence of object references per axis. h5wasm's create_attribute marks
 * `vlen` only for strings (see dtype_to_metadata in its hdf5_hl.js), so that
 * type cannot be expressed through it, and the library takes no dependencies
 * that could write it instead.
 *
 * The consequence: netCDF-C and xarray open these files, read every value and
 * attribute correctly, and report the dimensions as `phony_dim_0`,
 * `phony_dim_1`, … rather than lat/lon/time. Coordinates are present as
 * variables but are not attached as coordinate axes.
 *
 * What this writer must NOT do is emit DIMENSION_LIST as a plain (non-VLEN)
 * array of references. That is accepted by the HDF5 writer and then
 * SEGFAULTS netCDF-C on open — measured, 2026-09-09, netCDF4 1.7.4. A file
 * that crashes the reference reader is worse than one with anonymous
 * dimensions, so the attribute is deliberately absent. `.testkit/
 * test-encode-netcdf4.js` asserts it stays absent.
 *
 * CLASS=DIMENSION_SCALE / NAME / _Netcdf4Dimid are still written: they are
 * correct HDF5 dimension-scale metadata, they are what this library's own
 * reader and h5py use, and netCDF-C tolerates them.
 *
 * For a fully conformant file with named dimensions, export 'netcdf3'.
 */
import { loadH5wasm } from '../hdf5/load-h5wasm.js';
import { h5TempName } from '../hdf5/vfs-name.js';
import { TIME_UNITS } from './dataset.js';

/* h5wasm writes NaN faithfully, so missing data needs no fill sentinel —
 * the same choice the NetCDF-3 writer makes, for the same reason. */

function putAttrs(obj, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'string') obj.create_attribute(k, v, [], 'S');
    else if (typeof v === 'number') obj.create_attribute(k, new Float64Array([v]), [], '<f8');
  }
}

export async function encodeDatasetNetCDF4(dataset, opts = {}) {
  const { h5, FS } = await loadH5wasm(opts.h5wasmUrl);
  const fname = h5TempName('_wp_encode', '.nc');

  let f = null;
  try {
    f = new h5.File(fname, 'w');

    const series = dataset.kind === 'series';
    const { lat, lon, time } = dataset.coords;

    /* coordinate datasets, in dimension order */
    const axes = series
      ? [['time', time, '<f8', { units: TIME_UNITS, calendar: 'standard',
                                 standard_name: 'time', axis: 'T' }],
         ['lat', lat, '<f4', { units: 'degrees_north', standard_name: 'latitude', axis: 'Y' }],
         ['lon', lon, '<f4', { units: 'degrees_east', standard_name: 'longitude', axis: 'X' }]]
      : [['lat', lat, '<f4', { units: 'degrees_north', standard_name: 'latitude', axis: 'Y' }],
         ['lon', lon, '<f4', { units: 'degrees_east', standard_name: 'longitude', axis: 'X' }]];

    axes.forEach(([name, values, dtype, attrs], dimid) => {
      f.create_dataset({ name, data: values, shape: [values.length], dtype });
      const ds = f.get(name);
      /* HDF5 dimension-scale metadata. Correct on its own terms; see the note
       * at the top of this file for why DIMENSION_LIST does not join it. */
      ds.create_attribute('CLASS', 'DIMENSION_SCALE', [], 'S');
      ds.create_attribute('NAME', name, [], 'S');
      ds.create_attribute('_Netcdf4Dimid', new Int32Array([dimid]), [], '<i4');
      putAttrs(ds, attrs);
    });

    const shape = series
      ? [dataset.dims.time, dataset.dims.lat, dataset.dims.lon]
      : [dataset.dims.lat, dataset.dims.lon];

    for (const v of dataset.vars) {
      f.create_dataset({ name: v.name, data: v.data, shape, dtype: '<f4' });
      putAttrs(f.get(v.name), {
        units: v.units,
        coordinates: series ? 'time lat lon' : 'lat lon',
      });
    }

    putAttrs(f, dataset.attrs);

    f.flush();
    f.close();
    f = null;
    return FS.readFile(fname);
  } finally {
    if (f) { try { f.close(); } catch { /* already closed */ } }
    try { FS.unlink(fname); } catch { /* never created */ }
  }
}
