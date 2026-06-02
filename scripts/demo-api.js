#!/usr/bin/env node
/**
 * scripts/demo-api.js — quick demo of the functional API.
 *
 * Scans a file and prints variables [0] through [20].
 *
 * Run from repo root:
 *   node scripts/demo-api.js
 *   node scripts/demo-api.js examples/conus_20240202_24h.grb2
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scan } from '../lib/webparsers-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');

/* ---- Load the WASM factory (same pattern as test-api.js) -------------- */
function loadWasmFactory() {
  const code = readFileSync(resolve(root, 'wasm/webparsers.js'), 'utf8');
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', code)(m, m.exports);
  return m.exports.default ?? m.exports;
}
const rawFactory  = loadWasmFactory();
const wasmBinary  = readFileSync(resolve(root, 'wasm/webparsers.wasm'));
const wasmFactory = () => rawFactory({ wasmBinary });

/* ---- Pick a file ------------------------------------------------------ */
const filePath = process.argv[2]
  ?? 'examples/icon_global_icosahedral_single-level_2025121900_000_T_2M.grib2';

console.log(`Scanning: ${filePath}\n`);
const bytes = new Uint8Array(readFileSync(resolve(root, filePath)));

/* ---- Scan and print variables [0..20] -------------------------------- */
const meta = await scan(bytes, { wasmFactory });

console.log(`Format:              ${meta.format}`);
console.log(`Total variables:     ${meta.total_variables}`);
console.log(`Supported variables: ${meta.supported_variables}`);
console.log(`\nVariables [0]..[${Math.min(20, meta.variables.length - 1)}]:\n`);

const slice = meta.variables.slice(0, 21);
for (const v of slice) {
  console.log(`  [${String(v.index).padStart(2)}] ${JSON.stringify(v)}`);
}

if (meta.variables.length > 21)
  console.log(`\n  …and ${meta.variables.length - 21} more.`);
