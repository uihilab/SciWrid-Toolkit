/*
 * config-smoke.mjs — tiny mixed-format smoke test to validate that each
 * format's path runs through the harness, and (key) that COG/TIFF engages the
 * Range path (partial transfer) while monolithic formats download whole.
 * Uses fixtures already in the repo. Not a scaling study.
 */
export default {
  modes: ['memory', 'naive', 'range'],
  queries: ['point', 'window'],
  windowPx: { width: 64, height: 64 },
  windowFraction: 0.25,
  reps: 2,
  warmup: 1,
  outDir: 'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks',
  files: [
    { label: 'grib2-40MB', format: 'grib2', path: 'examples/timeseries/gfs.t06z.pgrb2.1p00.f000' },
    { label: 'zarr-zip',   format: 'zarr',  path: 'examples/testfile/sample-zarr-rich.zarr.zip' },
    { label: 'cog-fixture', format: 'tiff', path: 'examples/testfile/tiff/synthetic-f32-none-tile-cog-wgs84.tif' },
  ],
};
