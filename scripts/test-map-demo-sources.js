#!/usr/bin/env node
/*
 * scripts/test-map-demo-sources.js — guards the demo's multi-source cap.
 *
 * These are static-source assertions, not DOM tests: the demo has no headless
 * harness, so we assert on the shipped source text. That is enough to catch the
 * regression that actually matters — a hardcoded "two files" assumption
 * creeping back in after the cap was raised.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const js   = readFileSync(resolve(root, 'examples/map-demo.js'), 'utf8');
const html = readFileSync(resolve(root, 'examples/map-demo.html'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('[map-demo sources]');

test('MAX_SOURCES is 3', () => {
  const m = js.match(/const MAX_SOURCES\s*=\s*(\d+)/);
  assert(m, 'MAX_SOURCES not found');
  assert(m[1] === '3', `expected 3, got ${m[1]}`);
});

test('no hardcoded slot:0 / slot:1 legend pair', () => {
  assert(!/\{slot:\s*0\s*,\s*name:\s*sources\[0\]/.test(js),
    'renderLegend still hardcodes slot 0/1 instead of mapping over sources');
});

test('dual-axis no longer assumes exactly sources[0] and sources[1]', () => {
  assert(!/list\.length\s*===\s*2\s*&&\s*!sameUnit\(resolveUnit\(scanVarOf\(sources\[0\]/.test(js),
    'dual-axis rule still indexes sources[0]/sources[1] directly');
});

test('compare pickers are generated, not hardcoded A/B markup', () => {
  assert(!/id="compare-b"/.test(html),
    'static #compare-b select still present; pickers should be generated');
});

test('no "two files" copy remains', () => {
  assert(!/[Tt]wo files loaded/.test(js), '"Two files loaded" copy still present');
  assert(!/Comparing two files at a time/.test(js),
    '"Comparing two files at a time" copy still present');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
