#!/usr/bin/env node
// Real-file probe for Whole-file comparison mode. Proves the mode is
// point-independent: whole-domain stats are populated for the SAME AORC file
// whose ocean cells make time mode collapse to n=0. The AORC file lives
// outside the repo (Downloads); skip cleanly when it is absent.
import { existsSync, readFileSync } from 'node:fs';
import { scan, extractGrid, extract } from '../index.js';
import { bboxIntersect, pairGrids, pearson, meanBias, computeStats, convertSeries, resolveUnit, nativeGridSize } from '../examples/map-demo-analysis.js';

let passed = 0, failed = 0;
async function test(name, fn) { process.stdout.write(`  ${name} ... `); try { await fn(); passed++; console.log('OK'); } catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.stack || e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const AORC = 'C:/Users/Khoa Le/Downloads/aorc_20010101_south_states.nc';
const GFS = new URL('../examples/timeseries/gfs_timeseries.grb2', import.meta.url);

console.log('[whole-file: real files]');
if (!existsSync(AORC)) {
  console.log(`  SKIP - AORC file not found at ${AORC} (external test asset)`);
  process.exit(0);
}

const aorcBytes = new Uint8Array(readFileSync(AORC));
const gfsBytes = new Uint8Array(readFileSync(GFS));
const aorcScan = await scan(aorcBytes);
const gfsScan = await scan(gfsBytes);
// Mirror the app: a file with no bbox is treated as global.
const gfsBbox = Array.isArray(gfsScan.bbox) && gfsScan.bbox.length === 4 ? gfsScan.bbox : [-180, -90, 180, 90];

await test('an ocean point makes point-anchored extract return null (the bug)', async () => {
  const r = await extract(aorcBytes, { variable: 'temp', lat: 27.0, lon: -90.0, t1: 0, t2: 0 });
  const v = r?.timeseries?.[0]?.value;
  assert(v == null, `expected null over ocean, got ${v}`);
});

await test('whole-domain stats are populated regardless of point', async () => {
  const v = aorcScan.variables.find((x) => x.name === 'temp');
  const size = nativeGridSize(v.shape, aorcScan.bbox, aorcScan.bbox);
  const grid = await extractGrid(aorcBytes, { variable: 'temp', bbox: aorcScan.bbox, width: size.w, height: size.h, workers: 0, time: 0 });
  const stats = computeStats(convertSeries(grid.data, resolveUnit(v)).ys);
  assert(stats.n > 100000, `expected many finite cells, got n=${stats.n}`);
});

await test('AORC and (global) GFS overlap equals the AORC box', async () => {
  const ov = bboxIntersect(aorcScan.bbox, gfsBbox);
  assert(ov != null, 'expected an overlap');
  assert(JSON.stringify(ov) === JSON.stringify(aorcScan.bbox), `overlap ${JSON.stringify(ov)} != AORC ${JSON.stringify(aorcScan.bbox)}`);
});

await test('overlap scatter yields finite pairs with finite r and bias', async () => {
  const ov = bboxIntersect(aorcScan.bbox, gfsBbox);
  const raw = nativeGridSize(aorcScan.variables.find((x) => x.name === 'temp').shape, aorcScan.bbox, ov);
  const w = Math.min(96, raw.w), h = Math.min(96, raw.h);
  const gA = await extractGrid(aorcBytes, { variable: 'temp', bbox: ov, width: w, height: h, workers: 0, time: 0 });
  const gB = await extractGrid(gfsBytes, { variable: 'Temperature', bbox: ov, width: w, height: h, workers: 0, time: 0 });
  const convA = convertSeries(gA.data, resolveUnit(aorcScan.variables.find((x) => x.name === 'temp')));
  const convB = convertSeries(gB.data, resolveUnit(gfsScan.variables.find((x) => x.name === 'Temperature')));
  const pairs = pairGrids(convA.ys, convB.ys, { cap: 4000 });
  assert(pairs.length > 100, `expected many pairs, got ${pairs.length}`);
  assert(pairs.length <= 4000, `cap exceeded: ${pairs.length}`);
  assert(Number.isFinite(pearson(pairs)), 'pearson finite');
  assert(Number.isFinite(meanBias(pairs)), 'bias finite');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
