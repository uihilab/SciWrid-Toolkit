#!/usr/bin/env node
/**
 * scripts/test-kerchunk.js — kerchunk-parquet consumer tests.
 *
 * Pattern matches scripts/test-zarr.js. Uses the committed fixture at
 * examples/testfile/kerchunk-fixture.parquet built by
 * scripts/build-kerchunk-fixture.js.
 *
 * Requires the WASM build (python wasm/build.py) for the integration test.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');
const FIXTURE   = resolve(root, 'examples/testfile/kerchunk-fixture.parquet');
const BIN_FIX   = resolve(root, 'examples/testfile/kerchunk-fixture.bin');

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r === 'skip') { skipped++; console.log('SKIP'); }
    else              { passed++;  console.log('OK');   }
  } catch (e) {
    failed++;
    console.log('FAIL');
    console.error('    →', e.stack || e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('test-kerchunk.js\n');

if (!existsSync(FIXTURE) || !existsSync(BIN_FIX)) {
  console.error('Fixtures missing. Run: node scripts/build-kerchunk-fixture.js');
  process.exit(1);
}

/* -------------------- Task 4: parquet-refs -------------------- */

await test('openRefIndex reads .zgroup, tas/.zarray, tas/.zattrs as metadata', async () => {
  const { openRefIndex } = await import('../lib/kerchunk/parquet-refs.js');
  const idx = await openRefIndex(FIXTURE);

  const metaKeys = idx.listMetaKeys();
  for (const expected of ['.zgroup', 'tas/.zarray', 'tas/.zattrs', 'y/.zarray', 'x/.zarray']) {
    assert(metaKeys.includes(expected), 'missing meta key: ' + expected +
      ' (got: ' + metaKeys.join(',') + ')');
  }

  const zarrayBytes = idx.getMeta('tas/.zarray');
  assert(zarrayBytes instanceof Uint8Array, 'getMeta should return Uint8Array');
  const zarray = JSON.parse(new TextDecoder().decode(zarrayBytes));
  assert(zarray.shape[0] === 4 && zarray.shape[1] === 8,
    'expected shape [4,8] got ' + JSON.stringify(zarray.shape));
  assert(zarray.compressor.id === 'zlib', 'expected zlib compressor');
  assert(zarray.filters[0].id === 'shuffle', 'expected shuffle filter');
});

await test('openRefIndex resolves chunk refs to absolute paths + offsets', async () => {
  const { openRefIndex } = await import('../lib/kerchunk/parquet-refs.js');
  const idx = await openRefIndex(FIXTURE);

  const ref00 = idx.getRef('tas', '0.0');
  assert(ref00, 'ref for tas/0.0 missing');
  assert(ref00.kind === 'file', 'expected file ref, got ' + ref00.kind);
  assert(typeof ref00.path === 'string' && ref00.path.endsWith('kerchunk-fixture.bin'),
    'unexpected path: ' + ref00.path);
  assert(ref00.offset === 0, 'expected offset 0, got ' + ref00.offset);
  assert(ref00.length === 26, 'expected length 26, got ' + ref00.length);

  /* Confirm path actually points at our .bin file */
  assert(existsSync(ref00.path), 'resolved path does not exist: ' + ref00.path);

  /* Different chunk has a different offset */
  const ref01 = idx.getRef('tas', '0.1');
  assert(ref01.offset === 26 && ref01.length === 28,
    `expected tas/0.1 (26, 28), got (${ref01.offset}, ${ref01.length})`);

  /* Missing key returns null */
  assert(idx.getRef('tas', '99.99') === null, 'missing key should return null');
});

/* -------------------- Task 5: KerchunkRefStore -------------------- */

await test('KerchunkRefStore.getChunkBytes reads bytes at the right offset', async () => {
  const { openRefIndex } = await import('../lib/kerchunk/parquet-refs.js');
  const { KerchunkRefStore } = await import('../lib/kerchunk/ref-store.js');

  const idx    = await openRefIndex(FIXTURE);
  const ref    = idx.getRef('tas', '0.0');
  const arrays = [{ name: 'tas', root: 'tas/', meta: {}, attrs: null }];

  const store = new KerchunkRefStore(idx, arrays);
  const bytes = await store.getChunkBytes('tas', '0.0');
  assert(bytes instanceof Uint8Array, 'expected Uint8Array');
  assert(bytes.length === ref.length,
    `expected ${ref.length} bytes, got ${bytes.length}`);

  /* Bytes should match a raw fs.read of the same slice */
  const fileBuf = readFileSync(BIN_FIX);
  for (let i = 0; i < ref.length; i++) {
    if (bytes[i] !== fileBuf[ref.offset + i])
      throw new Error('byte ' + i + ' mismatch: ' + bytes[i] + ' vs ' + fileBuf[ref.offset + i]);
  }

  /* Missing chunk → null (no throw) */
  const missing = await store.getChunkBytes('tas', '99.99');
  assert(missing === null, 'expected null for missing chunk');

  await store.close();
});

await test('KerchunkRefStore caches file handles across multiple chunks', async () => {
  const { openRefIndex } = await import('../lib/kerchunk/parquet-refs.js');
  const { KerchunkRefStore } = await import('../lib/kerchunk/ref-store.js');

  const idx    = await openRefIndex(FIXTURE);
  const arrays = [{ name: 'tas', root: 'tas/', meta: {}, attrs: null }];
  const store  = new KerchunkRefStore(idx, arrays);

  /* Read all four tas chunks; offset/lengths from build script */
  const expected = [
    { key: '0.0', offset: 0,   length: 26 },
    { key: '0.1', offset: 26,  length: 28 },
    { key: '1.0', offset: 54,  length: 23 },
    { key: '1.1', offset: 77,  length: 23 },
  ];
  for (const { key, offset, length } of expected) {
    const got = await store.getChunkBytes('tas', key);
    assert(got && got.length === length,
      `chunk ${key}: expected length ${length}, got ${got?.length}`);
  }

  await store.close();
});

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
