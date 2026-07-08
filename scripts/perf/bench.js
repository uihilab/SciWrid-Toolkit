#!/usr/bin/env node
/*
 * scripts/perf/bench.js — performance harness for big-file extraction.
 *
 * Measures how extraction cost scales with file size (50 MB → 2 GB) for two
 * query types (point / window), across three access modes:
 *
 *   memory  readFileSync → Uint8Array → extract()       (pure scan+decode CPU)
 *   naive   fetch(whole file) → extract(bytes)          (download-then-parse)
 *   range   extract(url) → library decides what to pull (the "web" path)
 *
 * For each (file × query × mode) it records: median wall time, bytes
 * transferred (server-side truth + client-header cross-check), HTTP request
 * count, and peak RSS. The headline question — "does the current API only pull
 * the bytes it needs?" — is answered by the bytes-transferred column, not
 * assumed.
 *
 * Run:  node scripts/perf/bench.js [--reps N] [--only LABEL] [--config path]
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

import { scan, extract, extractGrid } from '../../index.js';
import { startRangeServer } from './range-server.js';
import { installFetchCounter, timeit, fmtBytes, fmtMs } from './instrument.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

/* ---- args -------------------------------------------------------------- */
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const onlyLabel = getArg('--only', null);
const onlyQuery = getArg('--query', null);   // 'point' | 'window' — restrict query types
const configPath = getArg('--config', './config.mjs');

const cfg = (await import(configPath.startsWith('.') ? configPath : `file://${configPath}`)).default;
const REPS = Number(getArg('--reps', cfg.reps ?? 3));
const WARMUP = cfg.warmup ?? 1;
const QUERIES = onlyQuery ? [onlyQuery] : cfg.queries;

/* ---- query derivation -------------------------------------------------- */
/* Pull a [west,south,east,north] extent out of whatever shape scan() returns. */
function deriveExtent(meta, v) {
  const cand = v?.bbox || meta?.bbox || v?.extent || meta?.extent;
  if (Array.isArray(cand) && cand.length === 4 && cand.every(Number.isFinite)) return cand;
  // Try lon/lat axis arrays if present.
  const lons = v?.lons || meta?.lons, lats = v?.lats || meta?.lats;
  if (Array.isArray(lons) && Array.isArray(lats) && lons.length && lats.length) {
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  return [-180, -90, 180, 90]; // safe global fallback
}

/* scan() returns two shapes: GRIB2/NetCDF give `variables:[{name,supported,bbox?}]`,
 * TIFF gives `variable_names:[string]` + top-level bbox. Handle both. */
function pickVariable(meta, entry) {
  if (Array.isArray(meta.variables) && meta.variables.length) {
    const v = (entry.variable && meta.variables.find((x) => x.name === entry.variable))
      || meta.variables.find((x) => x.supported) || meta.variables[0];
    return { name: entry.variable ?? v.name, v };
  }
  if (Array.isArray(meta.variable_names) && meta.variable_names.length) {
    return { name: entry.variable ?? meta.variable_names[0], v: undefined };
  }
  throw new Error('no variables in scan metadata');
}

function buildQueries(meta, entry) {
  const { name: variable, v } = pickVariable(meta, entry);
  const [w, s, e, n] = deriveExtent(meta, v);
  // Priority: per-file override → fixed config.point → extent center.
  const cLon = entry.lon ?? cfg.point?.lon ?? (w + e) / 2;
  const cLat = entry.lat ?? cfg.point?.lat ?? (s + n) / 2;

  // Centered window covering `windowFraction` of the extent.
  let bbox = entry.bbox;
  if (!bbox) {
    const f = cfg.windowFraction ?? 0.25;
    const hw = ((e - w) * f) / 2, hh = ((n - s) * f) / 2;
    bbox = [cLon - hw, cLat - hh, cLon + hw, cLat + hh];
  }
  return {
    variable,
    point: { variable, lat: cLat, lon: cLon },
    window: { variable, bbox, width: cfg.windowPx.width, height: cfg.windowPx.height },
  };
}

/* ---- one measured cell ------------------------------------------------- */
async function measure({ mode, queryType, absPath, url, server, fetchCounter, queries, preBytes }) {
  const q = queries[queryType];
  const call = (src) => (queryType === 'point' ? extract(src, q) : extractGrid(src, q));

  let fn, onRep, transferred = null, requests = null, headerBytes = null;

  if (mode === 'memory') {
    fn = () => call(preBytes);                         // bytes already in RAM
    transferred = 0; requests = 0;
  } else if (mode === 'naive') {
    fn = async () => {
      const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
      return call(buf);
    };
    onRep = () => { server.stats.reset(); fetchCounter.reset(); };
  } else { // range
    fn = () => call(url);
    onRep = () => { server.stats.reset(); fetchCounter.reset(); };
  }

  let result;
  try {
    result = await timeit(fn, { reps: REPS, warmup: WARMUP, onRep });
  } catch (err) {
    return { mode, queryType, error: err.message };
  }

  if (mode !== 'memory') {
    transferred = server.stats.bytesServed;
    requests = server.stats.requests;
    headerBytes = fetchCounter.state.bytesFromHeaders;
  }
  // For a point timeseries, nt = number of timesteps returned (grows with file).
  const nt = queryType === 'point'
    ? (result.lastResult?.timeseries?.length ?? null)
    : 1;
  return {
    mode, queryType,
    timeMs: result.time.median,
    timeMin: result.time.min,
    nt,
    msPerStep: nt ? result.time.median / nt : null,
    transferred, requests, headerBytes,
    peakRss: result.peakRss,
  };
}

/* ---- table printing ---------------------------------------------------- */
const ratioOf = (r) => (r.transferred != null && r.size ? r.transferred / r.size : null);
const ratioStr = (ratio) => (ratio == null ? '–' : ratio < 0.01 ? `${(ratio * 100).toFixed(2)}%` : `${(ratio * 100).toFixed(0)}%`);

function printTable(queryType, rows) {
  console.log(`\n### ${queryType.toUpperCase()} query\n`);
  console.log('| Format | File | Size | Mode | Time (ms) | nt | ms/step | Bytes xfer | Reqs | xfer/size | Peak RSS |');
  console.log('|--------|------|------|------|-----------|----|---------|-----------|------|-----------|----------|');
  for (const r of rows.filter((x) => x.queryType === queryType)) {
    if (r.error) {
      console.log(`| ${r.format} | ${r.label} | ${fmtBytes(r.size)} | ${r.mode} | ERROR | – | – | – | – | – | ${r.error.slice(0, 30)} |`);
      continue;
    }
    console.log(
      `| ${r.format} | ${r.label} | ${fmtBytes(r.size)} | ${r.mode} | ${fmtMs(r.timeMs)} | ${r.nt ?? '–'} | ${fmtMs(r.msPerStep)} | ` +
      `${r.mode === 'memory' ? '–' : fmtBytes(r.transferred)} | ${r.requests ?? '–'} | ` +
      `${r.mode === 'memory' ? '–' : ratioStr(ratioOf(r))} | ${fmtBytes(r.peakRss)} |`,
    );
  }
}

/* Cross-format headline: does the range path subset bytes? (range mode only) */
function printFormatSummary(rows) {
  console.log('\n### Range-mode transfer by format (does it subset?)\n');
  console.log('| Format | File | Size | Query | Bytes xfer | Reqs | xfer/size |');
  console.log('|--------|------|------|-------|-----------|------|-----------|');
  for (const r of rows.filter((x) => x.mode === 'range' && !x.error)) {
    console.log(`| ${r.format} | ${r.label} | ${fmtBytes(r.size)} | ${r.queryType} | ${fmtBytes(r.transferred)} | ${r.requests} | ${ratioStr(ratioOf(r))} |`);
  }
}

/* ---- main -------------------------------------------------------------- */
async function performance_() {
  const files = (cfg.files || []).filter((f) => !onlyLabel || f.label === onlyLabel);
  if (!files.length) { console.error('No files in config (or --only matched nothing).'); process.exit(1); }

  const server = await startRangeServer({ root: repoRoot });
  const fetchCounter = installFetchCounter();
  console.log(`Range server: ${server.url}  |  reps=${REPS} warmup=${WARMUP}\n`);

  const rows = [];
  for (const entry of files) {
    const absPath = resolve(repoRoot, entry.path);
    let size;
    try { size = (await stat(absPath)).size; }
    catch { console.error(`SKIP ${entry.label}: not found at ${absPath}`); continue; }

    const url = server.register(absPath);
    console.log(`\n=== ${entry.label}  (${entry.format})  ${absPath}  [${fmtBytes(size)}] ===`);

    // One in-memory load reused for the memory mode and for scan-based derivation.
    const preBytes = new Uint8Array(readFileSync(absPath));
    let queries;
    try {
      const meta = await scan(preBytes);
      queries = buildQueries(meta, entry);
      console.log(`  variable="${queries.variable}"  point=(${queries.point.lat.toFixed(2)},${queries.point.lon.toFixed(2)})  window.bbox=[${queries.window.bbox.map((n) => n.toFixed(1)).join(', ')}]`);
    } catch (err) {
      console.error(`  SKIP ${entry.label}: scan failed — ${err.message}`);
      continue;
    }

    for (const queryType of QUERIES) {
      for (const mode of cfg.modes) {
        process.stdout.write(`  • ${queryType}/${mode} … `);
        const cell = await measure({ mode, queryType, absPath, url, server, fetchCounter, queries, preBytes });
        rows.push({ label: entry.label, size, format: entry.format, ...cell });
        console.log(cell.error ? `ERROR: ${cell.error}` : `${fmtMs(cell.timeMs)} ms, ${cell.mode === 'memory' ? 'in-RAM' : fmtBytes(cell.transferred)}`);
      }
    }
  }

  fetchCounter.restore();
  await server.close();

  for (const queryType of QUERIES) printTable(queryType, rows);
  printFormatSummary(rows);

  // Persist results (outside the repo).
  const outDir = cfg.outDir;
  try {
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = `${outDir}/perf-${stamp}.json`;
    writeFileSync(outPath, JSON.stringify({ when: stamp, reps: REPS, rows }, null, 2));
    console.log(`\nResults written to ${outPath}`);
  } catch (err) {
    console.error(`\nCould not write results: ${err.message}`);
  }
}

performance_().catch((e) => { console.error(e); process.exit(1); });
