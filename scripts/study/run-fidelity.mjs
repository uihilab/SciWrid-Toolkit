#!/usr/bin/env node
/**
 * scripts/study/run-fidelity.mjs — extract the same variable at the same
 * sites from every member of the format matrix, through SciWrid.
 *
 * The matrix members were written by Python (see pybench/build_format_matrix.py)
 * so SciWrid is only ever the reader here. If SciWrid were both writer and
 * reader a symmetric bug would cancel out and agreement would prove nothing.
 *
 * Run: node --max-old-space-size=8192 scripts/study/run-fidelity.mjs
 */
import { readFileSync } from 'node:fs';
import { scan, extract } from '../../lib/sciwrid-api.js';
import { loadFile, pointValue, resolveVariable, writeJSON } from './io.mjs';
import { MATRIX_DIR, OUT_DIR, SITES } from './study-config.mjs';

const manifest = JSON.parse(
  readFileSync(`${MATRIX_DIR}/matrix_manifest.json`, 'utf8'));

const members = Object.entries(manifest.members)
  .filter(([, v]) => v && typeof v === 'object')
  .map(([fmt, v]) => ({ fmt, file: `${MATRIX_DIR}/${v.file}` }));

console.log('members:', members.map((m) => m.fmt).join(', '));
console.log('sites  :', SITES.length);

const errors = [];
const sites = SITES.map((s) => ({ ...s, byFormat: {} }));
const variableUsed = {};

for (const { fmt, file } of members) {
  const src = await loadFile(file);
  /* Ask each container what it actually holds. A GeoTIFF is a bare raster
   * whose band is synthesised as `band_1`, so the source variable name does
   * not survive transcoding into every format. */
  const varName = resolveVariable(await scan(src), manifest.variable);
  variableUsed[fmt] = varName;

  for (const site of sites) {
    try {
      const r = await extract(src, {
        variable: varName, lat: site.lat, lon: site.lon,
      });
      const v = pointValue(r);
      site.byFormat[fmt] = Number.isFinite(v) ? v : null;
    } catch (e) {
      site.byFormat[fmt] = null;
      errors.push({ fmt, site: site.name, error: e.message });
    }
  }
  console.log(`  ${fmt.padEnd(9)} variable=${varName.padEnd(8)} done`);
}

writeJSON(`${OUT_DIR}/fidelity-sciwrid.json`, {
  variable: manifest.variable, units: manifest.units,
  variableUsed, sites, errors,
});

if (errors.length) {
  console.log(`\n${errors.length} extraction error(s):`);
  for (const e of errors) console.log(`  ${e.fmt} @ ${e.site}: ${e.error}`);
} else {
  console.log('\nno extraction errors');
}
