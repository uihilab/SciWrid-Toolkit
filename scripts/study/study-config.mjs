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

/* Sample sites inside the AORC bbox [-106.49, 25.01, -79.00, 37.50].
 * Chosen to span the wet Gulf coast, the dry southwest, and the interior. */
export const SITES = [
  { name: 'New Orleans, LA', lat: 30.00,  lon: -90.10 },
  { name: 'Houston, TX',     lat: 29.75,  lon: -95.36 },
  { name: 'Dallas, TX',      lat: 32.78,  lon: -96.80 },
  { name: 'Atlanta, GA',     lat: 33.75,  lon: -84.39 },
  { name: 'Memphis, TN',     lat: 35.15,  lon: -90.05 },
  { name: 'Midland, TX',     lat: 31.997, lon: -102.08 },
  { name: 'Tallahassee, FL', lat: 30.44,  lon: -84.28 },
  { name: 'Little Rock, AR', lat: 34.75,  lon: -92.29 },
];

/* Shared comparison window: inside the AORC bbox, over the southern US. */
export const DOMAIN = { west: -106.0, south: 25.5, east: -80.0, north: 37.0 };

/* Grid used for cross-product agreement. GLDAS is the coarser product at
 * 0.25 deg, so it sets the common grid and AORC is aggregated onto it. */
export const COMMON_GRID = { resolutionDeg: 0.25 };
