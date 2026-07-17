#!/usr/bin/env node
// scripts/test-encoding.js - guards against double-encoded UTF-8 in the demo sources.
//
// Mojibake like "Â°" (c3 82 c2 b0) is "°" (c2 b0) encoded twice. It renders as
// literal garbage in the browser and is invisible in most diffs, so it gets its
// own regression test.

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try { fn(); passed++; console.log('OK'); }
  catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.message); }
}

const FILES = [
  'examples/map-demo-analysis.js',
  'examples/map-demo.js',
  'examples/map-demo.html',
  'examples/map-demo-bbox.js',
  'examples/map-demo.worker.js',
];

// Tell-tale byte sequences of UTF-8 text that was decoded as cp1252/latin-1 and
// re-encoded. Two distinct signatures, because the two byte ranges mangle
// differently:
//   °  = c2 b0      -> c2 reads as 'Â' -> c3 82 c2 b0        ("Â°")
//   —  = e2 80 94   -> e2/80/94 read as 'â','€','”'
//                   -> c3 a2 e2 82 ac e2 80 9d               ("â€”")
// The second is NOT c3a2c280: cp1252 maps 0x80 to '€' (e2 82 ac), not U+0080.
const DOUBLE_ENCODED = [
  { bytes: 'c382', as: 'Â (mangled U+0080-U+00BF, e.g. °)' },
  { bytes: 'c3a2e282ac', as: 'â€ (mangled em/en dash, curly quotes, ellipsis)' },
];

console.log('[encoding]');

for (const f of FILES) {
  test(`${f} has no double-encoded UTF-8`, () => {
    const hex = readFileSync(f).toString('hex');
    const hits = DOUBLE_ENCODED.filter((d) => hex.includes(d.bytes));
    if (hits.length) throw new Error(`${f}: found ${hits.map((h) => h.as).join(', ')}`);
  });
}

test('map-demo-analysis.js axis labels use real degree signs', () => {
  const s = readFileSync('examples/map-demo-analysis.js', 'utf8');
  if (!s.includes('Latitude (°N)')) throw new Error('missing "Latitude (°N)"');
  if (!s.includes('Longitude (°E)')) throw new Error('missing "Longitude (°E)"');
});

test('unit labels use real degree signs, never question marks', () => {
  const s = readFileSync('examples/map-demo-analysis.js', 'utf8');
  const degree = String.fromCharCode(176);
  if (!s.includes(degree + 'C') || s.includes('?C') || s.includes('?F')) throw new Error('unit degree sign flattened');
});

// The OTHER way a non-UTF-8 editor mangles these files: it replaces every glyph
// it cannot encode with a literal '?'. That is valid ASCII, so the byte-signature
// check above cannot see it. Section banners are drawn with U+2500, so a banner
// full of '?' is a reliable tell — this caught "Δ" being silently flattened to
// "?" in a stats label that the byte check had already declared clean.
for (const f of FILES) {
  test(`${f} has no '?'-flattened section banners`, () => {
    const bad = readFileSync(f, 'utf8').split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /\/\*[^*]*\?\?/.test(l));
    if (bad.length) throw new Error(`${f}: banner glyphs flattened to '?' on line(s) ${bad.map(([n]) => n).join(', ')}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
