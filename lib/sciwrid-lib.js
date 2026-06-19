/**
 * sciwrid-lib.js  --  JavaScript library for meteorological data parsing
 *
 * Supported formats: GRIB2 (grid templates 0, 30, 40, 101), NetCDF3 Classic,
 *                    NetCDF4/HDF5, Zarr v2 (zip), TIFF/GeoTIFF (incl. COG)
 *
 * Usage (browser, ES module):
 *   <script src="sciwrid.js"></script>   <!-- the WASM loader -->
 *   <script type="module">
 *     import { SciWridToolkit } from './sciwrid-lib.js';
 *     const lib = new SciWridToolkit();
 *     await lib.read(file);
 *     const data = await lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0 });
 *   </script>
 *
 * Usage (Node / bundler):
 *   import { SciWridToolkit } from 'sciwrid-toolkit';
 */

import * as Zarr from './zarr-helper.js';
import { decodeTimes } from './time-decoder.js';
import SciWridWasm from '../wasm/sciwrid.js';

/* =========================================================================
 * Internal: monotonicity check for coordinate arrays (used by extractGrid)
 * ======================================================================= */
function isMonotonic(arr) {
  const n = arr.length;
  if (n < 2) return true;
  const asc = arr[0] < arr[n - 1];
  for (let i = 1; i < n; i++) {
    if (asc && !(arr[i] >= arr[i - 1])) return false;
    if (!asc && !(arr[i] <= arr[i - 1])) return false;
  }
  return true;
}

/* =========================================================================
 * Internal: get the WASM factory function, regardless of environment
 * ======================================================================= */
function getWasmFactory(instance) {
  /* Explicitly passed via constructor config overrides the default */
  if (instance && instance._wasmFactory) return instance._wasmFactory;
  return SciWridWasm;
}

/* =========================================================================
 * SciWrid Toolkit — main library class
 * ======================================================================= */
export class SciWridToolkit {
  /**
   * @param {Object} [config]
   * @param {[number,number,number,number]} [config.studyArea] - [minLon, minLat, maxLon, maxLat]
   */
  constructor(config = {}) {
    this.config          = config;
    this._wasmFactory    = config.wasmFactory || null;
    this.wasm            = null;
    this.scanPtr         = 0;
    this.vars            = [];
    this._format         = null;
    this._nc4            = null;   // { f, fname, FS } for open NetCDF4 file
    this._h5wasmModule   = null;   // cached h5wasm module
    this._zarrScan       = null;   // result of Zarr.scan() for open Zarr file
    this._geoBbox        = null;   // [minLon, minLat, maxLon, maxLat] from coord vars, when derivable
  }

  /* -----------------------------------------------------------------------
   * init — load the WASM module (called automatically by read())
   * --------------------------------------------------------------------- */
  async init() {
    if (this.wasm) return;
    const factory = getWasmFactory(this);
    this.wasm = await factory();
  }

  /* -----------------------------------------------------------------------
   * read — load a file from many possible sources
   *
   *   await lib.read(fileObject)          // browser File
   *   await lib.read('https://...grb2')   // URL (auto-fetch)
   *   await lib.read(arrayBuffer)         // raw ArrayBuffer
   *   await lib.read(uint8Array)          // raw bytes
   * --------------------------------------------------------------------- */
  async read(source) {
    await this.init();
    this._freeScan();

    const data   = await this._toUint8Array(source);
    const format = this._detectFormat(source, data);

    if (format === 'grib2') {
      this._format = 'grib2';
      this._scanGrib2(data);
    } else if (format === 'netcdf3') {
      this._format = 'netcdf3';
      this._scanNetCDF3(data);
    } else if (format === 'netcdf4') {
      this._format = 'netcdf4';
      await this._scanNetCDF4(data);
    } else if (format === 'zarr') {
      this._format = 'zarr';
      await this._scanZarr(data);
    } else {
      throw new Error(`Format '${format}' not yet supported. Supported: grib2, netcdf3, netcdf4, zarr`);
    }
  }

  /* -----------------------------------------------------------------------
   * metadata — summary info about the loaded file
   * --------------------------------------------------------------------- */
  metadata() {
    this._requireScan();
    const supported = this.vars.filter(v => v.supported);
    const base = {
      format:              this._format,
      total_variables:     this.vars.length,
      supported_variables: supported.length,
      variable_names:      this.vars.map(v => v.name),
    };

    if (this._format === 'grib2') {
      base.grid_templates = [...new Set(this.vars.map(v => v.grid_template))];
      base.data_templates = [...new Set(this.vars.map(v => v.data_template))];
    }

    if (this._format === 'netcdf3' || this._format === 'netcdf4') {
      /* Collect unique dimension shapes across all variables */
      const shapes = [...new Set(this.vars.map(v => v.shape))];
      base.shapes = shapes;
      /* Collect unique units */
      const units = [...new Set(this.vars.map(v => v.units).filter(Boolean))];
      base.units = units;
      /* Geographic extent derived from the lat/lon coordinate variables, so
       * consumers (e.g. the map demo) can place the grid instead of assuming
       * a global bbox. Absent when no usable lat/lon coords were found. */
      if (this._geoBbox) base.bbox = this._geoBbox;
    }

    if (this._format === 'zarr') {
      base.shapes      = [...new Set(this.vars.map(v => (v.shape || []).join('x')))];
      base.dtypes      = [...new Set(this.vars.map(v => v.dtype).filter(Boolean))];
      base.compressors = [...new Set(this.vars.map(v => v.compressor).filter(Boolean))];
      if (this._geoBbox) base.bbox = this._geoBbox;
    }

    return base;
  }

  /* -----------------------------------------------------------------------
   * getvariables — array of variable descriptors
   * --------------------------------------------------------------------- */
  getvariables() {
    this._requireScan();
    return this.vars;
  }

  /* -----------------------------------------------------------------------
   * variables — same data, packaged as a GeoJSON FeatureCollection
   * --------------------------------------------------------------------- */
  variables() {
    this._requireScan();
    return {
      type: 'FeatureCollection',
      features: this.vars.map(v => {
        let props;
        if (this._format === 'netcdf3' || this._format === 'netcdf4') {
          props = {
            index:     v.index,
            name:      v.name,
            long_name: v.long_name || null,
            units:     v.units     || null,
            shape:     v.shape     || null,
            ndims:     v.ndims,
            supported: v.supported,
          };
        } else if (this._format === 'zarr') {
          props = {
            index:      v.index,
            name:       v.name,
            shape:      v.shape      || null,
            chunks:     v.chunks     || null,
            dtype:      v.dtype      || null,
            compressor: v.compressor || null,
            attrs:      v.attrs      || null,
            supported:  v.supported,
          };
        } else {
          props = {
            index:         v.index,
            name:          v.name,
            category:      v.cat,
            number:        v.num,
            grid_template: v.grid_template,
            data_template: v.data_template,
            grid_size:     `${v.nx}x${v.ny}`,
            messages:      v.messages,
            supported:     v.supported,
          };
        }
        return { type: 'Feature', geometry: null, properties: props };
      }),
    };
  }

  /* -----------------------------------------------------------------------
   * extract — decode and query the loaded file
   *
   *   lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0 })
   *   lib.extract({ variable: ['TMP','UGRD'], lat: 40.7, lon: -74.0, type: 'csv' })
   *   lib.extract({ lat: 40.7, lon: -74.0, t1: 0, t2: 5 })
   * --------------------------------------------------------------------- */
  async extract(options) {
    this._requireScan();
    const wasm = this.wasm;

    const { variable, lat, lon, t1 = 0, t2, type = 'json' } = options || {};

    // Resolve target variables
    let targets;
    if (!variable) {
      targets = this.vars.filter(v => v.supported);
    } else {
      const names = Array.isArray(variable) ? variable : [variable];
      targets = this.vars.filter(v => names.includes(v.name) && v.supported);
      const missing = names.filter(n => !this.vars.find(v => v.name === n));
      if (missing.length > 0)
        throw new Error(`Variable(s) not found: ${missing.join(', ')}`);
      if (targets.length === 0)
        throw new Error('None of the requested variables are supported');
    }

    const results = [];

    for (const v of targets) {
      let ds;
      if (this._format === 'netcdf4') {
        ds = await this._normalizeNetCDF4(v);
      } else if (this._format === 'zarr') {
        ds = await Zarr.normalize(this._zarrScan, v.index, wasm);
      } else {
        const normFn = this._format === 'netcdf3' ? 'wp_nc3_normalize' : 'wp_normalize';
        ds = wasm.ccall(normFn, 'number',
          ['number', 'number'], [this.scanPtr, v.index]);
      }

      if (!ds || ds === 0) {
        console.warn(`[sciwrid] Failed to decode variable: ${v.name}`);
        continue;
      }

      try {
        const nt       = wasm.ccall('wp_nt', 'number', ['number'], [ds]);
        const actualT1 = Math.min(t1, nt - 1);
        const actualT2 = Math.min(t2 ?? nt - 1, nt - 1);

        let latIdx = -1, lonIdx = -1;
        if (lat !== undefined) {
          latIdx = wasm.ccall('wp_find_nearest_lat', 'number',
            ['number', 'number'], [ds, lat]);
        }
        if (lon !== undefined) {
          lonIdx = wasm.ccall('wp_find_nearest_lon', 'number',
            ['number', 'number'], [ds, lon]);
        }

        const resultPtr = wasm.ccall('wp_query', 'number',
          ['number', 'number', 'number', 'number', 'number'],
          [ds, actualT1, actualT2, latIdx, lonIdx]);

        if (resultPtr !== 0) {
          const json = wasm.UTF8ToString(resultPtr);
          wasm.ccall('wp_free', null, ['number'], [resultPtr]);
          try {
            results.push(JSON.parse(json));
          } catch (parseErr) {
            throw new Error(
              `[sciwrid] Failed to parse query result for variable "${v.name}": ${parseErr.message}`
            );
          }
        }
      } finally {
        wasm.ccall('wp_close', null, ['number'], [ds]);
      }
    }

    if (results.length === 0) throw new Error('No data extracted');
    const combined = results.length === 1 ? results[0] : { variables: results };

    if (type === 'csv')     return this._toCSV(combined);
    if (type === 'geojson') return this._toGeoJSON(combined);
    return combined;
  }

  /* -----------------------------------------------------------------------
   * extractGrid — parallel bbox grid export
   *
   *   await lib.extractGrid({
   *     variable: 'TMP',
   *     bbox:    [minLon, minLat, maxLon, maxLat],
   *     width:   256, height: 256,
   *     time:    0,           // optional, default 0
   *     workers: 5,           // optional, default 5; 0 forces inline
   *     signal:  abortCtrl.signal,    // optional
   *     onProgress: ({done,total}) => {},
   *   })
   *
   * Returns { data: Float32Array(W*H), width, height, bbox, variable,
   *           units, time }. Row 0 = maxLat (north-up). Cell (x,y) center:
   *   lon = minLon + (x + 0.5) * (maxLon - minLon) / width
   *   lat = maxLat - (y + 0.5) * (maxLat - minLat) / height
   * --------------------------------------------------------------------- */
  async extractGrid(options) {
    this._requireScan();
    const {
      variable, bbox, width, height,
      time = 0, workers = 5, signal, onProgress,
    } = options || {};

    const checkAbort = () => {
      if (signal && signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason : new Error('AbortError');
        if (!reason.name || reason.name === 'Error') reason.name = 'AbortError';
        throw reason;
      }
    };
    checkAbort();

    /* ---- Validate inputs ---- */
    if (!variable || typeof variable !== 'string')
      throw new Error('extractGrid: `variable` is required and must be a string');
    if (!Array.isArray(bbox) || bbox.length !== 4)
      throw new Error('extractGrid: `bbox` must be [minLon, minLat, maxLon, maxLat]');
    if (!Number.isInteger(width) || width <= 0 ||
        !Number.isInteger(height) || height <= 0)
      throw new Error('extractGrid: `width` and `height` must be positive integers');
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (!(maxLon > minLon) || !(maxLat > minLat))
      throw new Error('extractGrid: bbox max must be greater than min');

    /* ---- Find target variable ---- */
    const v = this.vars.find(x => x.name === variable);
    if (!v) throw new Error(`Variable not found: ${variable}`);
    if (!v.supported) throw new Error(`Variable not supported: ${variable}`);

    /* ---- Extract typed arrays + time slice ---- */
    checkAbort();
    const arrays = await this._extractArrays(v, time);
    checkAbort();
    const { lats, lons, sliceData, ny, nx, units } = arrays;

    /* ---- Detect monotonicity ---- */
    const latsAscending = lats[0] < lats[ny - 1];
    const lonsAscending = lons[0] < lons[nx - 1];
    if (!isMonotonic(lats)) throw new Error('lats array is not monotonic; extractGrid v1 requires sorted coordinates');
    if (!isMonotonic(lons)) throw new Error('lons array is not monotonic; extractGrid v1 requires sorted coordinates');

    const lonRange = lonsAscending ? [lons[0], lons[nx - 1]] : [lons[nx - 1], lons[0]];

    /* ---- Decide inline vs pool ---- */
    const total = width * height;
    const useWorkers = workers > 0 && (typeof Worker !== 'undefined' || typeof process !== 'undefined');

    if (!useWorkers) {
      /* Inline path */
      const { inlineExtract } = await import('../worker/loader.js');
      const data = inlineExtract(
        { lats, lons, data: sliceData, nx, latsAscending, lonsAscending,
          lonRange, bbox, width, height },
        onProgress);
      return { data, width, height, bbox, variable, units, time };
    }

    /* ---- Worker pool path ---- */
    checkAbort();
    const { WorkerPool, createWorker } = await import('../worker/loader.js');
    const pool = new WorkerPool({ size: workers, factory: createWorker, signal });

    try {
      checkAbort();
      /* Build per-worker init message. Transferable buffers detach the source,
       * so we slice() before each transfer to keep the originals in this scope. */
      await pool.initAll((i) => {
        const latsCopy = lats.slice();
        const lonsCopy = lons.slice();
        const dataCopy = sliceData.slice();
        return {
          msg: {
            type: 'init',
            lats: latsCopy.buffer,
            lons: lonsCopy.buffer,
            data: dataCopy.buffer,
            ny, nx, latsAscending, lonsAscending, lonRange,
            bbox, width, height,
          },
          transfer: [latsCopy.buffer, lonsCopy.buffer, dataCopy.buffer],
        };
      });

      /* Build chunk queue. Row-band chunks for load balancing. */
      const rowsPerChunk = Math.max(1, Math.ceil(height / (workers * 4)));
      const chunks = [];
      for (let y0 = 0, id = 0; y0 < height; y0 += rowsPerChunk, id++) {
        chunks.push({ type: 'chunk', id, y0, y1: Math.min(y0 + rowsPerChunk, height) });
      }

      const output = new Float32Array(width * height);
      let done = 0;
      const totalChunks = chunks.length;

      /* Enqueue all; pool dispatches as workers become available. */
      const promises = chunks.map((chunkMsg) =>
        pool.enqueue(chunkMsg).then((res) => {
          const values = new Float32Array(res.values);
          output.set(values, res.y0 * width);
          done += values.length;
          if (onProgress) onProgress({ done, total, chunk: res.id, totalChunks });
        }),
      );

      await Promise.all(promises);
      return { data: output, width, height, bbox, variable, units, time };
    } finally {
      pool.dispose();
    }
  }

  /* -----------------------------------------------------------------------
   * _extractArrays — get typed arrays for a variable + time slice
   *
   * Returns { lats: Float32Array(ny), lons: Float32Array(nx),
   *           sliceData: Float32Array(ny*nx),    // the single time slice
   *           ny, nx, nt, units, timeValue? }
   *
   * Uses the new wp_ds_*_ptr WASM exports for GRIB2/NetCDF3, the locally-
   * built typed arrays for NetCDF4 (h5wasm path), or throws for Zarr (TODO).
   * --------------------------------------------------------------------- */
  async _extractArrays(v, t = 0) {
    if (this._format === 'netcdf4') {
      const a = await this._normalizeNetCDF4ToArrays(v);
      const tt = Math.min(t, a.nt - 1);
      const sliceData = a.dataF32.slice(tt * a.ny * a.nx, (tt + 1) * a.ny * a.nx);
      return {
        lats: a.latsF32,
        lons: a.lonsF32,
        sliceData,
        ny: a.ny, nx: a.nx, nt: a.nt,
        units: v.units || '',
        timeValue: a.timesF64[tt],
      };
    }

    /* GRIB2 / NetCDF3 / Zarr: go through WASM, extract via wp_ds_*_ptr.
     * For zarr we delegate to Zarr.normalize (which decodes chunks + calls
     * wp_open_from_float_arrays) instead of wp_normalize; the resulting
     * refs_dataset_t* responds to the same wp_ds_*_ptr exports. */
    const wasm = this.wasm;
    if (typeof wasm._wp_ds_lats_ptr !== 'function')
      throw new Error('extractGrid requires the wp_ds_*_ptr WASM exports. Rebuild: python wasm/build.py');

    let ds;
    if (this._format === 'zarr') {
      ds = await Zarr.normalize(this._zarrScan, v.index, wasm);
    } else {
      const normFn = this._format === 'netcdf3' ? 'wp_nc3_normalize' : 'wp_normalize';
      ds = wasm.ccall(normFn, 'number', ['number', 'number'], [this.scanPtr, v.index]);
    }
    if (!ds || ds === 0) throw new Error(`Failed to decode variable: ${v.name}`);

    try {
      const ny = wasm.ccall('wp_ny', 'number', ['number'], [ds]);
      const nx = wasm.ccall('wp_nx', 'number', ['number'], [ds]);
      const nt = wasm.ccall('wp_nt', 'number', ['number'], [ds]);
      const tt = Math.min(t, nt - 1);

      const latsPtr = wasm.ccall('wp_ds_lats_ptr', 'number', ['number'], [ds]);
      const lonsPtr = wasm.ccall('wp_ds_lons_ptr', 'number', ['number'], [ds]);
      const dataPtr = wasm.ccall('wp_ds_data_ptr', 'number', ['number'], [ds]);

      if (!latsPtr || !lonsPtr || !dataPtr)
        throw new Error('wp_ds_*_ptr exports missing — rebuild WASM (python wasm/build.py)');

      /* .slice() copies out of WASM heap to a JS-owned ArrayBuffer that survives wp_close. */
      const lats = new Float32Array(wasm.HEAPF32.buffer, latsPtr, ny).slice();
      const lons = new Float32Array(wasm.HEAPF32.buffer, lonsPtr, nx).slice();
      const sliceOffset = dataPtr + tt * ny * nx * 4;
      const sliceData   = new Float32Array(wasm.HEAPF32.buffer, sliceOffset, ny * nx).slice();

      return { lats, lons, sliceData, ny, nx, nt, units: '' };
    } finally {
      wasm.ccall('wp_close', null, ['number'], [ds]);
    }
  }

  /* Helper that returns the same typed arrays _normalizeNetCDF4 builds, but
   * WITHOUT copying them into WASM. extractGrid uses this for the JS-only
   * pure-JS worker path. */
  async _normalizeNetCDF4ToArrays(varInfo) {
    const f = this._nc4.f;
    const item = f.get(varInfo.name);
    const a    = item.attrs;

    const scale   = Number(this._nc4Attr(a, 'scale_factor')  ?? 1);
    const offset  = Number(this._nc4Attr(a, 'add_offset')    ?? 0);
    const fillRaw = this._nc4Attr(a, '_FillValue');
    const missRaw = this._nc4Attr(a, 'missing_value');
    const fill    = fillRaw != null ? Number(fillRaw) : 9.969209968386869e36;
    const miss    = missRaw != null ? Number(missRaw) : fill;

    const shape = varInfo._shape;
    const latC  = varInfo._latCoord;
    const lonC  = varInfo._lonCoord;
    const timC  = varInfo._timCoord;
    const ny = latC.length;
    const nx = lonC.length;
    const nt = timC ? timC.length : 1;

    const latRaw  = f.get(latC.name).value;
    const lonRaw  = f.get(lonC.name).value;
    const latsF32 = new Float32Array(ny);
    const lonsF32 = new Float32Array(nx);
    for (let i = 0; i < ny; i++) latsF32[i] = Number(latRaw[i]);
    for (let i = 0; i < nx; i++) lonsF32[i] = Number(lonRaw[i]);

    const timesF64 = new Float64Array(nt);
    if (timC) {
      const timDS    = f.get(timC.name);
      const timUnits = String(this._nc4Attr(timDS.attrs, 'units') ?? 'days since 1970-01-01');
      const timRaw   = timDS.value;
      for (let i = 0; i < nt; i++)
        timesF64[i] = this._nc4TimeToS(Number(timRaw[i]), timUnits);
    } else {
      for (let i = 0; i < nt; i++) timesF64[i] = i * 86400;
    }

    const rawData = item.value;
    const dataF32 = new Float32Array(nt * ny * nx);
    const strides = new Array(shape.length);
    strides[shape.length - 1] = 1;
    for (let d = shape.length - 2; d >= 0; d--)
      strides[d] = strides[d + 1] * shape[d + 1];

    const timDim = timC ? timC.dim : -1;
    const latDim = latC.dim;
    const lonDim = lonC.dim;

    for (let tt = 0; tt < nt; tt++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let src = 0;
          if (timDim >= 0) src += tt * strides[timDim];
          src += y * strides[latDim];
          src += x * strides[lonDim];
          const dst = tt * ny * nx + y * nx + x;
          const val = Number(rawData[src]);
          dataF32[dst] = (val === fill || val === miss || !isFinite(val))
                          ? NaN : val * scale + offset;
        }
      }
    }
    return { latsF32, lonsF32, timesF64, dataF32, ny, nx, nt };
  }

  /* -----------------------------------------------------------------------
   * download — save data to a file
   *
   *   lib.download(data)
   *   lib.download(data, { filename: 'result.csv' })
   *   lib.download(data, { type: 'csv', filename: 'result.csv' })
   *
   * In the browser: triggers a file download via a hidden anchor.
   * In Node.js:     writes to disk using fs.writeFileSync.
   *
   * If data is a string (e.g. CSV), it is saved as-is.
   * If data is an object/array, it is serialized to JSON.
   * --------------------------------------------------------------------- */
  download(data, options = {}) {
    if (data === undefined || data === null)
      throw new Error('No data to download. Pass the result of extract() or a serialised string/Uint8Array.');

    /* Detect shape: binary buffer, string, or plain object (JSON.stringify). */
    const isBinary = data instanceof Uint8Array;
    const isString = typeof data === 'string';

    const inferType = isBinary
      ? 'bin'
      : (isString
          ? ((data.startsWith('{') || data.startsWith('[')) ? 'json' : 'csv')
          : 'json');
    const type     = (options.type ?? inferType).toLowerCase();

    const EXT  = { csv: 'csv', json: 'json', geojson: 'geojson',
                   geotiff: 'tif', tif: 'tif', tiff: 'tif', bin: 'bin' };
    const MIME = { csv: 'text/csv', json: 'application/json',
                   geojson: 'application/geo+json',
                   geotiff: 'image/tiff', tif: 'image/tiff', tiff: 'image/tiff',
                   bin: 'application/octet-stream' };
    const ext      = EXT[type]  ?? 'bin';
    const mime     = MIME[type] ?? 'application/octet-stream';
    const filename = options.filename ?? `sciwrid_extract.${ext}`;

    const content  = isBinary ? data
                   : isString ? data
                   : JSON.stringify(data, null, 2);

    // Browser environment
    if (typeof document !== 'undefined') {
      const blob = new Blob([content], { type: mime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    // Node.js environment
    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        // eslint-disable-next-line no-undef
        const fs = require('fs');
        if (isBinary) fs.writeFileSync(filename, content);
        else          fs.writeFileSync(filename, content, 'utf8');
        return;
      } catch (e) {
        throw new Error('Node.js fs module not available: ' + e.message);
      }
    }

    throw new Error('download() is only supported in browser or Node.js environments.');
  }

  /* -----------------------------------------------------------------------
   * close — free WASM resources
   * --------------------------------------------------------------------- */
  close() {
    this._freeScan();
    this.wasm = null;
  }

  /* =========================================================================
   * Private helpers
   * ======================================================================= */

  async _toUint8Array(source) {
    if (source instanceof Uint8Array)  return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (typeof File !== 'undefined' && source instanceof File)
      return new Uint8Array(await source.arrayBuffer());

    const url = source instanceof URL ? source.href : source;
    if (typeof url !== 'string')
      throw new Error('Unsupported source type. Use File, URL, ArrayBuffer, or Uint8Array.');

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.statusText}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  _detectFormat(source, data) {
    // GRIB2 magic: 'GRIB' = 0x47 0x52 0x49 0x42
    if (data.length >= 4 &&
        data[0] === 0x47 && data[1] === 0x52 &&
        data[2] === 0x49 && data[3] === 0x42) return 'grib2';

    // NetCDF3 magic: 'CDF\x01' or 'CDF\x02'
    if (data.length >= 4 &&
        data[0] === 0x43 && data[1] === 0x44 && data[2] === 0x46 &&
        (data[3] === 0x01 || data[3] === 0x02)) return 'netcdf3';

    // HDF5 / NetCDF4 magic: \x89HDF\r\n\x1a\n
    if (data.length >= 8 &&
        data[0] === 0x89 && data[1] === 0x48 && data[2] === 0x44 && data[3] === 0x46 &&
        data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A)
      return 'netcdf4';

    // ZIP / Zarr-zip magic: 'PK\x03\x04' (we treat ZIP as candidate Zarr;
    // _scanZarr() will throw a clear error if there's no .zarray inside).
    if (data.length >= 4 &&
        data[0] === 0x50 && data[1] === 0x4B &&
        data[2] === 0x03 && data[3] === 0x04) return 'zarr';

    // Fallback: file extension
    const name = (source && source.name)      ? source.name
              : (typeof source === 'string')  ? source
              : (source instanceof URL)       ? source.pathname
              : '';
    if (/\.(grb2?|grib2?)$/i.test(name))         return 'grib2';
    if (/\.nc3$/i.test(name))                    return 'netcdf3';
    if (/\.(nc|nc4|netcdf)$/i.test(name))        return 'netcdf4'; // default .nc to nc4 (more common)
    if (/\.(zarr|zarr\.zip|zip)$/i.test(name))   return 'zarr';
    throw new Error('Cannot detect file format. Supported: GRIB2 (.grb2), NetCDF3 (.nc3), NetCDF4 (.nc), Zarr v2 (.zarr/.zip)');
  }

  _scanGrib2(data) {
    const wasm = this.wasm;

    const ptr = wasm.ccall('wp_malloc', 'number', ['number'], [data.length]);
    if (ptr === 0) throw new Error('WASM out of memory');

    const CHUNK = 65536;
    for (let off = 0; off < data.length; off += CHUNK) {
      const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
      wasm.ccall('wp_memcpy', null,
        ['number', 'array', 'number'],
        [ptr + off, slice, slice.length]);
    }

    this.scanPtr = wasm.ccall('wp_scan', 'number',
      ['number', 'number'], [ptr, data.length]);
    wasm.ccall('wp_free', null, ['number'], [ptr]);

    if (this.scanPtr === 0) throw new Error('Failed to parse GRIB2 file');

    const varsJsonPtr = wasm.ccall('wp_scan_get_vars_json', 'number',
      ['number'], [this.scanPtr]);
    const varsJson = wasm.UTF8ToString(varsJsonPtr);
    wasm.ccall('wp_free', null, ['number'], [varsJsonPtr]);
    this.vars = JSON.parse(varsJson);

    /* Surface decoded ISO times per variable using wp_scan_messages_layout,
     * which already exposes each message's valid_time (Unix seconds). */
    try {
      const layoutPtr = wasm.ccall('wp_scan_messages_layout', 'number',
        ['number'], [this.scanPtr]);
      if (layoutPtr !== 0) {
        const layoutJson = wasm.UTF8ToString(layoutPtr);
        wasm.ccall('wp_free', null, ['number'], [layoutPtr]);
        const messages = JSON.parse(layoutJson);
        /* Group valid_times by (cat, num) — the same key used in vars. */
        const timesByVar = new Map();
        for (const m of messages) {
          const key = `${m.cat}/${m.num}`;
          const list = timesByVar.get(key) || [];
          list.push(m.valid_time);
          timesByVar.set(key, list);
        }
        for (const v of this.vars) {
          const list = timesByVar.get(`${v.cat}/${v.num}`);
          if (!list || list.length === 0) continue;
          /* Preserve message order, drop duplicates (timesteps with multiple
           * levels/bands share a valid_time) while keeping sequence stable. */
          const seen = new Set();
          const uniq = [];
          for (const t of list) if (!seen.has(t)) { seen.add(t); uniq.push(t); }
          try {
            v.times = decodeTimes(uniq, 'seconds since 1970-01-01', 'standard');
          } catch (e) {
            v.times = null;
            (v.warnings ||= []).push(`Could not decode times: ${e.message}`);
          }
        }
      }
    } catch (e) {
      /* Best-effort — leave v.times absent on failure. */
    }
  }

  _scanNetCDF3(data) {
    const wasm = this.wasm;
    const ptr = wasm.ccall('wp_malloc', 'number', ['number'], [data.length]);
    if (ptr === 0) throw new Error('WASM out of memory');

    const CHUNK = 65536;
    for (let off = 0; off < data.length; off += CHUNK) {
      const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
      wasm.ccall('wp_memcpy', null, ['number', 'array', 'number'], [ptr + off, slice, slice.length]);
    }

    this.scanPtr = wasm.ccall('wp_nc3_scan', 'number', ['number', 'number'], [ptr, data.length]);
    wasm.ccall('wp_free', null, ['number'], [ptr]);

    if (this.scanPtr === 0) throw new Error('Failed to parse NetCDF3 file');

    const varsJsonPtr = wasm.ccall('wp_nc3_scan_get_vars_json', 'number', ['number'], [this.scanPtr]);
    const varsJson = wasm.UTF8ToString(varsJsonPtr);
    wasm.ccall('wp_free', null, ['number'], [varsJsonPtr]);
    this.vars = JSON.parse(varsJson);
  }

  _freeScan() {
    if (this._format === 'netcdf4') {
      if (this._nc4) {
        try { this._nc4.f.close(); }          catch (_) {}
        try { this._nc4.FS.unlink(this._nc4.fname); } catch (_) {}
        this._nc4 = null;
      }
    } else if (this._format === 'zarr') {
      if (this._zarrScan) {
        try { Zarr.scanFree(this._zarrScan); } catch (_) {}
        this._zarrScan = null;
      }
    } else if (this.scanPtr && this.wasm) {
      const freeFn = this._format === 'netcdf3' ? 'wp_nc3_scan_free' : 'wp_scan_free';
      this.wasm.ccall(freeFn, null, ['number'], [this.scanPtr]);
      this.scanPtr = 0;
    }
    this.vars     = [];
    this._format  = null;
    this._geoBbox = null;
  }

  _requireScan() {
    if (this._format === 'netcdf4') {
      if (!this._nc4) throw new Error('No file loaded. Call read() first.');
    } else if (this._format === 'zarr') {
      if (!this._zarrScan) throw new Error('No file loaded. Call read() first.');
    } else {
      if (!this.scanPtr) throw new Error('No file loaded. Call read() first.');
    }
  }

  /* Scan a Zarr-zip file via the JS helper, populate this.vars in the same
   * shape as the other formats so getvariables()/extract() work uniformly. */
  async _scanZarr(data) {
    const scanResult = await Zarr.scan(data);
    this._zarrScan = scanResult;
    this.vars = JSON.parse(Zarr.scanGetVarsJson(scanResult));

    // Derive a real geographic bbox from the store's lat/lon coordinate arrays
    // so regional Zarr data lands on its actual footprint instead of being
    // stretched across an assumed-global box. Null when the store has no usable
    // coords (synthetic axes) — callers fall back to global, same as before.
    try { this._geoBbox = await Zarr.geoBbox(scanResult); }
    catch (_) { this._geoBbox = null; }
  }

  /* =========================================================================
   * NetCDF4 private helpers
   * ======================================================================= */

  /* Lazy-load h5wasm only when a NetCDF4 file is first opened.
   *
   * Resolution order so consumers never have to `npm install h5wasm` separately:
   *   1. Browsers           → fetch the ESM bundle from jsdelivr CDN
   *   2. Node / bundlers    → resolve the bare specifier `h5wasm` from node_modules
   *                           (when the host project did install it, e.g. via Vite,
   *                            Webpack, or a Node script)
   *
   * Override:
   *   new SciWridToolkit({ h5wasmUrl: '<your-mirror-url>' })   // takes priority
   *
   * The browser path requires the CDN to allow cross-origin fetches (jsdelivr does).
   * Returns { h5, FS } where h5 is the module and FS is the Emscripten FS.
   */
  async _getH5wasm() {
    if (this._h5wasmModule) return this._h5wasmModule;

    const override = this.config?.h5wasmUrl;
    const isNode   = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    const candidates = override
      ? [override]
      : isNode
        ? ['h5wasm', 'https://cdn.jsdelivr.net/npm/h5wasm@0.7.7/+esm']
        : ['https://cdn.jsdelivr.net/npm/h5wasm@0.7.7/+esm', 'h5wasm'];

    let mod, lastErr;
    for (const spec of candidates) {
      try { mod = await import(/* @vite-ignore */ spec); break; }
      catch (e) { lastErr = e; }
    }
    if (!mod) {
      throw new Error(
        'Failed to load h5wasm — tried ' + candidates.join(', ') +
        '. Last error: ' + (lastErr?.message || lastErr)
      );
    }

    const h5 = mod.default ?? mod;
    const { FS } = await h5.ready;
    this._h5wasmModule = { h5, FS };
    return this._h5wasmModule;
  }

  /* Derive [minLon, minLat, maxLon, maxLat] from the lat/lon coordinate
   * datasets. Returns null when either coord is missing or has no finite
   * values. Min/max (not first/last) so the bbox is correct regardless of
   * ascending vs descending coordinate order. */
  _nc4CoordBbox(f, latC, lonC) {
    if (!latC || !lonC) return null;
    const range = (name) => {
      try {
        const vals = f.get(name).value;
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < vals.length; i++) {
          const n = Number(vals[i]);
          if (!Number.isFinite(n)) continue;
          if (n < mn) mn = n;
          if (n > mx) mx = n;
        }
        return mn <= mx ? [mn, mx] : null;
      } catch (_) { return null; }
    };
    const lat = range(latC.name);
    const lon = range(lonC.name);
    if (!lat || !lon) return null;
    return [lon[0], lat[0], lon[1], lat[1]];
  }

  /* Read an h5wasm attribute value defensively (handles both {value} and raw forms) */
  _nc4Attr(attrs, name) {
    const a = attrs[name];
    if (a == null) return undefined;
    if (typeof a === 'object' && 'value' in a) return a.value;
    return a;
  }

  /* Convert a CF time value to Unix seconds.
   * units example: "hours since 1900-01-01 00:00:00.0" */
  _nc4TimeToS(val, units) {
    if (!units) return val;
    const m = units.match(
      /^(seconds?|minutes?|hours?|days?)\s+since\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?)/i
    );
    if (!m) return 0;
    const unit  = m[1].toLowerCase();
    const epoch = Date.parse(m[2].replace(' ', 'T') + 'Z') / 1000; // seconds
    const mult  = unit.startsWith('s') ? 1
                : unit.startsWith('mi') ? 60
                : unit.startsWith('h') ? 3600
                : /* days */             86400;
    return epoch + val * mult;
  }

  /* Copy any typed array into WASM heap via chunked wp_memcpy.
   * Returns pointer; caller must wp_free it after use. */
  _copyBytesToWasm(typedArray) {
    const wasm  = this.wasm;
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const ptr   = wasm.ccall('wp_malloc', 'number', ['number'], [bytes.length]);
    if (ptr === 0) throw new Error('WASM out of memory');
    const CHUNK = 65536;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
      wasm.ccall('wp_memcpy', null, ['number', 'array', 'number'], [ptr + off, slice, slice.length]);
    }
    return ptr;
  }

  /* Copy a Float32Array into WASM heap; returns pointer (caller must wp_free it) */
  _copyF32ToWasm(arr) { return this._copyBytesToWasm(arr); }

  /* Copy a Float64Array into WASM heap; returns pointer (caller must wp_free it) */
  _copyF64ToWasm(arr) { return this._copyBytesToWasm(arr); }

  /* Scan a NetCDF4/HDF5 file using h5wasm and populate this.vars */
  async _scanNetCDF4(data) {
    const { h5, FS } = await this._getH5wasm();

    // Write to h5wasm virtual FS
    const fname = `_wp_${Date.now()}.nc`;
    FS.writeFile(fname, data);

    const f = new h5.File(fname, 'r');
    this._nc4 = { f, fname, FS };

    const keys = f.keys();

    // ---- Identify coordinate variables (1-D datasets matching CF names) ----
    // coordByType: first match of each type; coordByName: all matches
    const coordByType = {};
    const coordByName = {};

    for (const name of keys) {
      const item = f.get(name);
      if (!item || item.constructor.name !== 'Dataset') continue;
      if (item.shape.length !== 1) continue;

      const a    = item.attrs;
      const lname = name.toLowerCase();
      const axis  = String(this._nc4Attr(a, 'axis') ?? '').toUpperCase();
      const sname = String(this._nc4Attr(a, 'standard_name') ?? '').toLowerCase();
      const units = String(this._nc4Attr(a, 'units') ?? '').toLowerCase();

      let type = null;
      if (lname === 'lat' || lname === 'latitude' || lname === 'y' || lname === 'rlat' ||
          axis === 'Y' || sname === 'latitude' || units.includes('degrees_north'))
        type = 'lat';
      else if (lname === 'lon' || lname === 'longitude' || lname === 'x' || lname === 'rlon' ||
               axis === 'X' || sname === 'longitude' || units.includes('degrees_east'))
        type = 'lon';
      else if (lname === 'time' || lname === 't' ||
               axis === 'T' || sname === 'time' || units.includes('since'))
        type = 'time';

      if (type) {
        const entry = { name, type, length: item.shape[0], units };
        if (!coordByType[type]) coordByType[type] = entry;
        coordByName[name] = entry;
      }
    }

    // ---- Geographic extent from the lat/lon coordinate variables ----------
    // 1-D coord arrays are cheap to read; their min/max give a real bbox so
    // the grid can be placed on a map instead of assuming a global extent.
    this._geoBbox = this._nc4CoordBbox(f, coordByType.lat, coordByType.lon);

    // ---- Build variable list (multi-dim datasets that are not pure coords) ----
    this.vars = [];
    let index = 0;

    for (const name of keys) {
      const item = f.get(name);
      if (!item || item.constructor.name !== 'Dataset') continue;
      if (item.shape.length < 2) continue;                         // skip 1-D coord vars
      if (coordByName[name]) continue;                             // skip if identified as coord

      const a        = item.attrs;
      const long_name = String(this._nc4Attr(a, 'long_name') ?? this._nc4Attr(a, 'description') ?? '');
      const units_val = String(this._nc4Attr(a, 'units') ?? '');
      const shape     = item.shape;

      // Match shape dimensions to known coordinates by length
      let latC = null, lonC = null, timC = null;
      for (let d = 0; d < shape.length; d++) {
        const len = shape[d];
        if (!latC && coordByType.lat  && coordByType.lat.length  === len) { latC = { dim: d, ...coordByType.lat  }; continue; }
        if (!lonC && coordByType.lon  && coordByType.lon.length  === len) { lonC = { dim: d, ...coordByType.lon  }; continue; }
        if (!timC && coordByType.time && coordByType.time.length === len) { timC = { dim: d, ...coordByType.time }; continue; }
      }

      const supported = !!(latC && lonC);

      // Decode the time axis to ISO-8601 strings if a time coord exists.
      // Failures degrade gracefully — the rest of the variable info is intact.
      let times = null;
      const timeWarnings = [];
      if (timC) {
        try {
          const timDS    = f.get(timC.name);
          const timUnits = this._nc4Attr(timDS.attrs, 'units');
          const timCal   = this._nc4Attr(timDS.attrs, 'calendar');
          if (timUnits) {
            const raw = timDS.value;
            const values = new Array(raw.length);
            for (let i = 0; i < raw.length; i++) values[i] = Number(raw[i]);
            times = decodeTimes(values, String(timUnits), timCal ? String(timCal) : 'standard');
          }
        } catch (e) {
          timeWarnings.push(`Could not decode times for "${name}": ${e.message}. ` +
                            `Raw values still available via extract({time: n}).`);
        }
      }

      this.vars.push({
        index:      index++,
        name,
        long_name,
        units:      units_val,
        shape:      shape.join('x'),
        ndims:      shape.length,
        supported,
        times,
        warnings:   timeWarnings,
        _shape:     shape,
        _latCoord:  latC,
        _lonCoord:  lonC,
        _timCoord:  timC,
      });
    }
  }

  /* Decode one variable from the open NC4 file → refs_dataset_t* in WASM */
  async _normalizeNetCDF4(varInfo) {
    const wasm = this.wasm;
    const f    = this._nc4.f;

    const item  = f.get(varInfo.name);
    const a     = item.attrs;

    // CF scale / offset / fill
    const scale   = Number(this._nc4Attr(a, 'scale_factor')  ?? 1);
    const offset  = Number(this._nc4Attr(a, 'add_offset')    ?? 0);
    const fillRaw = this._nc4Attr(a, '_FillValue');
    const missRaw = this._nc4Attr(a, 'missing_value');
    const fill    = fillRaw != null ? Number(fillRaw) : 9.969209968386869e36;
    const miss    = missRaw != null ? Number(missRaw) : fill;

    const shape   = varInfo._shape;
    const latC    = varInfo._latCoord;
    const lonC    = varInfo._lonCoord;
    const timC    = varInfo._timCoord;

    const ny = latC.length;
    const nx = lonC.length;
    const nt = timC ? timC.length : 1;

    // ---- Read lat / lon coordinate arrays ----
    const latRaw = f.get(latC.name).value;
    const lonRaw = f.get(lonC.name).value;
    const latsF32 = new Float32Array(ny);
    const lonsF32 = new Float32Array(nx);
    for (let i = 0; i < ny; i++) latsF32[i] = Number(latRaw[i]);
    for (let i = 0; i < nx; i++) lonsF32[i] = Number(lonRaw[i]);

    // ---- Read time array ----
    const timesF64 = new Float64Array(nt);
    if (timC) {
      const timDS    = f.get(timC.name);
      const timUnits = String(this._nc4Attr(timDS.attrs, 'units') ?? 'days since 1970-01-01');
      const timRaw   = timDS.value;
      for (let i = 0; i < nt; i++)
        timesF64[i] = this._nc4TimeToS(Number(timRaw[i]), timUnits);
    } else {
      for (let i = 0; i < nt; i++) timesF64[i] = i * 86400;
    }

    // ---- Read data, reorder to [nt, ny, nx], apply CF transforms ----
    const rawData  = item.value;            // TypedArray from h5wasm
    const dataF32  = new Float32Array(nt * ny * nx);

    // Compute C-order strides for the raw HDF5 shape
    const strides = new Array(shape.length);
    strides[shape.length - 1] = 1;
    for (let d = shape.length - 2; d >= 0; d--)
      strides[d] = strides[d + 1] * shape[d + 1];

    const timDim = timC ? timC.dim : -1;
    const latDim = latC.dim;
    const lonDim = lonC.dim;

    for (let t = 0; t < nt; t++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          // Build source index: time/lat/lon at their dim positions; extra dims = 0
          let src = 0;
          if (timDim >= 0) src += t * strides[timDim];
          src += y * strides[latDim];
          src += x * strides[lonDim];

          const dst = t * ny * nx + y * nx + x;
          const v   = Number(rawData[src]);
          dataF32[dst] = (v === fill || v === miss || !isFinite(v)) ? NaN
                                                                     : v * scale + offset;
        }
      }
    }

    // ---- Copy arrays into WASM heap ----
    const latsPtr  = this._copyF32ToWasm(latsF32);
    const lonsPtr  = this._copyF32ToWasm(lonsF32);
    const timesPtr = this._copyF64ToWasm(timesF64);
    const dataPtr  = this._copyF32ToWasm(dataF32);

    // Create refs_dataset_t in C (it copies the arrays internally)
    const ds = wasm.ccall(
      'wp_open_from_float_arrays', 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [varInfo.name, nx, ny, nt, latsPtr, lonsPtr, timesPtr, dataPtr]
    );

    // Free our temporary WASM buffers
    wasm.ccall('wp_free', null, ['number'], [latsPtr]);
    wasm.ccall('wp_free', null, ['number'], [lonsPtr]);
    wasm.ccall('wp_free', null, ['number'], [timesPtr]);
    wasm.ccall('wp_free', null, ['number'], [dataPtr]);

    return ds;
  }

  _toCSV(data) {
    const items = data.variables ?? [data];
    const rows  = ['variable,time,value,lat,lon'];

    for (const item of items) {
      const varName = item.variable ?? 'value';
      const lat     = item.location?.lat ?? '';
      const lon     = item.location?.lon ?? '';

      if (item.timeseries) {
        for (const pt of item.timeseries)
          rows.push(`${varName},${pt.time},${pt.value},${lat},${lon}`);
      } else if (item.value !== undefined) {
        rows.push(`${varName},${item.time ?? ''},${item.value},${lat},${lon}`);
      }
    }
    return rows.join('\n');
  }

  _toGeoJSON(data) {
    const items    = data.variables ?? [data];
    const features = [];

    for (const item of items) {
      const lat = item.location?.lat;
      const lon = item.location?.lon;
      features.push({
        type: 'Feature',
        geometry: (lat !== undefined && lon !== undefined)
          ? { type: 'Point', coordinates: [lon, lat] }
          : null,
        properties: {
          variable:   item.variable   ?? null,
          timeseries: item.timeseries ?? null,
          value:      item.value      ?? null,
          time:       item.time       ?? null,
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }
}

/* Default export so users can do either:
 *   import { SciWridToolkit } from 'sciwrid-toolkit';
 *   import SciWridToolkit from 'sciwrid-toolkit';
 */
export default SciWridToolkit;
