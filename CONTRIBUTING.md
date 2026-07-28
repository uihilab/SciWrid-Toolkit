# Contributing to SciWrid Toolkit

## Toolchain at a glance

SciWrid Toolkit is a **JavaScript/TypeScript library** with a small C core compiled
to WebAssembly. The compiled `wasm/sciwrid.wasm` is committed, so day-to-day
work needs only **Node 18+** - no Python, no Emscripten.

## Common commands

```bash
npm install            # install dev + optional deps
npm run build          # bundle the publishable package into dist/ (Node only)
npm run demo:web       # serve examples/ (api-demo, map-demo) on localhost
```

## Tests

The test suite is **not in this repository**. It lives in an out-of-tree
`.testkit/` directory alongside the fixtures it reads (`examples/testfile/`),
both of which are gitignored to keep clones small.

This means `npm test` does **not** work from a fresh clone - the `.testkit/`
scripts it invokes are absent. The library itself is unaffected: nothing under
`lib/`, `core/`, `formats/`, or `wasm/` imports from `.testkit/`, and the
published package never contained tests (`package.json` `files` ships only
`dist/`, `README.md`, and `LICENSE`).

If you need to run or change the tests, ask a maintainer for the `.testkit/`
bundle. Drop it in at the repo root - it resolves paths relative to the repo,
so no configuration is needed - and `npm test` plus the individual
`npm run test:*` scripts will work as before.

## Changing the C / WASM core

Only if you edit C in `formats/` or `wasm/`:

```bash
npm run build:wasm     # requires Emscripten (emcc) on PATH
```

Commit the regenerated `wasm/sciwrid.wasm` so other contributors and the
published package never have to compile it.

## Releasing

`npm publish` runs `prepublishOnly`, which runs `npm run build`, so the tarball
always contains a fresh `dist/`. The repo working tree stays un-built (`dist/`
is gitignored).
