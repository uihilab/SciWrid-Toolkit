# webparsers

JavaScript / TypeScript library for parsing meteorological and geospatial data formats — **GRIB2**, **NetCDF3**, **NetCDF4 / HDF5**, **Zarr v2**, and **TIFF / GeoTIFF (including Cloud-Optimized GeoTIFFs)** — in the browser, Web Workers, and Node 18+. Powered by a pure-C engine compiled to WebAssembly via Emscripten.

## Install

Until published to npm:

```bash
npm install git+https://github.com/<org>/webparsers.git
```

End users do **not** need to install peer compression libraries — `h5wasm` (NetCDF4) and `numcodecs` (Zarr blosc/zstd/lz4) are lazy-loaded from jsdelivr on first use.

## Supported formats

| Format | Extensions | Notes |
|---|---|---|
| GRIB2 | `.grb2`, `.grib2` | Grid templates 0, 30, 40, 101 |
| NetCDF3 Classic | `.nc3` | Full CF coordinate support |
| NetCDF4 / HDF5 | `.nc`, `.nc4` | Loads `h5wasm` from CDN on first use |
| Zarr v2 (zip) | `.zip`, `.zarr` | Compressors: `null`, `gzip`, `zlib`, `blosc`, `zstd`, `lz4`. Filters (`fixedscaleoffset`, `delta`, …) not yet supported. |
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
  SourceError, ExtractError, SlimError,
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
│   ├── zarr-helper.js      Zarr v2 reader
│   └── grid-output.js      GeoTIFF / JSON serialisers
├── wasm/               ← WASM artifacts + C build (internal)
│   ├── webparsers.wasm     compiled C core (~91 KB)
│   ├── webparsers.js       Emscripten loader
│   ├── wasm_api.c          C bindings
│   └── build.py            build script
├── worker/             ← Web Worker for parallel bbox extraction
├── examples/           ← demoGrib2File.js, demoZarrFile.js, api-demo.html
├── scripts/            ← test:api, test:grid, test:zarr, demo:web
├── docs/               ← API.md
└── formats/            ← C sources for the WASM build (GRIB2, NetCDF)
```

## Run the demos

```bash
npm run demo:web        # serves examples/api-demo.html on localhost
npm run demo:grib2      # CLI: scan + extract a sample GRIB2 file
npm run demo:zarr       # CLI: scan + extract a sample Zarr file
npm run test:zarr       # smoke tests for the Zarr path
npm run test:grid       # smoke tests for extractGrid
npm run test:slim       # smoke tests for slim() across all four formats
```

The `demo:web` page lets you drop a `.grb2`, `.nc`, or `.zip`/`.zarr` file in directly and run `scan` / `extract` / `extractGrid` interactively (heat-map canvas, progress, abort, GeoTIFF / JSON download).

## Building the WASM

Only needed if you change the C sources.

```bash
python wasm/build.py
```

Requires Emscripten (`emcc`) on `PATH`. Produces `wasm/webparsers.wasm` and `wasm/webparsers.js`.

## License

MIT.
