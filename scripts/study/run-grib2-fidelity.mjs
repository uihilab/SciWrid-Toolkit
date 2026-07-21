#!/usr/bin/env node
/**
 * scripts/study/run-grib2-fidelity.mjs — SciWrid's WASM GRIB2 decoder against
 * eccodes ground truth on a real, unmodified Stage IV file.
 *
 * Two things are checked, and the second matters more:
 *   1. values agree at unmasked cells;
 *   2. both agree on WHICH cells are masked.
 *
 * Stage IV masks ~40% of its grid (ocean / outside CONUS) with a Section-6
 * bitmap. A decoder that gets unmasked values right but mishandles the bitmap
 * produces plausible-looking precipitation over the ocean -- exactly the
 * failure a values-only comparison hides.
 *
 * Run: node --max-old-space-size=8192 scripts/study/run-grib2-fidelity.mjs
 */
import { readFileSync } from 'node:fs';
import { scan, extract } from '../../lib/sciwrid-api.js';
import { loadFile, pointValue, resolveVariable, writeJSON } from './io.mjs';
import { OUT_DIR, PRODUCTS } from './study-config.mjs';

const ref = JSON.parse(readFileSync(`${OUT_DIR}/grib2-reference.json`, 'utf8'));
const src = await loadFile(PRODUCTS.stage4.path);
const varName = resolveVariable(await scan(src), PRODUCTS.stage4.variable);
console.log(`file=${ref.file}  variable="${varName}"  reference=eccodes ${ref.eccodesVersion}`);

const rows = [];
for (const p of ref.points) {
  let sciwrid = null, error = null;
  try {
    const r = await extract(src, { variable: varName, lat: p.lat, lon: p.lon });
    const v = pointValue(r);
    sciwrid = Number.isFinite(v) ? v : null;   // NaN / null both mean masked
  } catch (e) { error = e.message; }

  const bothMasked  = sciwrid === null && p.value === null;
  const bothPresent = sciwrid !== null && p.value !== null;
  rows.push({
    index: p.index, lat: p.lat, lon: p.lon,
    eccodes: p.value, sciwrid, error,
    expectedMasked: p.masked,
    maskAgrees: bothMasked || bothPresent,
    absDiff: bothPresent ? Math.abs(sciwrid - p.value) : null,
  });
}

const compared = rows.filter((r) => r.absDiff !== null);
const summary = {
  n: rows.length,
  nCompared: compared.length,
  nMaskedInReference: rows.filter((r) => r.expectedMasked).length,
  maskDisagreements: rows.filter((r) => !r.maskAgrees).length,
  exact: compared.filter((r) => r.absDiff === 0).length,
  maxAbsDiff: compared.length ? Math.max(...compared.map((r) => r.absDiff)) : null,
  meanAbsDiff: compared.length
    ? compared.reduce((a, r) => a + r.absDiff, 0) / compared.length : null,
  errors: rows.filter((r) => r.error).length,
};

const cell = (v) => (v === null ? '  masked' : v.toFixed(5).padStart(9));
console.log('\n     lat        lon      eccodes    sciwrid     |diff|');
for (const r of rows) {
  console.log(
    `${r.lat.toFixed(3).padStart(8)} ${r.lon.toFixed(3).padStart(10)}  ` +
    `${cell(r.eccodes)}  ${cell(r.sciwrid)}  ` +
    `${r.absDiff === null ? '        -' : r.absDiff.toExponential(2).padStart(9)}` +
    `${r.maskAgrees ? '' : '   <-- MASK DISAGREES'}` +
    `${r.error ? '   ERR: ' + r.error.slice(0, 40) : ''}`);
}
console.log('\nsummary:', JSON.stringify(summary, null, 2));

writeJSON(`${OUT_DIR}/grib2-fidelity-report.json`, {
  file: ref.file, grid: { nx: ref.nx, ny: ref.ny },
  reference: `eccodes ${ref.eccodesVersion}`,
  variableUsed: varName, summary, rows,
});
