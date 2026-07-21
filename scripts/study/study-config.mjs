/**
 * scripts/study/study-config.mjs — single source of truth for the cross-file
 * comparison study (manuscript Case Study II).
 *
 * Paths are absolute because the study reads real archives that live outside
 * the repo. Nothing here is imported by the library; this is study-only.
 */

export const DOWNLOADS  = 'C:/Users/Khoa Le/Downloads';
export const BENCH      = 'C:/Users/Khoa Le/Documents/Work/docs/webparsers/benchmarks';
export const MATRIX_DIR = `${BENCH}/comparison/matrix`;
export const OUT_DIR    = `${BENCH}/comparison/out`;

/* The AORC day is the anchor: it is the only date for which two independent
 * encodings of the same product already exist on disk. */
export const ANCHOR_DAY = '2001-01-01';

export const PRODUCTS = {
  aorc_nc: {
    label: 'AORC (NetCDF4)',
    path: `${DOWNLOADS}/aorc_20010101_south_states.nc`,
    format: 'netcdf4',
    variable: 'precip',
    unitFactor: 1.0,          // kg/m^2/day === mm/day
    unitOut: 'mm/day',
  },
  aorc_zarr: {
    label: 'AORC (Zarr v2)',
    path: `${DOWNLOADS}/aorc_20010101_south.zarr-20260618T051738Z-3-001.zip`,
    format: 'zarr',
    variable: 'precip',
    unitFactor: 1.0,
    unitOut: 'mm/day',
  },
  gldas: {
    label: 'GLDAS NOAH 0.25 deg (NetCDF4)',
    path: `${DOWNLOADS}/gldas_merged_trim.nc`,
    format: 'netcdf4',
    variable: 'Rainf_tavg',
    unitFactor: 86400.0,      // kg m-2 s-1 -> mm/day
    unitOut: 'mm/day',
  },
  stage4: {
    label: 'Stage IV (GRIB2)',
    path: 'E:/grib2/grb2_conus/st4_conus.2023010100.01h.grb2',
    format: 'grib2',
    variable: 'Total precipitation',
    unitFactor: 1.0,          // mm accumulated over the message period
    unitOut: 'mm',
  },
};

/* Sample sites for the fidelity study.
 *
 * These are NOT arbitrary cities. An earlier draft used eight named metros and
 * every one returned 0.0 mm/day — this field is 35% nonzero with a median of
 * 0.0, so a city list silently produces a test where zero equals zero in every
 * format and nothing is actually compared.
 *
 * Instead the sites are stratified across the observed precipitation
 * distribution: percentiles p0..p100 of the NONZERO cells, plus three cells
 * that are exactly zero so the zero case is still covered. Together they span
 * 0.0 to 6.32 mm/day.
 *
 * Coordinates are exact cell centres of the 0.25 deg matrix grid. That is
 * deliberate: it removes nearest-neighbour tie-breaking at cell boundaries, so
 * any difference between formats is a genuine decode difference rather than a
 * disagreement about which cell to pick. */
export const SITES = [
  { name: 'p0   (near-zero, NM)',   lat: 34.129, lon: -103.872 },
  { name: 'p10  (light, NM)',       lat: 35.379, lon: -105.122 },
  { name: 'p25  (light, TN)',       lat: 36.379, lon:  -88.872 },
  { name: 'p50  (moderate, OK)',    lat: 34.129, lon:  -95.872 },
  { name: 'p75  (moderate, AL)',    lat: 33.879, lon:  -86.873 },
  { name: 'p90  (heavy, TX coast)', lat: 27.379, lon:  -97.622 },
  { name: 'p99  (heavy, LA)',       lat: 32.879, lon:  -92.122 },
  { name: 'p100 (max, TX coast)',   lat: 28.129, lon:  -96.872 },
  { name: 'dry NW corner',          lat: 36.878, lon: -105.872 },
  { name: 'dry interior, TX',       lat: 30.379, lon:  -99.622 },
  { name: 'dry SE corner, FL',      lat: 25.629, lon:  -80.123 },
];

/* Shared comparison window: inside the AORC bbox, over the southern US. */
export const DOMAIN = { west: -106.0, south: 25.5, east: -80.0, north: 37.0 };

/* Grid used for cross-product agreement. GLDAS is the coarser product at
 * 0.25 deg, so it sets the common grid and AORC is aggregated onto it. */
export const COMMON_GRID = { resolutionDeg: 0.25 };
