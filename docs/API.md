# webparsers — JavaScript / TypeScript API

A WebAssembly-powered library for parsing meteorological data formats.
Three calls cover the common cases:

| Function        | Returns                                                      | Use for                      |
| --------------- | ------------------------------------------------------------ | ---------------------------- |
| `detectFormat`  | `'grib2' \| 'netcdf3' \| 'netcdf4' \| 'zarr' \| null`      | Sniff a file's format        |
| `scan`          | metadata + variable list                                     | List what's in the file      |
| `extract`       | structured object                                            | Pull values for a variable   |
| `extractOutput` | `string` (JSON or CSV)                                       | Same, ready to write to disk |
| `slim`          | `{ bytes, format, warnings, stats }`                         | Trim a huge file in place    |

Supported formats:

| Format                  | Extension(s)          | Notes                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------------ |
| **GRIB2**               | `.grb2`, `.grib2`     | Grid templates 0, 30, 40, 101                                |
| **NetCDF3 Classic**     | `.nc3`                | Full CF coordinate support                                   |
| **NetCDF4 / HDF5**      | `.nc`, `.nc4`         | Uses `h5wasm` under the hood; requires Node 18+ / browser    |
| **Zarr v2** *(zip)*     | `.zarr.zip`, `.zip`   | null / gzip / zlib compressors; synthetic axes (see below)   |

---

## Library structure

```
webparsers/
├── index.js          ← front-facing entry point  (import from here)
├── index.d.ts        ← TypeScript types
├── package.json
└── wasm/             ← internal implementation (do not import directly)
    ├── webparsers.js        Emscripten WASM loader
    ├── webparsers.wasm      compiled C binary
    ├── webparsers-lib.js    core class
    ├── webparsers-api.js    functional API
    └── zarr-helper.js       Zarr v2 helper
```

All public symbols are re-exported through `index.js`.
Files inside `wasm/` are internal — they may change without notice.

---

## Install

```bash
# from GitHub (until published to npm)
npm install git+https://github.com/<org>/webparsers.git
```

---

## Import

```js
// Functional API — recommended for most consumers
import { detectFormat, scan, extract, extractOutput } from 'webparsers';

// Error classes — same package, no extra import path needed
import { WebparsersError, UnsupportedFormatError, VariableNotFoundError } from 'webparsers';

// Class-based API — for advanced / low-level use
import { WebParsers } from 'webparsers';
```

TypeScript types ship with the package — no `@types/*` needed.

---

## Source types accepted

Every function takes a `source` as its first argument:

| Type                    | Notes                                                        |
| ----------------------- | ------------------------------------------------------------ |
| `Uint8Array`            | Raw bytes — fastest, no copy                                 |
| `ArrayBuffer`           | Wrapped into `Uint8Array` automatically                      |
| `Blob` / `File`         | Browser `<input type="file">` or `fetch()` response body    |
| `URL` / `string` URL    | Fetched fully into memory (`http://`, `https://`, `file://`) |

---

## `detectFormat(source)`

Magic-byte sniff only — does **not** initialise WASM. Returns `null` for anything unrecognised.

```js
await detectFormat(file);                        // 'grib2'
await detectFormat('https://…/forecast.nc');     // 'netcdf4'
await detectFormat(zarrZip);                     // 'zarr'
await detectFormat(new Uint8Array([0,1,2,3]));   // null
```

| Magic bytes          | Detected as  |
| -------------------- | ------------ |
| `GRIB` (0x47525942) | `'grib2'`    |
| `CDF\x01` / `CDF\x02` | `'netcdf3'` |
| `\x89HDF\r\n\x1a\n` | `'netcdf4'`  |
| `PK\x03\x04` (ZIP)  | `'zarr'`     |

---

## `scan(source, opts?)`

Loads and scans the file. Returns metadata and the full variable list.

```js
const meta = await scan(file);

console.log(meta.format);           // 'grib2' | 'netcdf3' | 'netcdf4'
console.log(meta.total_variables);  // 12
console.log(meta.variable_names);   // ['2t', 'sp', ...]

console.log(meta.variables[0]);
// {
//   index: 0, name: '2t', supported: true,
//   grid_template: 101, data_template: 0,
//   nx: 2949120, ny: 1, messages: 1
// }
```

Format-specific fields in the result:

| Format      | Extra fields on `ScanResult`                                         |
| ----------- | -------------------------------------------------------------------- |
| GRIB2       | `grid_templates[]`, `data_templates[]`                               |
| NetCDF3/4   | `shapes[]`, `units[]`                                                |
| Zarr v2     | `shapes[]`, `dtypes[]`, `compressors[]`                              |

Each variable in `variables[]` also carries format-specific fields:

```js
// GRIB2 variable
{ index: 0, name: '2t', supported: true, grid_template: 101, nx: 2949120, ny: 1, messages: 1 }

// NetCDF3 / NetCDF4 variable
{ index: 0, name: 'precipitation', supported: true, long_name: '...', units: 'mm', shape: '1x721x1440', ndims: 3 }

// Zarr v2 variable
{ index: 0, name: 'temperature', supported: true, shape: [12, 721, 1440], chunks: [1, 721, 1440], dtype: '<f4', compressor: 'zlib' }
```

---

## `extract(source, options)`

Decode one or more variables. Returns a structured JS object.

| Option       | Type                 | Notes                                             |
| ------------ | -------------------- | ------------------------------------------------- |
| `variable`   | `string \| string[]` | Name(s) from `scan`. Omit → all supported vars.   |
| `lat`, `lon` | `number`             | Nearest-grid-point lookup. Omit for whole grid.   |
| `t1`, `t2`   | `number`             | Time-index range (inclusive). Default: all.       |

```js
// Single variable, single point
const result = await extract(file, {
  variable: '2t',
  lat: 52.52, lon: 13.40,   // Berlin
});
// { variable: '2t', location: { lat, lon }, value: 271.4, time: 1734566400 }

// Multiple variables — returns { variables: [...] }
const multi = await extract(file, {
  variable: ['TMP', 'UGRD'],
  lat: 40.7, lon: -74.0,
  t1: 0, t2: 5,
});
```

---

## `extractOutput(source, options, format?)`

Same as `extract`, but returns a serialised **string** instead of an object.
`format` is `'json'` (default) or `'csv'`.

```js
import { writeFileSync } from 'node:fs';

// CSV
const csv = await extractOutput(file, { variable: '2t', lat: 52.52, lon: 13.40 }, 'csv');
writeFileSync('berlin.csv', csv);
// variable,time,value,lat,lon
// 2t,1734566400,271.4,52.52,13.4

// JSON string (pretty-printed)
const json = await extractOutput(file, { variable: '2t' });
writeFileSync('result.json', json);
```

---

## Zarr v2 notes

Zarr v2 files must be **zipped** (`.zarr.zip` or `.zip`) — directory-format Zarr is not supported.
The library reads the ZIP, finds all `.zarray` metadata entries, and treats each top-level array as a variable.

**Supported compressors:** `null` (no compression), `gzip`, `zlib`.
**Unsupported compressors:** `blosc`, `zstd`, `lz4` — these throw a clear `UnsupportedFormatError`.

**Synthetic axes:** Zarr v2 arrays don't carry CF coordinate metadata, so the library assigns
synthetic axes for the query engine:

| Axis   | Synthetic value                |
| ------ | ------------------------------ |
| lat    | `lats[j] = j`                  |
| lon    | `lons[i] = i`                  |
| time   | `times[t] = t × 86400`         |

This means `lat: 0, lon: 0` lands on grid point `(0, 0)`, and `t1: 0, t2: 5` returns the first
six time steps. Real geographic queries require external coordinate data (planned for a future sprint).

```js
import { scan, extract } from 'webparsers';
import { readFileSync } from 'node:fs';

const file = new Uint8Array(readFileSync('data.zarr.zip'));

const meta = await scan(file);
// meta.format === 'zarr'
// meta.variables[0] → { name: 'temperature', shape: [12,721,1440], dtype: '<f4', compressor: 'zlib', supported: true }

const result = await extract(file, {
  variable: 'temperature',
  lat: 0, lon: 0,   // synthetic: grid point (j=0, i=0)
  t1: 0, t2: 11,   // all 12 time steps
});
```

---

## `slim(source, options)`

Produce a smaller file in the **same format** as the input, containing only
the selected variables (and optionally a time-axis slice). The result is a
`Uint8Array` plus a stats/warnings envelope.

Per-format strategy:

| Format       | How it's slimmed                                    | Decode? |
| ------------ | --------------------------------------------------- | ------- |
| **GRIB2**    | Filter messages by variable + valid time; concat    | No      |
| **NetCDF3**  | Rewrite header with kept vars; copy data spans      | No      |
| **Zarr** (zip) | Filter zip entries by var + chunk; re-zip         | No      |
| **NetCDF4**  | Open with h5wasm; copy selected datasets to new file | Partial (HDF5 re-frames B-trees) |

```js
import { slim } from 'webparsers';

const result = await slim(file, {
  variables: ['2t', 'sp'],   // names from scan().variable_names
  t1: 0, t2: 23,             // optional inclusive time-axis range
});

console.log(result.format);            // 'grib2' | 'netcdf3' | 'netcdf4' | 'zarr'
console.log(result.stats);             // { inputSize, outputSize, variablesKept, variablesDropped }
console.log(result.warnings);          // human-readable notes (e.g. Zarr boundary widening)
fs.writeFileSync('slim.grb2', result.bytes);
```

### Options

| Option       | Type        | Notes                                                          |
| ------------ | ----------- | -------------------------------------------------------------- |
| `variables`  | `string[]`  | **Required.** Variable names to keep. Same naming as `scan()`. |
| `t1`         | `number`    | Inclusive lower time-axis index. Defaults to `0`.              |
| `t2`         | `number`    | Inclusive upper time-axis index. Defaults to the last one.     |

`t1`/`t2` semantics match `extract()` — they're indices into the variable's
time axis in the order `scan()` reports.

### Result shape

```ts
{
  bytes:    Uint8Array,                                  // the slimmed file
  format:   'grib2' | 'netcdf3' | 'netcdf4' | 'zarr',
  warnings: string[],                                    // see below
  stats: {
    inputSize: number,
    outputSize: number,
    variablesKept: number,
    variablesDropped: number,
  },
}
```

### Boundary widening (Zarr only)

Zarr chunks are atomic — the whole chunk is either present or absent. If
the requested `[t1, t2]` range crosses chunk boundaries, the slim widens
to keep every chunk that *touches* the range. The actual time range that
ends up in the output is reported in `warnings`:

```text
Zarr variable 'temperature': time range [3,7] widened to [0,7]
because chunk size along time axis is 8
```

GRIB2 (one timestep per message), NetCDF3 (records addressable
individually), and NetCDF4 (h5wasm hyperslab) all give exact ranges.

### Errors

| Thrown                       | When                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| `SlimError`                  | Invalid `opts`, out-of-range `t1`, format-specific failure   |
| `VariableNotFoundError`      | A requested variable isn't in the source                    |
| `UnsupportedFormatError`     | The source isn't one of the four supported formats          |

### Known limitations (v1)

- **Spatial bbox** is not yet supported. Tracked for a follow-up sprint.
- **NetCDF4** writes via h5wasm into the WASM heap, so the practical
  output cap is ~1–2 GB.
- **NetCDF4** v1 walks **top-level datasets only** — datasets nested
  inside HDF5 groups are not copied. Most NetCDF4 files in the wild use
  the root group.
- **NetCDF4** dim-coord matching in `extract()` (pre-existing) uses dim
  length; if a sliced time axis ends up with the same length as another
  coordinate (e.g. `lat`), the existing extract heuristic may mis-assign
  dims. The slimmed bytes are correct — verify with a direct h5wasm read.

## Class-based API (`WebParsers`)

For cases where you need to reuse a single loaded file across multiple queries:

```js
import { WebParsers } from 'webparsers';

const parser = new WebParsers();
await parser.read(fileBytes);              // load once

const vars = parser.getvariables();        // same as scan().variables
const data = await parser.extract({        // same options as extract()
  variable: '2t', lat: 52.52, lon: 13.40,
});

parser.close();                            // always free WASM memory when done
```

---

## Error handling

All errors extend `WebparsersError`:

```js
import {
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from 'webparsers';

try {
  await scan(unknownBytes);
} catch (e) {
  if (e instanceof UnsupportedFormatError) { /* format not recognised */ }
  else if (e instanceof SourceError)       { /* fetch / read failed   */ }
  else if (e instanceof VariableNotFoundError) { /* bad variable name */ }
  else throw e;
}
```

| Error                    | When thrown                                           |
| ------------------------ | ----------------------------------------------------- |
| `UnsupportedFormatError` | Magic bytes don't match any supported format          |
| `VariableNotFoundError`  | Named variable absent or not `supported: true`        |
| `SourceError`            | URL fetch failed, unsupported source type             |
| `ExtractError`           | Decoder failed for a variable the library knows about |
| `WebparsersError`        | Base class — catches anything thrown by this library  |

---

## Node.js usage

The library ships as ESM and works in Node 18+ out of the box — no extra setup needed.

```js
import { readFileSync } from 'node:fs';
import { scan, extract } from 'webparsers';

const file = new Uint8Array(readFileSync('forecast.grb2'));

const meta = await scan(file);
console.log(meta.format, meta.variable_names);

const result = await extract(file, { variable: meta.variables[0].name, lat: 52.52, lon: 13.40 });
console.log(result);
```

Run the included demos:

```bash
npm run demo:grib2
npm run demo:netcdf3
npm run demo:netcdf4
```

---

## Browser usage

Import via a bundler (Vite, webpack, etc.) or use an import map for bare module names.

```html
<!-- Import map needed for browser bare-module resolution -->
<script type="importmap">
{
  "imports": {
    "webparsers": "/node_modules/webparsers/index.js",
    "h5wasm":     "/node_modules/h5wasm/dist/esm/hdf5_hl.js"
  }
}
</script>
<script type="module">
  import { scan } from 'webparsers';

  document.querySelector('#file').addEventListener('change', async (e) => {
    const meta = await scan(e.target.files[0]);
    console.log(meta);
  });
</script>
```

With a bundler (recommended for production), the import map is not needed — just:

```js
import { scan } from 'webparsers';
```
