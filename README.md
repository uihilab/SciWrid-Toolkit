# webparsers

JavaScript / TypeScript library for parsing meteorological and geospatial data formats — **GRIB2**, **NetCDF3**, **NetCDF4 / HDF5**, **Zarr v2**, and **TIFF / GeoTIFF (including Cloud-Optimized GeoTIFFs)** — in the browser, Web Workers, and Node 18+. Powered by a pure-C engine compiled to WebAssembly via Emscripten.

## Install

Until published to npm:

```bash
npm install git+https://github.com/uihilab/webparsers.git
```

End users do **not** need to install peer compression libraries — `h5wasm` (NetCDF4) and `numcodecs` (Zarr blosc/zstd/lz4) are lazy-loaded from jsdelivr on first use.

## Supported formats

| Format | Extensions | Notes |
|---|---|---|
| GRIB2 | `.grb2`, `.grib2` | Grid templates 0, 30, 40, 101; simple + complex packing; Section-6 bitmaps (masked points → `NaN`) |
| NetCDF3 Classic | `.nc3` | Full CF coordinate support |
| NetCDF4 / HDF5 | `.nc`, `.nc4` | Loads `h5wasm` from CDN on first use |
| Zarr v2 (zip) | `.zip`, `.zarr` | Compressors: `null`, `gzip`, `zlib`, `blosc`, `zstd`, `lz4`. Filters: `shuffle` only (`fixedscaleoffset`, `delta`, … not yet supported). |
| TIFF / GeoTIFF | `.tif`, `.tiff` | UInt8/UInt16/Int16/Float32; LZW + Deflate; horizontal + floating-point predictors; WGS84 / UTM / sinusoidal; strip + tile; **COG over HTTP Range** (scan/extract only read the IFD + needed tile). |

## Quick start

```js
import { scan, extract, extractGrid, gridToGeoTIFF, gridToImageData, slim } from 'webparsers';

// 1. Inspect a file
const meta = await scan(file);          // file: Uint8Array | Blob | File | URL | string
console.log(meta.format, meta.variables.map(v => v.name));

// 2. Point extract
const point = await extract(file, {
  variable: 'TMP', lat: 40.7, lon: -74.0, t1: 0, t2: 0,
});

// 2b. Select a timestep by date instead of index (nearest match):
const atNoon = await extract(file, { variable: 'TMP', date: '2026-04-14T12:00:00Z' });

// 3. Bounding-box grid (parallel workers, abortable, with progress)
const grid = await extractGrid(file, {
  variable: 'TMP',
  bbox:     [-100, 30, -80, 45],   // [minLon, minLat, maxLon, maxLat]
  width:    256, height: 256,
  workers:  5,
  onProgress: ({ done, total }) => console.log(`${done}/${total}`),
});
// grid.data is a Float32Array of length width*height (row 0 = maxLat)

// 4. Save as Float32 WGS84 GeoTIFF
const tiff = gridToGeoTIFF(grid);    // Uint8Array

// 4b. Render it for a web map — Float32 grid → colored RGBA, ready for a
//     <canvas> or a MapLibre ImageSource (zero-dependency, Node + browser)
const img = gridToImageData(grid, { ramp: 'viridis' });   // { width, height, data }
const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
map.addSource('data', { type: 'image', url: canvas.toDataURL('image/png'),
  coordinates: [[bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]]] });
map.addLayer({ id: 'data', type: 'raster', source: 'data' });
// Need a PNG instead (server-side, <img> src)? `await gridToPNG(grid, { ramp })`.
// Full drop-a-file MapLibre demo: examples/map-demo.html (npm run demo:web)

// 5. Slim a huge file in-place — keep only what you need, same format out
const trimmed = await slim(file, {
  variables: ['TMP', 'UGRD'],     // names from scan().variable_names
  t1: 0, t2: 23,                  // optional time-axis slice
});
// trimmed.bytes is a Uint8Array of the same format as the input.
// GRIB2 / NetCDF3 / Zarr are byte-cut (no decode); NetCDF4 uses h5wasm.
```

Full API reference: [`docs/API.md`](docs/API.md). TypeScript types ship with the package — no `@types` needed.

## Public exports

All public symbols come from the package root:

```js
import {
  // Functional API (recommended)
  detectFormat, scan, extract, extractOutput,
  extractGrid, extractGridOutput, gridToJSON, gridToGeoTIFF,
  gridToImageData, gridToPNG,        // map rendering: Float32 grid → RGBA / PNG
  RAMPS, resolveRamp, sampleRamp,    // color ramps (viridis/plasma/grayscale/RdBu)
  slim,

  // Class API (advanced — reuse one instance across many extracts)
  WebParsers,

  // Typed errors (all extend WebparsersError)
  WebparsersError, UnsupportedFormatError, VariableNotFoundError,
  SourceError, ExtractError, SlimError, UnsupportedCRSError,
} from 'webparsers';
```

Anything inside `wasm/` is internal and may change without notice.

## Project layout

```
webparsers/
├── index.js            ← public entry point
├── index.d.ts          ← TypeScript types
├── lib/                ← JavaScript library source (internal — do not import directly)
│   ├── webparsers-lib.js   class implementation
│   ├── webparsers-api.js   functional API
│   ├── webparsers-api.d.ts TypeScript types
│   ├── errors.js           typed error classes
│   ├── grid-output.js      GeoTIFF / JSON serialisers
│   ├── render/             color ramps + Float32 grid → RGBA / PNG
│   ├── slim/               in-place file trimming (per-format)
│   ├── tiff/               TIFF / GeoTIFF reader (+ COG over HTTP Range)
│   ├── zarr/               Zarr v2 reader (zip, compressors, filters)
│   ├── kerchunk/           Kerchunk / reference-store reader
│   ├── time-decoder.js     CF time-axis decoding
│   └── time-select.js      date → nearest timestep selection
├── wasm/               ← WASM artifacts + C build (internal)
│   ├── webparsers.wasm     compiled C core (~193 KB)
│   ├── webparsers.js       Emscripten loader
│   ├── wasm_api.c          C bindings
│   └── build.py            build script
├── worker/             ← Web Worker for parallel bbox extraction
├── examples/           ← api-demo.html, map-demo.html, library-usage.html, testfile/
├── scripts/            ← serve.js + test-*.js / demo-*.js runners
├── docs/               ← API.md
└── formats/            ← C sources for the WASM build (GRIB2, NetCDF, Zarr, …)
```

## Run the demos

```bash
npm run demo:web        # serves examples/ on localhost (api-demo, map-demo, library-usage)
npm run demo:grib2      # CLI: scan + extract a sample GRIB2 file
npm run demo:netcdf3    # CLI: scan + extract a sample NetCDF3 file
npm run demo:netcdf4    # CLI: scan + extract a sample NetCDF4 file
npm run demo:zarr       # CLI: scan + extract a sample Zarr file
```

CLI demo scripts live under `examples/testfile/`.
Use `npm run build:zarr-fixture` to regenerate the rich deflated Zarr fixture
at `examples/testfile/sample-zarr-rich.zarr.zip`.

Smoke tests:

```bash
npm run test:api        # functional API
npm run test:grid       # extractGrid (parallel bbox)
npm run test:zarr       # Zarr path
npm run test:tiff       # TIFF / GeoTIFF
npm run test:tiff-range # COG over HTTP Range
npm run test:slim       # slim() across all formats
npm run test:time       # CF time-axis decoding
npm run test:time-select# date → nearest-timestep selection
npm run test:render     # color ramps + gridToImageData / gridToPNG
npm run test:kerchunk   # Kerchunk reference store
```

The `demo:web` server hosts several pages:
- **`api-demo.html`** — drop a `.grb2` / `.nc` / `.zip`/`.zarr` / `.tif` file and run `scan` / `extract` / `extractGrid` interactively (heat-map canvas, progress, abort, GeoTIFF / JSON download).
- **`map-demo.html`** — drop a file and render it on a MapLibre map (date coverage in the sidebar).
- **`library-usage.html`** — minimal copy-paste usage example.

## Current state

### ✅ Working
- **GRIB2** — grid templates 0, 30, 40, 101; simple + complex packing; Section-6 bitmaps (masked points → `NaN`).
- **NetCDF3 Classic** — full CF coordinate support.
- **NetCDF4 / HDF5** — via lazy-loaded `h5wasm`.
- **Zarr v2 (zip)** — compressors `null`, `gzip`, `zlib`, `blosc`, `zstd`, `lz4`.
- **TIFF / GeoTIFF** — UInt8/16, Int16, Float32; LZW + Deflate; horizontal + floating-point predictors; WGS84 / UTM / sinusoidal; strip + tile; **COG over HTTP Range**.
- **Point + bbox extraction** — `extract`, `extractGrid` (parallel workers, abortable, progress).
- **CF time axis** — decode timesteps; select a timestep by `date` (nearest match); `timeRange` / per-axis start–end exposed by `scan`.
- **Output** — `gridToGeoTIFF`, `gridToJSON`, `gridToImageData` / `gridToPNG` (viridis / plasma / grayscale / RdBu ramps).
- **`slim()`** — in-place file trimming across GRIB2 / NetCDF3 / NetCDF4 / Zarr.

### ⚠️ Not yet supported
- Zarr filters (`fixedscaleoffset`, `delta`, …).
- Zarr v3.

## Roadmap

### Sprint 7 — `api-demo` UX + large-file testing
1. **Improve the `api-demo` UX** so users can comfortably test the library end-to-end — clearer scan/extract flows, better feedback, and easier inspection of results.
2. **Heavy testing on large files** — exercise the existing pipeline (streaming scan, COG HTTP Range reads, parallel `extractGrid`, `slim`) against big real-world inputs to validate performance and memory behavior.

## Building the WASM

Only needed if you change the C sources.

```bash
python wasm/build.py
```

Requires Emscripten (`emcc`) on `PATH`. Produces `wasm/webparsers.wasm` and `wasm/webparsers.js`.

## License

MIT.
