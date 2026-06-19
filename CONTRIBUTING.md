# Contributing to SciWrid Toolkit

## Toolchain at a glance

SciWrid Toolkit is a **JavaScript/TypeScript library** with a small C core compiled
to WebAssembly. The compiled `wasm/sciwrid.wasm` is committed, so day-to-day
work needs only **Node 18+** - no Python, no Emscripten.

## Common commands

```bash
npm install            # install dev + optional deps
npm run build          # bundle the publishable package into dist/ (Node only)
npm test               # run the smoke-test suite (see scripts/test-*.js)
npm run demo:web       # serve examples/ (api-demo, map-demo) on localhost
```

Individual smoke tests: `npm run test:api`, `test:zarr`, `test:tiff`,
`test:trim`, `test:grid`, `test:render`, `test:time`, `test:kerchunk`, ... (see
`package.json` `scripts`).

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
