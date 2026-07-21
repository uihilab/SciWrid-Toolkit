#!/usr/bin/env node
/**
 * scripts/study/compare-fidelity.mjs — join the SciWrid and reference
 * extractions and quantify format-to-format fidelity.
 *
 * Two questions, deliberately kept separate:
 *   (a) internal consistency — does SciWrid return the same value for the
 *       same point regardless of which container holds it?
 *   (b) external correctness — does SciWrid agree with an independent reader
 *       of that same container?
 *
 * (a) alone is not enough: SciWrid could be uniformly wrong. (b) is what ties
 * the result to something outside this codebase.
 *
 * Run: node scripts/study/compare-fidelity.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OUT_DIR } from './study-config.mjs';
import { writeJSON } from './io.mjs';

const sw  = JSON.parse(readFileSync(`${OUT_DIR}/fidelity-sciwrid.json`, 'utf8'));
const ref = JSON.parse(readFileSync(`${OUT_DIR}/fidelity-reference.json`, 'utf8'));

const formats = [...new Set(sw.sites.flatMap((s) => Object.keys(s.byFormat)))];
const refBySite = new Map(ref.sites.map((s) => [s.name, s]));

/* Float32 holds ~7 significant decimal digits, so compare relative to the
 * magnitude of the value rather than with a fixed absolute epsilon: an
 * absolute 1e-6 is trivially met by a 0.0 cell and demanding for a 6 mm one. */
const F32_REL = 1e-6;
function relDiff(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

function summarize(rows) {
  if (!rows.length) return { n: 0, exact: null, withinF32: null, maxAbs: null, meanAbs: null, maxRel: null };
  const abs = rows.map((r) => r.abs);
  const rel = rows.map((r) => r.rel);
  return {
    n: rows.length,
    exact: rows.filter((r) => r.abs === 0).length,
    withinF32: rows.filter((r) => r.rel <= F32_REL).length,
    maxAbs: Math.max(...abs),
    meanAbs: abs.reduce((x, y) => x + y, 0) / abs.length,
    maxRel: Math.max(...rel),
  };
}

function collect(pick) {
  const out = {};
  for (const fmt of formats) {
    const rows = [];
    for (const s of sw.sites) {
      const [a, b] = pick(s, fmt);
      if (Number.isFinite(a) && Number.isFinite(b))
        rows.push({ site: s.name, a, b, abs: Math.abs(a - b), rel: relDiff(a, b) });
    }
    out[fmt] = { ...summarize(rows), worst: worstOf(rows) };
  }
  return out;
}

function worstOf(rows) {
  if (!rows.length) return null;
  const w = rows.reduce((m, r) => (r.rel > m.rel ? r : m), rows[0]);
  return { site: w.site, sciwrid: w.a, other: w.b, abs: w.abs, rel: w.rel };
}

/* (a) internal consistency, relative to the NetCDF4 member as the datum. */
const DATUM = 'netcdf4';
const internal = collect((s, fmt) => [s.byFormat[fmt], s.byFormat[DATUM]]);

/* (b) external correctness vs the independent reader of the same file. */
const external = collect((s, fmt) => {
  const r = refBySite.get(s.name);
  return [s.byFormat[fmt], r ? r.byFormat[fmt] : undefined];
});

/* ---- diagnosis of the residual --------------------------------------------
 * The formats split cleanly into two groups: those decoded through the WASM
 * engine (netcdf3/netcdf4/zarr) and those decoded in JS (tiff/parquet). The
 * JS group matches its independent reader exactly; the WASM group does not.
 * Test whether that residual is explained entirely by the WASM JSON path
 * emitting a fixed number of significant figures, rather than by any
 * difference in decoding. */
function significantFigureFit(fmt) {
  const rows = [];
  for (const s of sw.sites) {
    const a = s.byFormat[fmt];
    const r = refBySite.get(s.name);
    const b = r ? r.byFormat[fmt] : undefined;
    if (Number.isFinite(a) && Number.isFinite(b)) rows.push([a, b]);
  }
  if (!rows.length) return null;
  for (let sig = 1; sig <= 17; sig++) {
    if (rows.every(([a, b]) => a === Number(b.toPrecision(sig))))
      return { significantFigures: sig, nSites: rows.length, explainsResidual: true };
  }
  return { significantFigures: null, nSites: rows.length, explainsResidual: false };
}

const serialization = {};
for (const f of formats) serialization[f] = significantFigureFit(f);

const report = {
  variable: sw.variable, units: sw.units, datum: DATUM,
  f32RelativeTolerance: F32_REL,
  serialization,
  variableUsed: sw.variableUsed, readers: ref.readers,
  nSites: sw.sites.length,
  formats, internal, external,
  errors: sw.errors,
  perSite: sw.sites.map((s) => ({
    name: s.name, lat: s.lat, lon: s.lon,
    sciwrid: s.byFormat,
    reference: (refBySite.get(s.name) || {}).byFormat || {},
  })),
};
writeJSON(`${OUT_DIR}/fidelity-report.json`, report);

/* ---- markdown for the manuscript ---- */
const num = (v) => (v === null || v === undefined ? 'n/a'
  : v === 0 ? '0' : v.toExponential(2));

let md = '# Format-fidelity results\n\n';
md += `Variable \`${sw.variable}\` (${sw.units}), ${sw.sites.length} sites `;
md += 'stratified across the observed precipitation distribution.\n\n';

md += `## (a) SciWrid internal consistency (vs the \`${DATUM}\` member)\n\n`;
md += '| Format | variable read | n | exact | within F32 | mean abs | max abs | max rel |\n';
md += '|---|---|---|---|---|---|---|---|\n';
for (const f of formats) {
  const i = internal[f];
  md += `| ${f} | \`${sw.variableUsed[f]}\` | ${i.n} | ${i.exact} | ${i.withinF32} | ${num(i.meanAbs)} | ${num(i.maxAbs)} | ${num(i.maxRel)} |\n`;
}

md += '\n## (b) SciWrid vs an independent reader of the same file\n\n';
md += '| Format | reference reader | n | exact | within F32 | mean abs | max abs | max rel |\n';
md += '|---|---|---|---|---|---|---|---|\n';
for (const f of formats) {
  const e = external[f];
  md += `| ${f} | ${(ref.readers || {})[f] || '?'} | ${e.n} | ${e.exact} | ${e.withinF32} | ${num(e.meanAbs)} | ${num(e.maxAbs)} | ${num(e.maxRel)} |\n`;
}

md += '\n## Worst case per format (external)\n\n';
md += '| Format | site | SciWrid | reference | abs diff | rel diff |\n';
md += '|---|---|---|---|---|---|\n';
for (const f of formats) {
  const w = external[f].worst;
  md += w
    ? `| ${f} | ${w.site} | ${w.sciwrid} | ${w.other} | ${num(w.abs)} | ${num(w.rel)} |\n`
    : `| ${f} | n/a | n/a | n/a | n/a | n/a |\n`;
}

md += '\n## Diagnosis of the residual\n\n';
md += 'Every non-zero difference above is tested against a single hypothesis: ';
md += 'that SciWrid decodes the value exactly and the residual comes only from ';
md += 'the number of significant figures its output path emits.\n\n';
md += '| Format | decode path | residual explained by output precision? | significant figures |\n';
md += '|---|---|---|---|\n';
const DECODE_PATH = { netcdf3: 'WASM', netcdf4: 'WASM', zarr: 'WASM',
                      tiff: 'JavaScript', parquet: 'JavaScript' };
for (const f of formats) {
  const s = serialization[f];
  const exact = external[f].maxAbs === 0;
  md += `| ${f} | ${DECODE_PATH[f] || '?'} | ` +
        `${exact ? 'no residual (exact match)' : (s && s.explainsResidual ? 'yes' : 'NO — unexplained')} | ` +
        `${s && s.significantFigures ? s.significantFigures : 'n/a'} |\n`;
}

writeFileSync(`${OUT_DIR}/fidelity-table.md`, md, 'utf8');
console.log('wrote', `${OUT_DIR}/fidelity-table.md`);
console.log('\n' + md);
