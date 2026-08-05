# SciWrid Toolkit — JavaScript / TypeScript API

A WebAssembly-powered library for parsing meteorological and geospatial data
formats. New here? Jump to **[Choosing your pathway](#choosing-your-pathway)** —
it routes you from "what I have" to the right function in one screen.

Supported formats:

| Format                  | Extension(s)          | Notes                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------------ |
| **GRIB2**               | `.grb2`, `.grib2`     | Grid templates 0, 30, 40, 101; simple + complex packing; Section-6 bitmaps (masked points → `NaN`) |
| **NetCDF3 Classic**     | `.nc3`                | Full CF coordinate support                                   |
| **NetCDF4 / HDF5**      | `.nc`, `.nc4`         | Uses `h5wasm` under the hood; requires Node 18+ / browser    |
| **Zarr v2** *(zip)*     | `.zarr.zip`, `.zip`   | Compressors `null`/`gzip`/`zlib` (built-in) + `blosc`/`zstd`/`lz4` (via numcodecs); synthetic axes (see below) |
| **TIFF / GeoTIFF**      | `.tif`, `.tiff`       | UInt8/16/Int16/Float32; LZW/Deflate; horizontal/FP predictor; WGS84/UTM/sinusoidal; tile + strip; COG over HTTP Range |

---

## Choosing your pathway

There's more than one way through this library. The two questions that actually
branch the API are **"point or area?"** and **"object or file-ready output?"**.
Pick your path here, then jump to that function's reference below.

```
You have a file / URL / bytes
        │
        ├─ "What format is this?" ..................... detectFormat   → 'grib2'…'tiff' | null
        ├─ "What's inside?" (vars, time axis, bbox) ... scan           → metadata object
        │
        └─ "Give me the data"
              │
              ├─ at ONE point (lat/lon) ............... extract            → object
              │                                         extractOutput      → JSON / CSV string
              │
              └─ over an AREA (bbox) .................. extractGrid        → Float32 grid
                                                        extractGridOutput  → JSON / GeoTIFF / PNG / ImageData
                                                              │
                                                              ├─ draw on a web map → gridToImageData / gridToPNG (+ ramps)
                                                              └─ save as a raster  → gridToGeoTIFF / gridToJSON

Want a smaller file, same format out?  ............... trim               → { bytes, … }
Reusing one loaded file for many queries? ............ SciWridToolkit (class) → instance
```

| I want to…                                  | Function                          | Returns                              |
| ------------------------------------------- | --------------------------------- | ------------------------------------ |
| Sniff the format without parsing            | [`detectFormat`](#detectformatsource)         | `'grib2'…'tiff' \| null`             |
| List variables / time axis / bbox           | [`scan`](#scansource-opts)                    | metadata object                      |
| One value at a lat/lon                       | [`extract`](#extractsource-options)           | object                               |
| …as a JSON/CSV string to save               | [`extractOutput`](#extractoutputsource-options-format) | `string`                    |
| A whole bbox grid (parallel, abortable)      | [`extractGrid`](#extractgridsource-options)   | `{ data: Float32Array, … }`          |
| …as JSON / GeoTIFF / PNG / ImageData         | [`extractGridOutput`](#extractgridoutputsource-options-format) | `string \| Uint8Array \| ImageData` |
| Render a grid for a web map                  | [`gridToImageData`](#gridtoimagedatagrid-opts) / [`gridToPNG`](#gridtopnggrid-opts) | RGBA / PNG       |
| Save a grid as a raster                      | [`gridToGeoTIFF`](#map-rendering) / `gridToJSON` | `Uint8Array` / `string`           |
| Trim a huge file, same format                | [`trim`](#trimsource-options)                 | `{ bytes, … }`                       |
| Reuse one loaded file across queries         | [`SciWridToolkit` class](#class-based-api-SciWrid Toolkit) | instance                         |

Every reader produces the **same** `scan` / `extract` / `extractGrid` shapes
regardless of format, so once you've chosen a pathway it works identically for
GRIB2, NetCDF3/4, Zarr, and TIFF/COG. For the *internals* of how each format is
decoded, see the decode-logic docs under `docs/webparsers/logic/`.

---

## Library structure

```
sciwrid-toolkit/
├── index.js          ← front-facing entry point  (import from here)
├── index.d.ts        ← TypeScript types
├── lib/              ← JavaScript library source (internal — do not import directly)
│   ├── sciwrid-api.js    functional API (scan/extract/extractGrid/trim/…)
│   ├── sciwrid-lib.js    core class (SciWridToolkit)
│   ├── zarr-helper.js       Zarr v2 helper           tiff-helper.js  TIFF/GeoTIFF
│   ├── render/              color ramps + grid → RGBA / PNG
│   └── trim/                in-place file trimming (per-format)
├── wasm/             ← compiled C core (internal)
│   ├── sciwrid.js        Emscripten WASM loader
│   └── sciwrid.wasm      compiled C binary
├── worker/           ← Web Worker for parallel bbox extraction
└── dist/             ← the published, bundled package (produced by `npm run build`)
```

All public symbols are re-exported through `index.js` (which `npm run build`
bundles into `dist/index.js`). Files inside `lib/`, `wasm/`, and `worker/` are
internal — import only from the package root (`'sciwrid-toolkit'`).

---

## Install

```bash
# from GitHub (until published to npm)
npm install git+https://github.com/uihilab/SciWrid-Toolkit.git
```

---

## Import

```js
// Functional API — recommended for most consumers
import { detectFormat, scan, extract, extractOutput } from 'sciwrid-toolkit';

// Error classes — same package, no extra import path needed
import { SciWridError, UnsupportedFormatError, VariableNotFoundError } from 'sciwrid-toolkit';

// Class-based API — for advanced / low-level use
import { SciWridToolkit } from 'sciwrid-toolkit';
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

| Magic bytes              | Detected as  |
| ------------------------ | ------------ |
| `GRIB` (0x47525942)      | `'grib2'`    |
| `CDF\x01` / `CDF\x02`    | `'netcdf3'`  |
| `\x89HDF\r\n\x1a\n`      | `'netcdf4'`  |
| `PK\x03\x04` (ZIP)       | `'zarr'`     |
| `II*\x00` (little-endian TIFF) | `'tiff'` |

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
| GRIB2       | `grid_templates[]`, `data_templates[]`, `bbox`                       |
| NetCDF3/4   | `shapes[]`, `units[]`, `bbox`                                        |
| Zarr v2     | `shapes[]`, `dtypes[]`, `compressors[]`, `bbox`                      |
| Parquet     | `gridTypes[]`, `bbox`                                                |

### `meta.bbox` — where the data actually is

```js
const meta = await scan(file);
meta.bbox;   // [minLon, minLat, maxLon, maxLat]  in degrees, or undefined
```

**Use it as the `bbox` you pass to [`extractGrid`](#extractgridsource-options), and as the
bounds you place the resulting image at.** `extractGrid` requires a `bbox` and returns the
same one it was given, so those two must agree or the raster lands in the wrong place.

For projected grids (polar stereographic, Lambert) this is the envelope of the whole grid
rectangle, which is wider than the area holding valid data — that is intentional. The extra
cells come back as `NaN`, and the image is correctly georeferenced. NCEP Stage IV, for
example, reports `[-134.04, 19.81, -59.96, 57.84]`: its maximum latitude occurs in the
*middle* of the north edge, not at a corner, so a four-corner box would clip it by 4°.

Note Leaflet expects `[[south, west], [north, east]]` while `bbox` is longitude-first:

```js
const [w, s, e, n] = meta.bbox;
L.imageOverlay(pngUrl, [[s, w], [n, e]]).addTo(map);
```

`bbox` is `undefined` when the extent cannot be derived — a grid template whose coordinates
we do not build, or a store with only synthetic axes. Treat it as optional.

Each variable in `variables[]` also carries format-specific fields:

```js
// GRIB2 variable
{ index: 0, name: '2t', supported: true, grid_template: 101, nx: 2949120, ny: 1, messages: 1 }

// NetCDF3 / NetCDF4 variable
{ index: 0, name: 'precipitation', supported: true, long_name: '...', units: 'mm', shape: '1x721x1440', ndims: 3 }

// Zarr v2 variable
{ index: 0, name: 'temperature', supported: true, shape: [12, 721, 1440], chunks: [1, 721, 1440], dtype: '<f4', compressor: 'zlib' }
```

### Time metadata

If the file has a time axis, `scan()` decodes it into ISO-8601 strings using
the file's CF `units` and `calendar` attributes:

```js
const meta = await scan(file);

// If every multi-dim variable shares the same time axis, it's surfaced at
// the top level:
meta.times;
// {
//   values:   ['2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z', '2024-01-01T06:00:00Z', ...],
//   unitsRaw: 'hours since 2024-01-01',
//   calendar: 'standard',
// }

// Otherwise each variable carries its own:
meta.variables[0].times;
```

Each time axis also carries convenience `start` / `end` (first and last
timestamp), and `scan()` adds a file-level **`timeRange`** spanning the whole
file — the earliest start and latest end across every axis:

```js
meta.timeRange;          // { start: '2026-04-14T06:00:00Z', end: '2026-04-14T12:00:00Z' }
meta.variables[0].times.start;  // first timestep of that variable
```

`timeRange` is present whenever the file has any time axis (even when times are
per-variable rather than hoisted to `meta.times`).

Supported calendars: `standard` (a.k.a. `gregorian`, `proleptic_gregorian`),
`noleap` (a.k.a. `365_day`), and `360_day`. Unsupported calendars degrade
gracefully — `times` is omitted and a warning is added to the affected
variable's `warnings[]`.

Per-format support today:

| Format    | Time decoding                                                                       |
| --------- | ----------------------------------------------------------------------------------- |
| GRIB2     | Per-message `valid_time` already exposed by the WASM engine, grouped by variable    |
| Zarr v2   | Reads the time coord array + `.zattrs` (`units`, `calendar`); Float64 precision     |
| NetCDF4   | Reads the time variable's HDF5 attrs via h5wasm                                     |
| NetCDF3   | Currently extract-only — a `wp_nc3_get_time_units_json` C accessor is needed to surface times in `scan()`. Tracked as a follow-up. |
| TIFF      | No time axis. `DateTime` tag (306) surfacing is a follow-up.                        |

---

## `extract(source, options)`

Decode one or more variables. Returns a structured JS object.

| Option       | Type                 | Notes                                             |
| ------------ | -------------------- | ------------------------------------------------- |
| `variable`   | `string \| string[]` | Name(s) from `scan`. Omit → all supported vars.   |
| `lat`, `lon` | `number`             | Nearest-grid-point lookup. Omit for whole grid.   |
| `t1`, `t2`   | `number`             | Time-index range (inclusive). Default: all.       |
| `date`       | `string \| number \| Date` | Single timestep by date (nearest match). Mutually exclusive with `t1`/`t2`. |
| `dateRange`  | `[start, end]`       | Timestep range by date (nearest start/end). Mutually exclusive with `t1`/`t2`. |

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

### Selecting timesteps by date

Instead of integer `t1`/`t2` (extract) or `time` (extractGrid), pass a date —
an ISO-8601 string, a `Date`, or epoch milliseconds:

```js
// nearest timestep to a date
await extract(file, { variable: 'TMP', date: '2026-04-14T12:00:00Z' });
// a date range → nearest start/end indices
await extract(file, { variable: 'TMP', dateRange: ['2026-04-14T06:00:00Z', '2026-04-14T18:00:00Z'] });
// single timestep for a grid
await extractGrid(file, { variable: 'TMP', bbox, width: 256, height: 256, date: '2026-04-14T12:00:00Z' });
```

Matching is **nearest** against the file's decoded time axis. A `dateRange`
bound given as a **date only** (`YYYY-MM-DD`, no time) expands to the whole UTC
day — start → `00:00:00.000`, end → `23:59:59.999` — and every timestep inside
the window is kept. So `dateRange: ['1990-01-01', '1990-01-01']` selects all
timesteps on that day, no need to spell out the time. Mixing a date option with
an integer index for the same axis throws `SciWridError`. For
Zarr arrays without CF time metadata the synthetic axis is `step t = t days`
(`t·86400 s`), so a date is matched against that. Files with a single timestep
(or no time axis) resolve any date to index 0. `trim` remains index-only.

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

## `extractGrid(source, options)`

Resample a variable over a **bounding box** into a dense, north-up `Float32`
grid. This is the heavy-lifting pathway: it runs across parallel workers, is
abortable, and reports progress. Use it whenever you want an *area* rather than
a single point — heat maps, raster export, tiles.

| Option       | Type                          | Notes                                                              |
| ------------ | ----------------------------- | ------------------------------------------------------------------ |
| `variable`   | `string`                      | **Required.** Name from `scan().variable_names`.                   |
| `bbox`       | `[minLon, minLat, maxLon, maxLat]` | **Required.** Geographic bounds, degrees.                     |
| `width`      | `number`                      | **Required.** Output columns.                                      |
| `height`     | `number`                      | **Required.** Output rows.                                         |
| `time`       | `number`                      | Time-axis index. Default `0`.                                      |
| `date`       | `string \| number \| Date`    | Single timestep by date (nearest match). Mutually exclusive with `time`. |
| `workers`    | `number`                      | Parallel workers. Default `5`; `0` forces inline (single-threaded). |
| `signal`     | `AbortSignal`                 | Abort the run; rejects with an `AbortError`.                       |
| `onProgress` | `({done, total}) => void`     | Called as output cells are filled.                                 |

```js
import { extractGrid } from 'sciwrid-toolkit';

const controller = new AbortController();

const grid = await extractGrid(file, {
  variable: 'TMP',
  bbox:     [-100, 30, -80, 45],   // [minLon, minLat, maxLon, maxLat]
  width:    256, height: 256,
  workers:  5,
  signal:   controller.signal,
  onProgress: ({ done, total }) => console.log(`${done}/${total}`),
});
```

### Result shape

```ts
{
  data:     Float32Array,   // length width*height, row-major, row 0 = maxLat (north-up)
  width:    number,
  height:   number,
  bbox:     [number, number, number, number],
  variable: string,
  units:    string | undefined,
  time:     number | string | undefined,
}
```

Cells are **row-major** with **row 0 at `maxLat`** (north-up), so `data[y*width + x]`
is the value at output pixel `(x, y)`. Missing / masked points are `NaN` — the
render helpers paint those transparent.

> **Same shape, every format.** GRIB2, NetCDF3/4, Zarr, and TIFF/COG all return
> this identical `ExtractGridResult`, so the render and output helpers below work
> the same regardless of the input format. For Zarr without CF coordinates, the
> grid is indexed against the synthetic axes (see [Zarr v2 notes](#zarr-v2-notes)).

---

## `extractGridOutput(source, options, format?)`

Same as `extractGrid`, but returns a **file-ready** result instead of the raw
grid object — handy for one-shot "give me a blob to save/serve" callers.

| `format`        | Returns                | Use for                              |
| --------------- | ---------------------- | ------------------------------------ |
| `'json'`        | `string`               | Grid + metadata as JSON (`pretty` opt) |
| `'geotiff'`     | `Uint8Array`           | A WGS84 Float32 GeoTIFF              |
| `'png'`         | `Promise<Uint8Array>`  | Colored PNG (pass `ramp`, `vmin`, `vmax`) |
| `'imagedata'`   | `{ width, height, data }` | RGBA for a `<canvas>` / MapLibre   |

```js
// Save a GeoTIFF straight from a bbox query
const tiff = await extractGridOutput(file, {
  variable: 'TMP', bbox: [-100, 30, -80, 45], width: 512, height: 512,
}, 'geotiff');
writeFileSync('tmp.tif', tiff);
```

For the in-memory grid, prefer `extractGrid`; the render helpers
([`gridToImageData`](#gridtoimagedatagrid-opts) / [`gridToPNG`](#gridtopnggrid-opts))
and [`gridToGeoTIFF`](#map-rendering) are documented under **Map rendering** below.

---

## Zarr v2 notes

Zarr v2 files must be **zipped** (`.zarr.zip` or `.zip`) — directory-format Zarr is not supported.
The library reads the ZIP, finds all `.zarray` metadata entries, and treats each top-level array as a variable.

**Supported compressors:**
- Built-in (no extra dependency, via the platform `DecompressionStream`): `null` (no compression), `gzip`, `zlib`.
- Lazy-loaded via `numcodecs` (fetched from npm in Node / jsdelivr in the browser on first use): `blosc`, `zstd`, `lz4`.

Any other compressor id throws a clear error. **Filters** other than `shuffle` (e.g. `fixedscaleoffset`, `delta`) are not yet supported.

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
import { scan, extract } from 'sciwrid-toolkit';
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

## `trim(source, options)`

Produce a smaller file in the **same format** as the input, containing only
the selected variables (and optionally a time-axis or spatial bbox slice). The
result is a `Uint8Array` plus a stats/warnings envelope.

Per-format strategy:

| Format       | How it's trimmed                                    | Decode? |
| ------------ | --------------------------------------------------- | ------- |
| **GRIB2**    | Filter messages by variable + valid time; concat    | No      |
| **NetCDF3**  | Rewrite header with kept vars; copy data spans      | No      |
| **Zarr** (zip) | Filter zip entries by var + chunk; re-zip         | No      |
| **NetCDF4**  | Open with h5wasm; copy selected datasets to new file | Partial (HDF5 re-frames B-trees) |
| **TIFF**     | Copy or re-encode kept bands/blocks; update IFD tags | Partial |

Zarr trim accepts both stored and DEFLATE-compressed `.zip` entries; the
trimmed output is itself a valid Zarr zip that `scan`/`extract` can read back.
Data chunks are passed through verbatim (no re-encode).
When `trim()` slices a Zarr store along time or a bbox, the matching 1-D
coordinate arrays (`time`/`lat`/`lon`) are decoded and re-sliced to the same
extent so the output's axes stay consistent and re-read correctly. Limitations:
coordinate arrays that are multi-chunk or zarr-compressed are kept at full
length (a warning is emitted); byte-cut slicing widens to chunk boundaries, so a
store whose spatial chunks span the whole dimension will not shrink along
lat/lon.

```js
import { trim } from 'sciwrid-toolkit';

const result = await trim(file, {
  variables: ['2t', 'sp'],   // names from scan().variable_names
  t1: 0, t2: 23,             // optional inclusive time-axis range
  bbox: [-100, 30, -80, 45], // optional [minLon, minLat, maxLon, maxLat]
});

console.log(result.format);            // 'grib2' | 'netcdf3' | 'netcdf4' | 'zarr' | 'tiff'
console.log(result.stats);             // { inputSize, outputSize, variablesKept, variablesDropped }
console.log(result.warnings);          // human-readable notes (e.g. Zarr boundary widening)
fs.writeFileSync('trim.grb2', result.bytes);
```

### Options

| Option       | Type        | Notes                                                          |
| ------------ | ----------- | -------------------------------------------------------------- |
| `variables`  | `string[]`  | **Required.** Variable names to keep. Same naming as `scan()`. |
| `t1`         | `number`    | Inclusive lower time-axis index. Defaults to `0`.              |
| `t2`         | `number`    | Inclusive upper time-axis index. Defaults to the last one.     |
| `bbox`       | `[number, number, number, number]` | Optional WGS84 spatial clip as `[minLon, minLat, maxLon, maxLat]`. |

`t1`/`t2` semantics match `extract()` — they're indices into the variable's
time axis in the order `scan()` reports.

### Result shape

```ts
{
  bytes:    Uint8Array,                                  // the trimmed file
  format:   'grib2' | 'netcdf3' | 'netcdf4' | 'zarr' | 'tiff',
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
the requested `[t1, t2]` range crosses chunk boundaries, the trim widens
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
| `TrimError`                  | Invalid `opts`, out-of-range `t1`, format-specific failure   |
| `VariableNotFoundError`      | A requested variable isn't in the source                    |
| `UnsupportedFormatError`     | The source isn't one of the supported formats               |

### Known limitations (v1)

- **Spatial bbox** is supported for Zarr, NetCDF4, and TIFF. GRIB2 and NetCDF3 bbox trimming are still tracked for a follow-up sprint.
- **NetCDF4** writes via h5wasm into the WASM heap, so the practical
  output cap is ~1–2 GB.
- **NetCDF4** v1 walks **top-level datasets only** — datasets nested
  inside HDF5 groups are not copied. Most NetCDF4 files in the wild use
  the root group.
- **NetCDF4** dim-coord matching in `extract()` (pre-existing) uses dim
  length; if a sliced time axis ends up with the same length as another
  coordinate (e.g. `lat`), the existing extract heuristic may mis-assign
  dims. The trimmed bytes are correct — verify with a direct h5wasm read.

## GeoTIFF (`.tif` / `.tiff`)

`scan`, `extract`, and `extractGrid` all accept TIFF and GeoTIFF files.

### Supported

| Aspect           | What's covered                                                                |
| ---------------- | ----------------------------------------------------------------------------- |
| **Byte order**   | Little-endian (`II*\x00`), big-endian (`MM\x00*`), and BigTIFF (`magic === 43`, 64-bit offsets) |
| **Sample types** | `uint8`, `uint16`, `int16`, `float32` (chunky `PlanarConfiguration=1` AND separate planes `=2`) |
| **Compression**  | None, Deflate, LZW, PackBits, JPEG (`jpeg-js` optional dep), WebP (browser only) |
| **Predictors**   | 1 (none), 2 (horizontal), 3 (floating-point — `float32` only)                 |
| **Layout**       | Strip and tile; `extractGrid` caches decoded blocks + nearest-neighbour resamples to the requested output size |
| **CRS**          | Geographic EPSG:4326, UTM north/south, Sinusoidal (MODIS), Lambert Conformal Conic (NOAA HRRR/RAP/NAM), Polar Stereographic (NSIDC 3413/3031), Albers Equal Area (USDA NASS/USGS) |
| **Multi-band**   | `SamplesPerPixel ≥ 1`; band names taken from `GDAL_METADATA` `<Item name="DESCRIPTION" sample="N">…</Item>` (fallback: `band_1`, `band_2`, …) |
| **COG**          | Overview IFDs surfaced in `scan().overviews`; `extractGrid` auto-selects the smallest overview that meets the requested output size |
| **COG over URL** | `scan` and `extract` issue HTTP Range requests for the IFD + only the needed tile/strip — the whole file is never downloaded |
| **trim()**       | Band selection + spatial bbox (snaps to block grid with a widening warning); `PlanarConfiguration=2` trim is byte-copy (no decode) |
| **Writer**       | `gridToGeoTIFF(grid, opts)` — multi-band, dtype (`float32`/`uint8`/`uint16`/`int16`), compression (`none`/`deflate`), predictor (1/2/3), CRS (any supported kind) |

### Band naming

```js
const meta = await scan(geoTiffBuf);
meta.variable_names;        // ['B04_red', 'B03_green', 'B02_blue']  (from GDAL_METADATA)
// or ['band_1', 'band_2', 'band_3'] if no GDAL_METADATA tag is present

await extract(geoTiffBuf, { variable: 'B04_red', lat: 23.5, lon: 10.5 });
```

### COG over HTTP Range

```js
const meta = await scan('https://example.com/sentinel.tif');
// Server sees: 1 small Range request for the magic bytes (16 B) + 1 Range
// request for the IFD prefix (a few KB) — not a full-file GET.

const point = await extract('https://example.com/sentinel.tif',
  { variable: 'band_1', lat: 35.0, lon: -95.0 });
// One additional Range request for the tile/strip containing that pixel.
```

The Range source falls back to a full-body GET if the server responds 200 to `Range:` (no Range support).

### Unsupported CRS

```js
import { UnsupportedCRSError } from 'sciwrid-toolkit';

try { await scan(polarStereoTiff); }
catch (e) {
  if (e instanceof UnsupportedCRSError) {
    console.log(e.epsg, e.crsName);      // e.g. 3413, 'unknown projected'
  }
}
```

### v3+ expansion list (not in this release)

- Additional compression: JPEG 2000 (libopenjp2 in WASM, follow-up sprint)
- COG overview tile pyramid auto-build in `gridToGeoTIFF` (today: single-IFD writer)
- Cross-format `trim()` bbox for GRIB2 + NetCDF3 (needs C-side accessor + WASM rebuild)
- TIFF `DateTime` tag (306) surfaced as `meta.times` (single-snapshot timestamp)
- Tiled GeoTIFF writer (today: single-strip)
- GRIB2 pre-defined / previously-defined Section-6 bitmaps (indicator 1–254); only an
  included bitmap (indicator 0) and "no bitmap" (255) decode today. Fields with a
  bitmap return masked grid points as `NaN`.

---

## Map rendering

Turn a `Float32` grid from `extractGrid` into something a web map can draw: a
colored RGBA buffer or a PNG. Both helpers are **zero-dependency** and work in
Node and the browser. They are format-agnostic — every reader produces the same
`ExtractGridResult`, so the same render path covers GRIB2, NetCDF3/4, Zarr, and
TIFF/COG.

### Color ramps

Built-in ramps: `viridis`, `plasma`, `grayscale`, and `RdBu` (diverging, for
anomalies / temperatures). Pass a built-in name **or** a custom array of
`[t, [r, g, b]]` stops (`t ∈ [0, 1]`, RGB are 0..255). Interpolation is linear
in RGB.

```js
import { RAMPS, resolveRamp, sampleRamp } from 'sciwrid-toolkit';

sampleRamp(resolveRamp('viridis'), 0.5);          // → [38, 130, 142]
const custom = [[0, [0, 0, 0]], [1, [255, 0, 0]]]; // black → red
sampleRamp(custom, 0.5);                           // → [128, 0, 0]
```

### `gridToImageData(grid, opts?)`

Float32 grid → RGBA bytes ready for a `<canvas>` or a MapLibre `ImageSource`.

```js
gridToImageData(grid, {
  ramp: 'viridis',          // built-in name or custom Ramp array (default 'viridis')
  vmin, vmax,               // optional — defaults to the grid's finite min/max
  nodataColor: [0, 0, 0, 0],// RGBA for NaN cells (default: transparent)
});
// → { width, height, data: Uint8ClampedArray }
```

The value range is auto-computed from the finite values (NaN/Infinity ignored).
NaN cells are painted with `nodataColor`. In a browser, wrap the result:
`new ImageData(data, width, height)`.

### `gridToPNG(grid, opts?)`

Same options as `gridToImageData`, but returns a PNG (`Promise<Uint8Array>`) —
8-bit RGBA, no interlace. Uses `node:zlib` in Node and `CompressionStream` in
the browser, with no extra dependency.

```js
import { extractGrid, gridToPNG } from 'sciwrid-toolkit';
import { writeFileSync } from 'node:fs';

const grid = await extractGrid(file, { variable: '2t', bbox, width: 512, height: 512 });
writeFileSync('temp.png', await gridToPNG(grid, { ramp: 'RdBu' }));
```

`extractGridOutput(source, options, format)` also accepts `'imagedata'` and
`'png'` in addition to `'json'` and `'geotiff'`.

### Full pipeline → MapLibre `ImageSource`

```js
import { extractGrid, gridToImageData } from 'sciwrid-toolkit';

const grid = await extractGrid(file, { variable, bbox, width: 1024, height: 1024 });
const img  = gridToImageData(grid, { ramp: 'viridis' });

const canvas = document.createElement('canvas');
canvas.width = img.width; canvas.height = img.height;
canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);

map.addSource('data', {
  type: 'image',
  url: canvas.toDataURL('image/png'),
  coordinates: [[bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]]],
});
map.addLayer({ id: 'data', type: 'raster', source: 'data', paint: { 'raster-opacity': 0.75 } });
```

A complete drop-a-file demo (basemap, variable picker, click-to-query, Web
Worker offload) lives at [`examples/map-demo.html`](../examples/map-demo.html).
Run it with `npm run demo:web`.

---

## Class-based API (`SciWridToolkit`)

For cases where you need to reuse a single loaded file across multiple queries:

```js
import { SciWridToolkit } from 'sciwrid-toolkit';

const parser = new SciWridToolkit();
await parser.read(fileBytes);              // load once

const vars = parser.getvariables();        // same as scan().variables
const data = await parser.extract({        // same options as extract()
  variable: '2t', lat: 52.52, lon: 13.40,
});

parser.close();                            // always free WASM memory when done
```

---

## Error handling

All errors extend `SciWridError`:

```js
import {
  SciWridError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from 'sciwrid-toolkit';

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
| `UnsupportedCRSError`    | TIFF/GeoTIFF uses a CRS outside the v1 set (`epsg`, `crsName` fields surfaced) |
| `VariableNotFoundError`  | Named variable absent or not `supported: true`        |
| `SourceError`            | URL fetch failed, unsupported source type             |
| `ExtractError`           | Decoder failed for a variable the library knows about |
| `SciWridError`        | Base class — catches anything thrown by this library  |

---

## Node.js usage

The library ships as ESM and works in Node 18+ out of the box — no extra setup needed.

```js
import { readFileSync } from 'node:fs';
import { scan, extract } from 'sciwrid-toolkit';

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
    "sciwrid-toolkit": "/node_modules/sciwrid-toolkit/index.js",
    "h5wasm":     "/node_modules/h5wasm/dist/esm/hdf5_hl.js"
  }
}
</script>
<script type="module">
  import { scan } from 'sciwrid-toolkit';

  document.querySelector('#file').addEventListener('change', async (e) => {
    const meta = await scan(e.target.files[0]);
    console.log(meta);
  });
</script>
```

With a bundler (recommended for production), the import map is not needed — just:

```js
import { scan } from 'sciwrid-toolkit';
```
