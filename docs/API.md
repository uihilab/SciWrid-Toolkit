# `webparsers/api` — JavaScript / TypeScript library

Functional façade over the WASM core. Three calls cover the common cases:

| Function          | Returns                          | Use for                          |
| ----------------- | -------------------------------- | -------------------------------- |
| `detectFormat`    | `'grib2' \| 'netcdf3' \| 'netcdf4' \| null` | Sniff a file's format       |
| `scan`            | metadata + variable list         | List what's in the file          |
| `extract`         | structured object                | Pull values for a variable       |
| `extractOutput`   | `string` (JSON or CSV)           | Same, ready to write to disk     |

Supported formats: **GRIB2** (grid templates 0, 30, 40, 101), **NetCDF3 Classic**, **NetCDF4 / HDF5**.

---

## Install

```bash
npm install webparsers
```

## Import

```js
import {
  detectFormat,
  scan,
  extract,
  extractOutput,
} from 'webparsers/api';
```

TypeScript types ship with the package — no `@types/*` needed.

---

## Source types accepted

Every function takes a `source` as its first argument. It can be:

- `Uint8Array`
- `ArrayBuffer`
- `Blob` / `File` *(browser)*
- `URL` or string URL — **fully downloaded**, then parsed (no range requests)

---

## `detectFormat(source)`

Magic-byte sniff. Returns `null` for anything unrecognised. Does **not** load WASM.

```js
await detectFormat(file);                       // 'grib2'
await detectFormat('https://…/file.nc');        // 'netcdf4'
await detectFormat(new Uint8Array([0,1,2,3]));  // null
```

---

## `scan(source, opts?)`

Returns metadata + the variable list.

```js
const meta = await scan(file);
console.log(meta.format);              // 'grib2'
console.log(meta.total_variables);     // 12
console.log(meta.variables[0]);
// {
//   index: 0, name: '2t', supported: true,
//   grid_template: 101, data_template: 0,
//   nx: 2949120, ny: 1, messages: 1, ...
// }
```

GRIB2 results also include `grid_templates` and `data_templates` arrays.
NetCDF results include `shapes` and `units`.

---

## `extract(source, options)`

Decode one or more variables. Common options:

| Option       | Type                  | Notes                                              |
| ------------ | --------------------- | -------------------------------------------------- |
| `variable`   | `string \| string[]`  | Required-ish. Omit → all `supported` variables.    |
| `lat`, `lon` | `number`              | Pick the nearest grid point. Omit for whole grid.  |
| `t1`, `t2`   | `number`              | Time-index range (inclusive).                      |

```js
// Single variable, single point
const t2m = await extract(file, {
  variable: '2t',
  lat: 52.52, lon: 13.40,        // Berlin
});
// { variable: '2t', location: { lat, lon }, value: 271.4, time: 1734566400 }

// Multiple variables + a time range → returns { variables: [...] }
const both = await extract(file, {
  variable: ['TMP', 'UGRD'],
  lat: 40.7, lon: -74.0,
  t1: 0, t2: 5,
});
```

---

## `extractOutput(source, options, format)`

Same inputs as `extract`, but returns a serialised **string** ready to drop on disk.
`format` is `'json'` (default) or `'csv'`.

```js
import { writeFileSync } from 'node:fs';

const csv = await extractOutput(file, { variable: '2t', lat: 52.52, lon: 13.40 }, 'csv');
writeFileSync('berlin.csv', csv);

const json = await extractOutput(file, { variable: '2t' });   // pretty-printed JSON
```

CSV columns: `variable,time,value,lat,lon`.

---

## Errors

All errors thrown by the API extend `WebparsersError` so you can `instanceof`-check:

```js
import {
  WebparsersError,
  UnsupportedFormatError,
  VariableNotFoundError,
  SourceError,
  ExtractError,
} from 'webparsers/api';

try {
  await scan(somethingWeird);
} catch (e) {
  if (e instanceof UnsupportedFormatError) { /* not a recognised format */ }
  else if (e instanceof SourceError)       { /* fetch / blob read failed */ }
  else throw e;
}
```

| Error                       | When                                                |
| --------------------------- | --------------------------------------------------- |
| `UnsupportedFormatError`    | Magic bytes don't match any known format            |
| `VariableNotFoundError`     | Named variable absent or not `supported: true`      |
| `SourceError`               | URL fetch failed, unsupported source type           |
| `ExtractError`              | Decoder failed for a known variable                 |
| `WebparsersError`           | Base class — catch this for "anything from us"      |

---

## Browser usage

Add the WASM loader once before importing the API. The library auto-discovers the global.

```html
<script src="/path/to/webparsers.js"></script>
<script type="module">
  import { scan } from '/path/to/webparsers-api.js';
  document.querySelector('#file').onchange = async (e) => {
    const meta = await scan(e.target.files[0]);
    console.log(meta);
  };
</script>
```

## Node usage

In Node, `webparsers.js` is a UMD bundle that has to be loaded into a CJS context.
The simplest pattern is to read it as text and evaluate:

```js
import { readFileSync } from 'node:fs';
import { scan } from 'webparsers/api';

function loadWasmFactory() {
  const code = readFileSync(new URL('webparsers/wasm', import.meta.url) + '/webparsers.js', 'utf8');
  const m = { exports: {} };
  new Function('module', 'exports', code)(m, m.exports);
  return m.exports.default ?? m.exports;
}

const rawFactory = loadWasmFactory();
const wasmBinary = readFileSync(new URL('webparsers/wasm', import.meta.url) + '/webparsers.wasm');
const wasmFactory = () => rawFactory({ wasmBinary });

const meta = await scan('https://opendata.dwd.de/.../file.grib2', { wasmFactory });
console.log(meta);
```

See `scripts/test-api.js` in the repo for a working end-to-end example.

---

## Quick demos

```bash
# Run the smoke test against the GRIB2 fixtures in examples/
npm run test:api
```

Want a longer recipe (full Berlin temperature lookup from a DWD ICON file)?
See `scripts/test-api.js`.
