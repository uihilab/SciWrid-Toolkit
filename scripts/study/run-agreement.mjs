#!/usr/bin/env node
/**
 * scripts/study/run-agreement.mjs — AORC vs GLDAS precipitation agreement over
 * the shared southern-US domain for the anchor day (2001-01-01).
 *
 * Both inputs are resampled onto ONE identical grid before pairing, because
 * pairGrids() in examples/map-demo-analysis.js pairs strictly by flat array
 * index and does no coordinate matching at all. Feeding it two differently
 * sized grids silently produces garbage, so the sizes are asserted below.
 *
 * The statistics come from the shipped pearson/meanBias so the paper's numbers
 * and the map demo's numbers cannot drift apart. pairGrids itself is not used:
 * it returns [a, b] tuples and discards coordinates, and the spatial
 * decomposition needs lat/lon. pairGridsWithCoords mirrors its index pairing
 * and additionally derives the cell centres.
 *
 * Sign convention: meanBias is mean(b - a), so with pearson/meanBias fed
 * [aorc, gldas] a POSITIVE bias means GLDAS is the wetter product.
 *
 * Run: node --max-old-space-size=8192 scripts/study/run-agreement.mjs
 */
import { extractGrid } from '../../lib/sciwrid-api.js';
import { pearson, meanBias } from '../../examples/map-demo-analysis.js';
import { loadFile, writeJSON } from './io.mjs';
import { MATRIX_DIR, OUT_DIR, DOMAIN, COMMON_GRID } from './study-config.mjs';

const bbox   = [DOMAIN.west, DOMAIN.south, DOMAIN.east, DOMAIN.north];
const width  = Math.round((DOMAIN.east  - DOMAIN.west ) / COMMON_GRID.resolutionDeg);
const height = Math.round((DOMAIN.north - DOMAIN.south) / COMMON_GRID.resolutionDeg);
const gridOpts = { variable: 'precip', bbox, width, height };

const aorc  = await extractGrid(
  await loadFile(`${MATRIX_DIR}/aorc_subset_nc4.nc`), gridOpts);
const gldas = await extractGrid(
  await loadFile(`${MATRIX_DIR}/gldas_20010101.nc`), gridOpts);

console.log(`common grid : ${width} x ${height} over ${JSON.stringify(bbox)}`);
console.log(`AORC        : ${aorc.width} x ${aorc.height}`);
console.log(`GLDAS       : ${gldas.width} x ${gldas.height}`);

if (aorc.width !== gldas.width || aorc.height !== gldas.height) {
  throw new Error(
    `grids differ (${aorc.width}x${aorc.height} vs ${gldas.width}x${gldas.height}); ` +
    `index pairing would be meaningless`);
}

/* Index pairing plus cell-centre coordinates. North-up: row 0 = maxLat. */
function pairGridsWithCoords(gA, gB) {
  const a = gA.data, b = gB.data;
  const [minLon, minLat, maxLon, maxLat] = gA.bbox;
  const w = gA.width, h = gA.height;
  const dLon = (maxLon - minLon) / w;
  const dLat = (maxLat - minLat) / h;
  const out = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i], bv = b[i];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    const row = Math.floor(i / w), col = i % w;
    out.push({
      lat: maxLat - (row + 0.5) * dLat,
      lon: minLon + (col + 0.5) * dLon,
      a: av, b: bv,
    });
  }
  return out;
}

const located = pairGridsWithCoords(aorc, gldas);
const tuples  = located.map((p) => [p.a, p.b]);

const rmseOf = (rows) => (rows.length
  ? Math.sqrt(rows.reduce((acc, p) => acc + (p.a - p.b) ** 2, 0) / rows.length)
  : null);

const r    = pearson(tuples);
const bias = meanBias(tuples);
const rmse = rmseOf(located);

const fmt = (v, d = 4) => (v === null || v === undefined ? 'null' : v.toFixed(d));
const cover = (100 * located.length / (width * height)).toFixed(1);
console.log(`\nn=${located.length} of ${width * height} cells (${cover}% overlap)`);
console.log(`r=${fmt(r)}   bias(GLDAS-AORC)=${fmt(bias)} mm/day   rmse=${fmt(rmse)} mm/day`);

const meanA = located.reduce((s, p) => s + p.a, 0) / located.length;
const meanB = located.reduce((s, p) => s + p.b, 0) / located.length;
console.log(`mean AORC=${meanA.toFixed(4)}  mean GLDAS=${meanB.toFixed(4)} mm/day`);

/* Spatial decomposition: does agreement depend on where you look? Latitude
 * bands are the cheapest honest cut from the wet Gulf coast to the dry
 * interior southwest. */
const bands = [];
for (let lo = DOMAIN.south; lo < DOMAIN.north; lo += 2.0) {
  const hi  = Math.min(lo + 2.0, DOMAIN.north);
  const sub = located.filter((p) => p.lat >= lo && p.lat < hi);
  if (sub.length >= 10) {
    const t = sub.map((p) => [p.a, p.b]);
    bands.push({
      latMin: lo, latMax: hi, n: sub.length,
      meanAorc:  sub.reduce((s, p) => s + p.a, 0) / sub.length,
      meanGldas: sub.reduce((s, p) => s + p.b, 0) / sub.length,
      pearson: pearson(t), meanBias: meanBias(t), rmse: rmseOf(sub),
    });
  }
}

console.log('\nlat band        n      r       bias    rmse   meanA  meanB');
for (const b of bands) {
  console.log(
    `${b.latMin.toFixed(1)}-${b.latMax.toFixed(1)}  ${String(b.n).padStart(6)}  ` +
    `${fmt(b.pearson, 3).padStart(6)}  ${fmt(b.meanBias, 3).padStart(6)}  ` +
    `${fmt(b.rmse, 3).padStart(5)}  ${b.meanAorc.toFixed(3).padStart(5)}  ` +
    `${b.meanGldas.toFixed(3).padStart(5)}`);
}

writeJSON(`${OUT_DIR}/agreement-report.json`, {
  day: '2001-01-01',
  units: 'mm/day',
  domain: DOMAIN,
  commonGrid: { width, height, resolutionDeg: COMMON_GRID.resolutionDeg, bbox },
  biasConvention: 'meanBias = mean(GLDAS - AORC); positive means GLDAS is wetter',
  products: { a: 'AORC (NetCDF4)', b: 'GLDAS NOAH 0.25 deg (NetCDF4)' },
  n: located.length,
  overlapPercent: Number(cover),
  pearson: r, meanBias: bias, rmse,
  meanAorc: meanA, meanGldas: meanB,
  byLatBand: bands,
  grids: {
    aorc:  { width: aorc.width,  height: aorc.height,  bbox: aorc.bbox },
    gldas: { width: gldas.width, height: gldas.height, bbox: gldas.bbox },
  },
  pairs: located.map((p) => ({ lat: p.lat, lon: p.lon, aorc: p.a, gldas: p.b })),
});
