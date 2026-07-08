/*
 * scripts/perf/config.mjs — what the perf harness runs.
 *
 * `files` is the size ladder. Each entry is a local path (served over a local
 * Range server) plus a human label. Query parameters (variable / lat / lon /
 * bbox) are auto-derived from scan() metadata when omitted, so the harness runs
 * on any file without hand-tuning — but you can pin them per file for stable,
 * comparable queries across the ladder.
 *
 * >>> Replace the `files` list with your real 50MB / 100MB / 200MB / 500MB /
 *     1GB / 2GB files. Paths are relative to the repo root (or absolute).
 */

export default {
  // Access modes to benchmark (see bench.js). Order is cosmetic.
  modes: ['memory', 'naive', 'range'],

  // Query types, reported in separate tables.
  queries: ['point', 'window'],

  // Fixed query location applied to EVERY file (isolates file size as the only
  // variable). A real land point so GLDAS (land-only) returns finite data.
  // Per-file `lat`/`lon` overrides this; if unset, falls back to extent center.
  point: { lat: 40, lon: -100 },   // central US Great Plains

  // Window query output size (pixels). Cost should track this, not file size.
  windowPx: { width: 128, height: 128 },
  // Window bbox as a fraction of the dataset's full extent, centered on `point`.
  windowFraction: 0.25,

  reps: 3,
  warmup: 1,

  // Where to write the JSON results (kept OUT of the repo, per project rules).
  outDir: 'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks',

  // Cross-format scaling ladders. `format` is cosmetic (the library auto-detects);
  // it groups the output tables. Query params auto-derive from scan() unless pinned.
  files: [
    // --- NetCDF4 / HDF5 (h5wasm JS) — DONE ----------------------------------
    { label: '50MB',  format: 'netcdf4', path: 'E:/gldas_50mb.nc'   },
    { label: '100MB', format: 'netcdf4', path: 'E:/gldas_100mb.nc'  },
    { label: '200MB', format: 'netcdf4', path: 'E:/gldas_200mb.nc'  },
    { label: '500MB', format: 'netcdf4', path: 'E:/gldas_500mb.nc'  },
    { label: '1GB',   format: 'netcdf4', path: 'E:/gldas_1gb.nc'    },
    { label: '2GB',   format: 'netcdf4', path: 'E:/gldas_merged.nc' },

    // --- NetCDF3 (C→WASM)  nccopy -k 64-bit-offset ... ----------------------
    // { label: '50MB',  format: 'netcdf3', path: 'E:/gldas3_50mb.nc3'  },
    // { label: '500MB', format: 'netcdf3', path: 'E:/gldas3_500mb.nc3' },
    // { label: '1GB',   format: 'netcdf3', path: 'E:/gldas3_1gb.nc3'   },

    // --- COG / GeoTIFF (pure JS, Range-native — the divergence line) --------
    // { label: '50MB',  format: 'tiff', path: 'E:/gldas_50mb_cog.tif'  },
    // { label: '500MB', format: 'tiff', path: 'E:/gldas_500mb_cog.tif' },
    // { label: '1GB',   format: 'tiff', path: 'E:/gldas_1gb_cog.tif'   },

    // --- Zarr v2/v3 zip (pure JS, whole-file in current API) ----------------
    // { label: '50MB',  format: 'zarr', path: 'E:/gldas_50mb.zarr.zip'  },
    // { label: '500MB', format: 'zarr', path: 'E:/gldas_500mb.zarr.zip' },

    // --- GRIB2 (C→WASM) — native GFS recommended ----------------------------
    // { label: '40MB',  format: 'grib2', path: 'examples/timeseries/gfs.t06z.pgrb2.1p00.f000' },
    // { label: '172MB', format: 'grib2', path: 'examples/timeseries/gfs_timeseries.grb2' },
  ],
};
