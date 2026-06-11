/*
 * scripts/build.mjs - build the publishable npm package into dist/.
 *
 * Pure Node (no Python, no Emscripten). Bundles index.js + lib/** into one
 * minified ESM file, keeps the WASM loader / worker / bare deps / node builtins
 * external, and copies the prebuilt .wasm + loaders + types alongside.
 *
 *   node scripts/build.mjs
 */
import { build } from 'esbuild';
import { rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const r = (...p) => resolve(ROOT, ...p);
const d = (...p) => resolve(DIST, ...p);

/* Rewrite the two relative runtime assets to dist siblings + mark external,
 * and keep all node: builtins external. Bare packages are handled by
 * `packages: 'external'` in the build options. */
const externalAssets = {
  name: 'external-assets',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, external: true }));
    b.onResolve({ filter: /[\\/]wasm[\\/]webparsers\.js$/ },
      () => ({ path: './webparsers.js', external: true }));
    b.onResolve({ filter: /[\\/]worker[\\/]loader\.js$/ },
      () => ({ path: './loader.js', external: true }));
  },
};

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  /* 1. Bundle the library. */
  await build({
    entryPoints: [r('index.js')],
    outfile: d('index.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    packages: 'external',
    plugins: [externalAssets],
  });

  /* 2. Copy runtime assets verbatim (NOT re-minified). */
  const assets = [
    ['wasm/webparsers.wasm', 'webparsers.wasm'],
    ['wasm/webparsers.js', 'webparsers.js'],
    ['worker/worker.js', 'worker.js'],
    ['worker/loader.js', 'loader.js'],
  ];
  for (const [from, to] of assets) await copyFile(r(from), d(to));

  /* 3. Emit flattened TypeScript declarations.
   *    index.d.ts references ./lib/*.js - rewrite those to flat siblings. */
  const idts = (await readFile(r('index.d.ts'), 'utf8'))
    .replaceAll('./lib/webparsers-api.js', './webparsers-api.js')
    .replaceAll('./lib/webparsers-lib.js', './webparsers-lib.js');
  await writeFile(d('index.d.ts'), idts);
  await copyFile(r('lib/webparsers-api.d.ts'), d('webparsers-api.d.ts'));
  /* The class + default export have no hand-written .d.ts; copy the JS so a
   * consumer's TypeScript can infer their types (matches today's behavior,
   * where lib/webparsers-lib.js ships in the package). */
  await copyFile(r('lib/webparsers-lib.js'), d('webparsers-lib.js'));

  console.log('build: wrote dist/ (index.js, webparsers.js, webparsers.wasm, worker.js, loader.js, *.d.ts)');
}

main().catch((e) => { console.error(e); process.exit(1); });
