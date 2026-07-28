#!/usr/bin/env node
/*
 * scripts/test-idalia.js — the Hurricane Idalia demo fixtures.
 *
 * Two levels of assertion, kept apart on purpose:
 *
 *   1. READER CORRECTNESS (tight). SciWrid reproduces each fixture's own
 *      sidecar totals. A failure here is a decoder bug.
 *   2. SCIENCE AGREEMENT (loose). Those totals sit near the published
 *      event-agreement.md table. AORC is coarsened and will drift; Stage IV and
 *      NLDAS-2 are unmodified and should track tightly.
 *
 * Skips cleanly when the fixtures are absent, so a fresh clone that has not run
 * the prep scripts still passes `npm test`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scan, extract } from '../index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(root, 'examples/idalia');

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { skipped++; console.log('SKIP'); }
    else { passed++; console.log('OK'); }
  } catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/* Published reference — event-agreement.md, storm total in mm. */
const PUBLISHED = {
  'NCEP Stage IV': { 'Big Bend FL': 79.9, Tampa: 65.8, 'Cedar Key FL': 36.1,
                     'Valdosta GA': 187.1, 'Savannah GA': 52.1, 'Charleston SC': 69.0 },
  'NOAA AORC':     { 'Big Bend FL': 72.0, Tampa: 75.5, 'Cedar Key FL': 36.4,
                     'Valdosta GA': 188.4, 'Savannah GA': 52.7, 'Charleston SC': 69.6 },
  'NLDAS-2':       { 'Big Bend FL': 73.2, Tampa: 32.9, 'Cedar Key FL': 12.4,
                     'Valdosta GA': 109.7, 'Savannah GA': 31.2, 'Charleston SC': 23.4 },
};

const POINTS = {
  'Big Bend FL':   [29.82, -83.59],
  Tampa:           [27.9506, -82.4572],
  'Cedar Key FL':  [29.14, -83.03],
  'Valdosta GA':   [30.83, -83.28],
  'Savannah GA':   [32.08, -81.09],
  'Charleston SC': [32.78, -79.93],
};

const FIXTURES = [
  { file: 'idalia-stage4.grb2',   sidecar: 'idalia-stage4-totals.json',
    format: 'grib2',   sciTol: 0.02 },
  { file: 'idalia-aorc.zarr.zip', sidecar: 'idalia-aorc-totals.json',
    format: 'zarr',    sciTol: 0.35 },
  { file: 'idalia-nldas2.nc',     sidecar: 'idalia-nldas2-totals.json',
    format: 'netcdf4', sciTol: 0.05 },
];

async function totalAt(buf, variable, lat, lon) {
  const r = await extract(buf, { variable, lat, lon, t1: 0, t2: 119 });
  const vals = (r.timeseries || []).map((p) => p.value).filter(Number.isFinite);
  return vals.reduce((a, b) => a + b, 0);
}

console.log('[idalia]');

for (const fx of FIXTURES) {
  const path = resolve(DIR, fx.file);
  const sidePath = resolve(DIR, fx.sidecar);

  await test(`${fx.file} scans as ${fx.format} with 120 timesteps`, async () => {
    if (!existsSync(path)) return 'skip';
    const buf = new Uint8Array(readFileSync(path));
    const m = await scan(buf);
    assert(m.format === fx.format, `format ${m.format}, want ${fx.format}`);
    const steps = m.times && m.times.values ? m.times.values.length : 0;
    assert(steps === 120, `expected 120 timesteps, got ${steps}`);
  });

  await test(`${fx.file} reproduces its sidecar totals (reader correctness)`, async () => {
    if (!existsSync(path) || !existsSync(sidePath)) return 'skip';
    const side = JSON.parse(readFileSync(sidePath, 'utf8'));
    const buf = new Uint8Array(readFileSync(path));
    for (const [name, want] of Object.entries(side.totals)) {
      const [lat, lon] = POINTS[name];
      const got = await totalAt(buf, side.variable, lat, lon);
      const rel = Math.abs(got - want) / Math.max(want, 1);
      assert(rel <= 0.02,
        `${name}: got ${got.toFixed(1)} mm, sidecar says ${want} mm (${(rel * 100).toFixed(1)}% off)`);
    }
  });

  await test(`${fx.file} agrees with the published table (science)`, async () => {
    if (!existsSync(path) || !existsSync(sidePath)) return 'skip';
    const side = JSON.parse(readFileSync(sidePath, 'utf8'));
    const ref = PUBLISHED[side.product];
    assert(ref, `no published row for product "${side.product}"`);
    const buf = new Uint8Array(readFileSync(path));
    for (const [name, want] of Object.entries(ref)) {
      const [lat, lon] = POINTS[name];
      const got = await totalAt(buf, side.variable, lat, lon);
      const rel = Math.abs(got - want) / Math.max(want, 1);
      assert(rel <= fx.sciTol,
        `${name}: got ${got.toFixed(1)} mm, published ${want} mm ` +
        `(${(rel * 100).toFixed(1)}% off, tolerance ${(fx.sciTol * 100)}%)`);
    }
  });
}

await test('AORC is unpacked, not raw int16', async () => {
  const path = resolve(DIR, 'idalia-aorc.zarr.zip');
  if (!existsSync(path)) return 'skip';
  const buf = new Uint8Array(readFileSync(path));
  const got = await totalAt(buf, 'APCP_surface', 30.83, -83.28);
  assert(got < 600,
    `Valdosta total ${got.toFixed(0)} mm looks like raw int16 (10x too large) — ` +
    `the Zarr CF scale_factor fix is not being applied`);
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
