/*
 * zarr-helper.js  --  Browser-side Zarr v2 reader for webparsers
 *
 * Pipeline mirrors GRIB2 / NetCDF3 / NetCDF4:
 *
 *   scan(uint8array)
 *     → list every Zarr array in a ZIP-of-zarr, with shape/dtype/chunks
 *
 *   scanGetVarsJson(scanResult)
 *     → JSON string in the same shape wp_scan_get_vars_json emits
 *
 *   normalize(scanResult, varIndex, wasm)
 *     → refs_dataset_t* pointer (use with wp_query, wp_nt, wp_close, …)
 *
 *   scanFree(scanResult)
 *
 * Why pure JS?
 *   Zarr is multi-file by design and almost always uses third-party
 *   compressors (zstd, blosc, gzip). Browsers ship DecompressionStream
 *   for gzip / deflate-raw, and we lazy-load `numcodecs` from jsdelivr
 *   for blosc / zstd / lz4 — no WASM bundling required here. The C
 *   engine receives a flat Float32 array via wp_open_from_float_arrays
 *   once everything's decoded.
 *
 * Supported v2 features
 *   - dtypes: <f4 <f8 <i1 <i2 <i4 <u1 <u2 <u4 |i1 |u1
 *   - compressors: null, gzip, zlib (built-in via DecompressionStream);
 *                  blosc, zstd, lz4 (lazy via numcodecs)
 *   - byte order: little-endian only (real-world default)
 *   - dimension_separator: '.' and '/'
 *   - fill_value: number, "NaN", "Infinity", "-Infinity"
 *
 * Not yet:
 *   - filters (fixedscaleoffset, delta, …) — throws a clear error
 *   - big-endian dtypes
 */

/* ES module — import { scan, scanGetVarsJson, normalize, scanFree, detectFormat }
 *             from './zarr-helper.js';
 */

  /* ====================================================================== */
  /* Tiny ZIP reader — central-directory walker, stored + deflate entries.   */
  /* No external deps; ~100 lines.                                           */
  /* ====================================================================== */

  const ZIP_EOCD_SIG = 0x06054b50;
  const ZIP_CD_SIG   = 0x02014b50;

  /** Locate the End-of-Central-Directory record (last 22..65557 bytes). */
  function findEOCD(buf) {
    const dv  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const min = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === ZIP_EOCD_SIG) return i;
    }
    throw new Error('Not a ZIP file (EOCD signature not found)');
  }

  /**
   * Parse a ZIP-of-zarr buffer into a flat map { entryName: Uint8Array }.
   * Supports stored (method 0) and deflate (method 8).
   */
  async function readZip(buf) {
    if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const eocd      = findEOCD(buf);
    const cdEntries = dv.getUint16(eocd + 10, true);
    const cdSize    = dv.getUint32(eocd + 12, true);
    const cdOffset  = dv.getUint32(eocd + 16, true);

    const out = {};
    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    for (let i = 0; i < cdEntries && p < cdEnd; i++) {
      if (dv.getUint32(p, true) !== ZIP_CD_SIG)
        throw new Error('ZIP central directory corrupt at ' + p);

      const method     = dv.getUint16(p + 10, true);
      const compSize   = dv.getUint32(p + 20, true);
      const uncompSize = dv.getUint32(p + 24, true);
      const nameLen    = dv.getUint16(p + 28, true);
      const extraLen   = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lhOffset   = dv.getUint32(p + 42, true);

      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

      /* Skip directory entries (trailing slash) */
      if (!name.endsWith('/')) {
        /* Local-file-header: 30 bytes + name + extra → then data */
        const lhNameLen  = dv.getUint16(lhOffset + 26, true);
        const lhExtraLen = dv.getUint16(lhOffset + 28, true);
        const dataStart  = lhOffset + 30 + lhNameLen + lhExtraLen;
        const compBytes  = buf.subarray(dataStart, dataStart + compSize);

        let bytes;
        if (method === 0) {
          bytes = compBytes;
        } else if (method === 8) {
          bytes = await inflateRaw(compBytes, uncompSize);
        } else {
          throw new Error('Unsupported ZIP method ' + method + ' for ' + name);
        }
        out[name] = bytes;
      }

      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** Raw deflate via the browser's built-in DecompressionStream. */
  async function inflateRaw(compBytes, expectedSize) {
    const stream = new Response(compBytes).body
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  /* ====================================================================== */
  /* Chunk-level decompression for Zarr `.zarray` compressors.               */
  /* ====================================================================== */

  /* numcodecs resolution:
   *   Browser  → jsdelivr ESM bundle (no `npm install` needed by end users).
   *   Node     → bare specifier from node_modules (we ship numcodecs in
   *              optionalDependencies for our own tests and Node consumers).
   * numcodecs base64-inlines its WASM into the JS bundle, so there is no
   * companion .wasm fetch — one HTTPS round trip covers everything.
   *
   * The whole module is fetched once and cached; per-codec classes are
   * resolved by name (`Blosc` / `Zstd` / `LZ4`) and re-cached so we only
   * pay the WASM init cost once per codec per process. */
  const NUMCODECS_CDN = 'https://cdn.jsdelivr.net/npm/numcodecs@0.3.2/+esm';
  const NUMCODECS_NAMES = { blosc: 'Blosc', zstd: 'Zstd', lz4: 'LZ4' };

  let _numcodecsModule = null;
  const _codecCache = new Map();

  async function _loadNumcodecsModule() {
    if (_numcodecsModule) return _numcodecsModule;
    const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    const spec   = isNode ? 'numcodecs' : NUMCODECS_CDN;
    try {
      const mod = await import(/* @vite-ignore */ spec);
      _numcodecsModule = mod.default ?? mod;
      return _numcodecsModule;
    } catch (e) {
      throw new Error(
        'Failed to load numcodecs from ' + spec + '. ' +
        (isNode
          ? 'In Node, install with: npm i numcodecs'
          : 'In the browser, check that ' + NUMCODECS_CDN + ' is reachable.') +
        ' Underlying error: ' + (e?.message || e)
      );
    }
  }

  async function _loadNumcodec(id) {
    if (_codecCache.has(id)) return _codecCache.get(id);
    const name = NUMCODECS_NAMES[id];
    if (!name) throw new Error('No numcodecs binding for compressor id: ' + id);
    const numcodecs = await _loadNumcodecsModule();
    const Codec = numcodecs[name];
    if (!Codec) throw new Error('numcodecs has no export named "' + name + '" (id=' + id + ')');
    _codecCache.set(id, Codec);
    return Codec;
  }

  async function decompressChunk(bytes, compressor) {
    if (!compressor || compressor.id == null) return bytes;
    const id = String(compressor.id).toLowerCase();

    /* Built-in fast paths via the browser's DecompressionStream — no JS dep. */
    if (id === 'gzip') {
      const s = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    }
    if (id === 'zlib') {
      const s = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    }

    /* numcodecs-backed codecs (blosc, zstd, lz4). Loaded on demand. */
    if (id === 'blosc' || id === 'zstd' || id === 'lz4') {
      const Codec = await _loadNumcodec(id);
      const codec = Codec.fromConfig(compressor);
      const out   = await codec.decode(bytes);
      /* numcodecs may return a Uint8Array view over a larger buffer; normalize. */
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    }

    throw new Error('Unsupported Zarr compressor: ' + id +
      '  (built-in: null / gzip / zlib; via numcodecs: blosc / zstd / lz4)');
  }

  /* ====================================================================== */
  /* dtype parsing — Zarr v2 uses NumPy typestrings, e.g. "<f4", "|u1"       */
  /* ====================================================================== */

  /**
   * Returns { byteOrder, kind, bytes, view(buf, off, n) → typed array }.
   * Throws on unsupported dtypes.
   */
  function parseDtype(dtype) {
    const m = /^([<>|])([fiu])(\d+)$/.exec(String(dtype));
    if (!m) throw new Error('Unsupported dtype: ' + dtype);
    const [, order, kind, sizeStr] = m;
    const bytes = parseInt(sizeStr, 10);

    if (order === '>') throw new Error('Big-endian dtypes not supported yet (' + dtype + ')');
    /* '<' = little-endian, '|' = byte-order-irrelevant (1-byte types) */

    const map = {
      'f4': Float32Array, 'f8': Float64Array,
      'i1': Int8Array,    'i2': Int16Array,   'i4': Int32Array,
      'u1': Uint8Array,   'u2': Uint16Array,  'u4': Uint32Array,
    };
    const Ctor = map[kind + bytes];
    if (!Ctor) throw new Error('Unsupported dtype: ' + dtype);

    return {
      byteOrder: order === '|' ? 'na' : 'le',
      kind, bytes, Ctor,
      /* view raw bytes as the typed array. Chunk bytes can land at any byte
       * offset in their parent ZIP buffer, so the absolute offset is not
       * guaranteed to be a multiple of `bytes`. When misaligned, copy into
       * a fresh aligned buffer (rare path; only ever costs us once per chunk). */
      view: (buf, byteOff, count) => {
        const abs = buf.byteOffset + byteOff;
        if (abs % bytes === 0) return new Ctor(buf.buffer, abs, count);
        const copy = new Uint8Array(count * bytes);
        copy.set(buf.subarray(byteOff, byteOff + count * bytes));
        return new Ctor(copy.buffer);
      },
    };
  }

  /* ====================================================================== */
  /* fill_value parsing — JSON allows numbers, "NaN", "Infinity", -Infinity */
  /* ====================================================================== */

  function parseFillValue(fv) {
    if (fv === null || fv === undefined) return NaN;
    if (typeof fv === 'number') return fv;
    if (typeof fv === 'string') {
      if (fv === 'NaN')         return NaN;
      if (fv === 'Infinity')    return Infinity;
      if (fv === '-Infinity')   return -Infinity;
      const n = Number(fv);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  /* ====================================================================== */
  /* Zarr v2 store walking                                                   */
  /* ====================================================================== */

  /**
   * Group entries from the flat zip map into per-array bundles.
   * For each path that contains a `.zarray`, collect:
   *   { name, meta (parsed JSON), attrs (parsed .zattrs or null), chunkPaths }
   */
  function indexArrays(entries) {
    const decoder = new TextDecoder();
    const arrays  = [];

    /* Find every .zarray and treat its parent path as the array root */
    for (const path of Object.keys(entries)) {
      if (!path.endsWith('/.zarray') && path !== '.zarray') continue;

      const root = path === '.zarray' ? '' : path.slice(0, -'.zarray'.length);
      const meta = JSON.parse(decoder.decode(entries[path]));

      const attrsPath = root + '.zattrs';
      const attrs = entries[attrsPath]
        ? JSON.parse(decoder.decode(entries[attrsPath]))
        : null;

      /* Display name: trim trailing slash; root array = '/' */
      const name = root.endsWith('/') ? root.slice(0, -1) : (root || '/');

      arrays.push({ name: name || '/', root, meta, attrs });
    }

    return arrays;
  }

  /* ====================================================================== */
  /* Coordinate-axis resolution                                              */
  /*                                                                         */
  /* Real-world zarr stores carry their own 1-D lat/lon/time arrays — either */
  /* linked explicitly via xarray's `_ARRAY_DIMENSIONS` attr, or by          */
  /* convention (sibling arrays named `latitude`/`lat`/`y` etc.).            */
  /* This helper is pure-metadata (cheap) so it can run during scan(),       */
  /* before any chunk bytes are decoded.                                     */
  /* ====================================================================== */

  const LAT_ALIASES  = ['latitude',  'lat', 'y'];
  const LON_ALIASES  = ['longitude', 'lon', 'x'];
  const TIME_ALIASES = ['time',      't',   'valid_time'];

  /** Find a 1-D array in scanResult.arrays by name and required length. */
  function find1DArray(arrays, name, expectedLen) {
    if (!name) return null;
    const got = arrays.find(x => x.name === name);
    if (!got || !got.meta || !Array.isArray(got.meta.shape)) return null;
    if (got.meta.shape.length !== 1) return null;
    if (got.meta.shape[0] !== expectedLen) return null;
    return got;
  }

  /**
   * Resolve coordinate references for a multi-dim data var.
   * Returns { latRef, lonRef, timeRef, nt, ny, nx, source, warnings }.
   *
   *   source: 'explicit' | 'fallback' | 'synthetic'
   *     - explicit:   matched via _ARRAY_DIMENSIONS
   *     - fallback:   matched by alias name + length
   *     - synthetic:  no lat/lon arrays found; caller must use index axes
   *
   * Cheap — only inspects .zarray/.zattrs already parsed by indexArrays().
   * No chunk bytes are read here.
   */
  function resolveCoordRefs(scanResult, arrayInfo) {
    const shape   = (arrayInfo.meta && arrayInfo.meta.shape) || [];
    const ndim    = shape.length;
    const arrays  = scanResult.arrays;
    const warnings = [];

    let nt, ny, nx;
    if (ndim === 1)      { nt = 1;        ny = 1;             nx = shape[0]; }
    else if (ndim === 2) { nt = 1;        ny = shape[0];      nx = shape[1]; }
    else if (ndim === 3) { nt = shape[0]; ny = shape[1];      nx = shape[2]; }
    else                 { nt = shape[0]; ny = shape[ndim-2]; nx = shape[ndim-1]; }

    let latRef = null, lonRef = null, timeRef = null;
    let source = 'synthetic';

    /* 1. Explicit xarray-style _ARRAY_DIMENSIONS linkage. */
    const attrs = arrayInfo.attrs || null;
    const dims  = attrs && Array.isArray(attrs._ARRAY_DIMENSIONS)
      ? attrs._ARRAY_DIMENSIONS : null;

    if (dims && dims.length === ndim) {
      const latDim  = dims[ndim - 2];
      const lonDim  = dims[ndim - 1];
      const timeDim = ndim >= 3 ? dims[0] : null;
      latRef  = find1DArray(arrays, latDim, ny);
      lonRef  = find1DArray(arrays, lonDim, nx);
      timeRef = timeDim ? find1DArray(arrays, timeDim, nt) : null;
      if (latRef && lonRef) source = 'explicit';
    }

    /* 2. Name-alias fallback. */
    if (source !== 'explicit') {
      if (!latRef)  for (const a of LAT_ALIASES)  { const g = find1DArray(arrays, a, ny); if (g) { latRef  = g; break; } }
      if (!lonRef)  for (const a of LON_ALIASES)  { const g = find1DArray(arrays, a, nx); if (g) { lonRef  = g; break; } }
      if (!timeRef && ndim >= 3)
        for (const a of TIME_ALIASES) { const g = find1DArray(arrays, a, nt); if (g) { timeRef = g; break; } }
      if (latRef && lonRef) source = 'fallback';
    }

    if (!latRef || !lonRef) {
      warnings.push(
        'No coordinate arrays found for variable "' + arrayInfo.name +
        '" — using synthetic axes (lats[j]=j, lons[i]=i). ' +
        'extractGrid bbox is in index space, not degrees.'
      );
    }

    return { latRef, lonRef, timeRef, nt, ny, nx, source, warnings };
  }

  /* ====================================================================== */
  /* Scan / metadata API — same shape as wp_scan_get_vars_json output        */
  /* ====================================================================== */

  /**
   * Quick magic check (best-effort): a Zarr ZIP must contain at least one
   * `.zarray` or `.zgroup` entry.  This is heuristic — we only confirm by
   * actually parsing.
   */
  function detectFormat(buf) {
    try {
      findEOCD(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      return 'zarr-zip';   /* could be zarr; scan() will confirm */
    } catch (_) {
      return null;
    }
  }

  /**
   * scan(uint8array) — unzip + index every Zarr v2 array inside.
   * Returns an opaque scanResult object you pass to scanGetVarsJson /
   * normalize / scanFree.
   */
  async function scan(buf) {
    const entries = await readZip(buf);
    const arrays  = indexArrays(entries);
    if (arrays.length === 0)
      throw new Error('No Zarr v2 arrays found (no .zarray entries in archive)');

    /* Sanity check zarr_format on each */
    for (const a of arrays) {
      if (a.meta.zarr_format !== 2)
        throw new Error('Array "' + a.name + '" is zarr_format ' +
          a.meta.zarr_format + ' (only v2 supported here)');
    }

    return { entries, arrays };
  }

  /**
   * Emit the same JSON shape as wp_scan_get_vars_json so callers can render
   * the variables table without special-casing zarr.
   */
  function scanGetVarsJson(scanResult) {
    const out = scanResult.arrays.map((a, i) => {
      const shape  = a.meta.shape  || [];
      const chunks = a.meta.chunks || [];
      /* Pretend the last two dims are (ny, nx) to match the existing UI; if
       * the array has fewer dims, fall back to (length, 1). */
      const ny = shape.length >= 2 ? shape[shape.length - 2] : (shape[0] ?? 0);
      const nx = shape.length >= 1 ? shape[shape.length - 1] : 1;
      const messages = shape.length >= 3 ? shape[0] : 1;  /* outermost dim */

      /* Coord resolution only makes sense for multi-dim data vars; 1-D coord
       * arrays themselves get coord_source='n/a'. */
      let coord_source = 'n/a';
      let warnings = [];
      if (shape.length >= 2) {
        const refs = resolveCoordRefs(scanResult, a);
        coord_source = refs.source;
        warnings = refs.warnings;
      }

      return {
        index:    i,
        name:     a.name,
        cat:      0,
        num:      0,
        grid_template: 0,
        data_template: 0,
        nx, ny,
        messages,
        shape,
        chunks,
        dtype:        a.meta.dtype,
        compressor:   a.meta.compressor ? a.meta.compressor.id : null,
        attrs:        a.attrs,
        supported:    true,
        coord_source,
        warnings,
      };
    });
    return JSON.stringify(out);
  }

  /* ====================================================================== */
  /* Chunk → flat-array assembly                                             */
  /* ====================================================================== */

  /** Compute number of chunks along each axis, ceil(shape[i] / chunks[i]). */
  function chunkGridDims(shape, chunks) {
    return shape.map((s, i) => Math.ceil(s / chunks[i]));
  }

  /** Iterate every chunk index in row-major (C) order. */
  function* chunkIndices(grid) {
    const n = grid.length;
    const idx = new Array(n).fill(0);
    while (true) {
      yield idx.slice();
      let d = n - 1;
      while (d >= 0 && ++idx[d] === grid[d]) { idx[d] = 0; d--; }
      if (d < 0) return;
    }
  }

  /**
   * Copy one decoded chunk (typed array, length = product(chunks)) into the
   * destination flat float array at the right strided offsets.  Handles edge
   * chunks where shape[i] % chunks[i] !== 0 (the last chunk along each axis
   * is padded with fill_value in the file but the in-memory array uses
   * actual shape).
   */
  function placeChunk(dst, dstShape, chunkVals, chunks, chunkIdx, fill) {
    const ndim = dstShape.length;
    /* Strides for dst (C order) */
    const dstStrides = new Array(ndim);
    dstStrides[ndim - 1] = 1;
    for (let i = ndim - 2; i >= 0; i--) dstStrides[i] = dstStrides[i + 1] * dstShape[i + 1];

    /* Strides for the chunk (also C order, shape = chunks) */
    const chStrides = new Array(ndim);
    chStrides[ndim - 1] = 1;
    for (let i = ndim - 2; i >= 0; i--) chStrides[i] = chStrides[i + 1] * chunks[i + 1];

    /* Origin of this chunk in dst-coordinates, and per-axis effective length
     * (clipped to dstShape — handles partially-filled trailing chunks) */
    const origin = chunkIdx.map((c, i) => c * chunks[i]);
    const effLen = chunkIdx.map((c, i) =>
      Math.min(chunks[i], dstShape[i] - origin[i]));

    /* Recurse over axes; collapse the innermost run into a single copy. */
    function recurse(axis, dstOff, chOff) {
      if (axis === ndim - 1) {
        const n = effLen[axis];
        for (let k = 0; k < n; k++) {
          let v = chunkVals[chOff + k];
          /* Convert fill markers to NaN so query layer treats them as missing */
          if (Number.isFinite(fill) && v === fill) v = NaN;
          dst[dstOff + k] = v;
        }
        return;
      }
      for (let k = 0; k < effLen[axis]; k++) {
        recurse(axis + 1, dstOff + k * dstStrides[axis], chOff + k * chStrides[axis]);
      }
    }
    recurse(0, origin.reduce((s, o, i) => s + o * dstStrides[i], 0), 0);
  }

  /**
   * Read all chunks for an array, decompress, and reduce to a Float32Array
   * of total length = product(shape).  Order is row-major.
   */
  async function readArrayAsFloat32(scanResult, arrayInfo) {
    const meta   = arrayInfo.meta;
    const shape  = meta.shape;
    const chunks = meta.chunks;
    const sep    = meta.dimension_separator || '.';
    const root   = arrayInfo.root;

    if (meta.order && meta.order !== 'C')
      throw new Error('Only C-order arrays supported (got "' + meta.order + '")');
    if (meta.filters && meta.filters.length) {
      const ids = meta.filters.map(f => (f && f.id) || '<unknown>').join(', ');
      throw new Error(
        'Zarr filters not supported yet (got: ' + ids + '). ' +
        'Compressors (blosc / zstd / lz4 / gzip / zlib) are supported; ' +
        'filter codecs (fixedscaleoffset, delta, …) are tracked as a follow-up.'
      );
    }

    const dt   = parseDtype(meta.dtype);
    const fill = parseFillValue(meta.fill_value);

    const totalLen = shape.reduce((a, b) => a * b, 1);
    const dst = new Float32Array(totalLen);
    if (Number.isFinite(fill)) dst.fill(fill);

    const grid = chunkGridDims(shape, chunks);

    for (const idx of chunkIndices(grid)) {
      const key       = idx.join(sep);
      const chunkPath = root + key;
      const raw       = scanResult.entries[chunkPath];

      /* Missing chunk → fill region with fill_value (already done above) */
      if (!raw) continue;

      const dec    = await decompressChunk(raw, meta.compressor);
      const expect = chunks.reduce((a, b) => a * b, 1) * dt.bytes;
      if (dec.length < expect)
        throw new Error('Chunk ' + chunkPath + ' decoded to ' + dec.length +
                        ' bytes, expected ' + expect);

      const typed = dt.view(dec, 0, chunks.reduce((a, b) => a * b, 1));
      placeChunk(dst, shape, typed, chunks, idx, fill);
    }

    return dst;
  }

  /* ====================================================================== */
  /* normalize — hand a refs_dataset_t back to the C query engine.           */
  /* Mirrors how _normalizeNetCDF4 in webparsers-lib.js works.               */
  /* ====================================================================== */

  /**
   * Build a refs_dataset_t* from a Zarr array, ready for wp_query / wp_nt /
   * wp_find_nearest_lat / wp_close.
   *
   *   scanResult: result of scan()
   *   varIndex:   index into scanResult.arrays
   *   wasm:       the loaded WebParsers WASM module
   *
   * Coord strategy: try real lat/lon/time arrays from the store first
   * (xarray's `_ARRAY_DIMENSIONS` or name aliases like 'latitude'/'lat').
   * Fall back to synthetic indices when the store has no coordinate arrays.
   * See resolveCoordRefs() for the full resolution order.
   */
  async function normalize(scanResult, varIndex, wasm) {
    const a = scanResult.arrays[varIndex];
    if (!a) throw new Error('varIndex out of range');

    const data = await readArrayAsFloat32(scanResult, a);

    const shape = a.meta.shape;
    const ndim  = shape.length;

    let nt, ny, nx;
    if (ndim === 1)      { nt = 1;          ny = 1;          nx = shape[0]; }
    else if (ndim === 2) { nt = 1;          ny = shape[0];   nx = shape[1]; }
    else if (ndim === 3) { nt = shape[0];   ny = shape[1];   nx = shape[2]; }
    else                 { nt = shape[0];   ny = shape[ndim-2]; nx = shape[ndim-1]; }

    const refs = ndim >= 2 ? resolveCoordRefs(scanResult, a) : null;

    let lats, lons, times_s;

    if (refs && refs.latRef) {
      lats = await readArrayAsFloat32(scanResult, refs.latRef);
    } else {
      lats = new Float32Array(ny);
      for (let j = 0; j < ny; j++) lats[j] = j;
    }

    if (refs && refs.lonRef) {
      lons = await readArrayAsFloat32(scanResult, refs.lonRef);
    } else {
      lons = new Float32Array(nx);
      for (let i = 0; i < nx; i++) lons[i] = i;
    }

    /* readArrayAsFloat32 widens to Float32; widen again to Float64 for the
     * times buffer the C engine expects. Precision loss matters for real
     * unix-epoch seconds (>2^24); the C path treats values as raw seconds.
     * For now we accept this; a Float64-preserving reader is a follow-up. */
    times_s = new Float64Array(nt);
    if (refs && refs.timeRef) {
      const raw = await readArrayAsFloat32(scanResult, refs.timeRef);
      for (let t = 0; t < nt; t++) times_s[t] = raw[t];
    } else {
      for (let t = 0; t < nt; t++) times_s[t] = t * 86400;
    }

    /* Hand all four buffers + the float data to wp_open_from_float_arrays.
     * That C function copies them, so we can let GC reclaim the JS originals. */
    const nameLenU8 = wasm.lengthBytesUTF8(a.name) + 1;
    const namePtr   = wasm.ccall('wp_malloc', 'number', ['number'], [nameLenU8]);
    wasm.stringToUTF8(a.name, namePtr, nameLenU8);

    const latsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [ny * 4]);
    const lonsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [nx * 4]);
    const tsPtr   = wasm.ccall('wp_malloc', 'number', ['number'], [nt * 8]);
    const dataPtr = wasm.ccall('wp_malloc', 'number', ['number'], [data.byteLength]);

    wasm.HEAPF32.set(lats, latsPtr / 4);
    wasm.HEAPF32.set(lons, lonsPtr / 4);
    wasm.HEAPF64.set(times_s, tsPtr / 8);
    wasm.HEAPF32.set(data, dataPtr / 4);

    const ds = wasm.ccall('wp_open_from_float_arrays', 'number',
      ['number','number','number','number','number','number','number','number'],
      [namePtr, nx, ny, nt, latsPtr, lonsPtr, tsPtr, dataPtr]);

    /* wp_open_from_float_arrays copies the buffers internally — free ours. */
    wasm.ccall('wp_free', null, ['number'], [namePtr]);
    wasm.ccall('wp_free', null, ['number'], [latsPtr]);
    wasm.ccall('wp_free', null, ['number'], [lonsPtr]);
    wasm.ccall('wp_free', null, ['number'], [tsPtr]);
    wasm.ccall('wp_free', null, ['number'], [dataPtr]);

    return ds;
  }

  /** Free anything held by scan() — currently just lets GC do its job. */
  function scanFree(scanResult) {
    if (!scanResult) return;
    scanResult.entries = null;
    scanResult.arrays  = null;
  }

  /* ====================================================================== */
  /* Exports                                                                 */
  /* ====================================================================== */

export {
  detectFormat,
  scan,
  scanGetVarsJson,
  normalize,
  scanFree,
  /* Lower-level helpers, exposed for advanced use / tests */
  readZip            as _readZip,
  parseDtype         as _parseDtype,
  readArrayAsFloat32 as _readArrayAsFloat32,
};

export default {
  detectFormat, scan, scanGetVarsJson, normalize, scanFree,
  _readZip: readZip, _parseDtype: parseDtype, _readArrayAsFloat32: readArrayAsFloat32,
};
