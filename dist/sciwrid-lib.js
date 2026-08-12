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
import * as Parquet from './parquet-helper.js';
import { decodeTimes } from './time-decoder.js';
import { h5TempName } from './hdf5/vfs-name.js';
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
    this._parquetScan    = null;   // result of Parquet.scan() for open Parquet file
    this._parquetSource  = null;   // original bytes for JS Parquet extract paths
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
    } else if (format === 'parquet') {
      this._format = 'parquet';
      this._parquetSource = data;
      await this._scanParquet(data);
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
    }

    /* Unique units across the file's variables.
     *
     * GRIB2 is included now that it HAS units to report. They are not stored
     * in the file -- the C engine resolves them from WMO Code Table 4.2, via
     * the generated formats/grib2/grib2_param_table.h.
     *
     * That generator normalises unit spelling, which is what lets this list
     * mean anything: a GRIB2 file draws parameters from both the WMO table and
     * its originating centre's, and the two disagree ("kg m-2" vs "kg m**-2"),
     * while WMO's own tables mix solidus and exponent forms ("m/s" vs
     * "m s-1"). Two spellings of one unit would put it here twice. */
    if (this._format === 'netcdf3' || this._format === 'netcdf4' ||
        this._format === 'grib2') {
      base.units = [...new Set(this.vars.map(v => v.units).filter(Boolean))];
    }

    if (this._format === 'zarr') {
      base.shapes      = [...new Set(this.vars.map(v => (v.shape || []).join('x')))];
      base.dtypes      = [...new Set(this.vars.map(v => v.dtype).filter(Boolean))];
      base.compressors = [...new Set(this.vars.map(v => v.compressor).filter(Boolean))];
    }

    if (this._format === 'parquet') {
      base.gridTypes = [...new Set(this.vars.map(v => v.gridType).filter(Boolean))];
    }

    /* Geographic extent, attached the same way for every format. Optional by
     * contract: absent when the file's coordinates cannot be derived. */
    const bbox = this._geoBboxFor();
    if (bbox) base.bbox = bbox;

    return base;
  }

  /* -----------------------------------------------------------------------
   * _geoBboxFor — the one place meta.bbox comes from
   *
   * Every format answers the same question ("where on Earth is this grid?"),
   * so there is one entry point rather than a per-format copy of the same
   * two lines. It dispatches on the already-sniffed format and each backend
   * supplies the derivation:
   *
   *   netcdf3/4, zarr, parquet — the scanner is already walking lat/lon
   *     coordinate arrays, so it fills _geoBbox during scan() and this hands
   *     the cached value straight back.
   *   grib2 — coordinates are not stored in the file; they have to be
   *     projected from the Section 3 grid definition, which costs real time
   *     on curvilinear grids. Deferred to the first caller that asks, then
   *     cached in the same field.
   *
   * Returns null when the extent is not derivable (unsupported GRIB2 grid
   * template, Zarr store with synthetic axes, ...). Callers must treat
   * meta.bbox as optional; it has always been absent in those cases.
   * --------------------------------------------------------------------- */
  _geoBboxFor() {
    if (this._geoBbox) return this._geoBbox;      // filled during scan()
    switch (this._format) {
      case 'grib2': return (this._geoBbox = this._grib2GeoBbox());
      default:      return null;                  // nothing left to derive
    }
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
        } else if (this._format === 'parquet') {
          props = {
            index:     v.index,
            name:      v.name,
            gridType:  v.gridType || null,
            nx:        v.nx || 0,
            ny:        v.ny || 0,
            messages:  v.messages || 1,
            supported: v.supported,
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
    if (this._format === 'parquet') return Parquet.extract(this._parquetSource, options || {});

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
      let queryT1 = t1;
      let queryT2 = t2;
      if (this._format === 'netcdf4') {
        const sourceNt = v._timCoord ? v._timCoord.length : 1;
        const nc4T1 = Math.max(0, Math.min(t1, sourceNt - 1));
        const nc4T2 = Math.max(nc4T1, Math.min(t2 ?? sourceNt - 1, sourceNt - 1));
        ds = await this._normalizeNetCDF4(v, nc4T1, nc4T2);
        queryT1 = 0;
        queryT2 = Math.max(0, nc4T2 - nc4T1);
      } else if (this._format === 'zarr') {
        ds = await Zarr.normalize(this._zarrScan, v.index, wasm);
      } else if (this._format === 'grib2') {
        // Bounded path: decode-free coords -> nearest cell -> decode only the
        // requested window reduced to that cell (avoids the nt x grid OOM).
        const meta = wasm.ccall('wp_grid_coords', 'number', ['number', 'number'],
          [this.scanPtr, v.index]);
        if (!meta || meta === 0) { console.warn(`[sciwrid] grid_coords failed: ${v.name}`); continue; }
        const metaNt = wasm.ccall('wp_nt', 'number', ['number'], [meta]);
        let iy = -1, ix = -1;
        if (lat !== undefined && lon !== undefined) {
          if (wasm.ccall('wp_is_curvilinear', 'number', ['number'], [meta])) {
            const gnx = wasm.ccall('wp_nx', 'number', ['number'], [meta]);
            const flat = wasm.ccall('wp_find_nearest_cell', 'number',
              ['number', 'number', 'number'], [meta, lat, lon]);
            iy = Math.floor(flat / gnx); ix = flat % gnx;
          } else {
            iy = wasm.ccall('wp_find_nearest_lat', 'number', ['number', 'number'], [meta, lat]);
            ix = wasm.ccall('wp_find_nearest_lon', 'number', ['number', 'number'], [meta, lon]);
          }
        }
        wasm.ccall('wp_close', null, ['number'], [meta]);
        const gt1 = Math.max(0, Math.min(t1, metaNt - 1));
        const gt2 = Math.max(gt1, Math.min(t2 ?? metaNt - 1, metaNt - 1));
        const gds = wasm.ccall('wp_normalize_range', 'number',
          ['number', 'number', 'number', 'number', 'number', 'number'],
          [this.scanPtr, v.index, gt1, gt2, iy, ix]);
        if (!gds || gds === 0) { console.warn(`[sciwrid] normalize_range failed: ${v.name}`); continue; }
        try {
          const gnt = wasm.ccall('wp_nt', 'number', ['number'], [gds]);
          const rp = wasm.ccall('wp_query', 'number',
            ['number', 'number', 'number', 'number', 'number'], [gds, 0, gnt - 1, 0, 0]);
          if (rp !== 0) {
            const json = wasm.UTF8ToString(rp);
            wasm.ccall('wp_free', null, ['number'], [rp]);
            results.push(this._withUnits(JSON.parse(json), v));
          }
        } finally {
          wasm.ccall('wp_close', null, ['number'], [gds]);
        }
        continue;   // handled by the bounded path; skip the shared normalize/query below
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
        const actualT1 = Math.min(queryT1, nt - 1);
        const actualT2 = Math.min(queryT2 ?? nt - 1, nt - 1);

        let latIdx = -1, lonIdx = -1;
        if (wasm.ccall('wp_is_curvilinear', 'number', ['number'], [ds])
            && lat !== undefined && lon !== undefined) {
          // Curvilinear (projected) grid: a point maps to a single (row,col)
          // cell — find it jointly, then index it as data[t][latIdx][lonIdx].
          const nx   = wasm.ccall('wp_nx', 'number', ['number'], [ds]);
          const flat = wasm.ccall('wp_find_nearest_cell', 'number',
            ['number', 'number', 'number'], [ds, lat, lon]);
          latIdx = Math.floor(flat / nx);   // row
          lonIdx = flat % nx;               // col
        } else {
          if (lat !== undefined) {
            latIdx = wasm.ccall('wp_find_nearest_lat', 'number',
              ['number', 'number'], [ds, lat]);
          }
          if (lon !== undefined) {
            lonIdx = wasm.ccall('wp_find_nearest_lon', 'number',
              ['number', 'number'], [ds, lon]);
          }
        }

        const resultPtr = wasm.ccall('wp_query', 'number',
          ['number', 'number', 'number', 'number', 'number'],
          [ds, actualT1, actualT2, latIdx, lonIdx]);

        if (resultPtr !== 0) {
          const json = wasm.UTF8ToString(resultPtr);
          wasm.ccall('wp_free', null, ['number'], [resultPtr]);
          try {
            results.push(this._withUnits(JSON.parse(json), v));
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
    if (this._format === 'parquet') return Parquet.extractGrid(this._parquetSource, options || {});

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

    /* ---- Curvilinear (polar) grids: no 1D axes → resample in C via the
     * inverse projection (decodes only the requested timestep). ---- */
    if (this._format === 'grib2') {
      const curv = this._extractGridCurvilinear(v, bbox, width, height, time, variable);
      if (curv) { if (onProgress) onProgress({ done: width * height, total: width * height }); return curv; }
    }

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
   * _extractGridCurvilinear — window export for curvilinear (polar) GRIB2.
   * Returns the resampled grid { data, width, height, bbox, variable, units,
   * time } if the variable's grid is curvilinear, else null (rectilinear →
   * caller falls through to the normal 1D-axis path). Decodes only timestep t.
   * --------------------------------------------------------------------- */
  /* -----------------------------------------------------------------------
   * _grib2GeoBbox — geographic envelope of the first GRIB2 grid we can place.
   * The grib2 backend behind _geoBboxFor.
   *
   * Without this, GRIB2 metadata gave nx/ny and a template number and nothing
   * else, so a consumer had to invent an extent -- which is how a CONUS Stage
   * IV field ended up drawn over Canada.
   *
   * wp_grid_coords already materialises real lat/lon for every supported
   * template, including polar stereographic (via polar_stereo_compute_latlon),
   * so the envelope is a min/max over those coordinates.
   *
   * Deliberately NOT a four-corner box: on a projected grid the extreme
   * latitude sits mid-edge, not at a corner, so corners would under-report the
   * northern extent of exactly the domains this exists to fix.
   * --------------------------------------------------------------------- */
  _grib2GeoBbox() {
    const wasm = this.wasm;
    if (this._format !== 'grib2' || !wasm || !this.scanPtr) return null;
    if (typeof wasm._wp_grid_coords !== 'function') return null;

    for (const v of this.vars) {
      let ds = 0;
      try {
        ds = wasm.ccall('wp_grid_coords', 'number', ['number', 'number'],
          [this.scanPtr, v.index]);
        if (!ds) continue;                       /* template we cannot place */

        const curv    = wasm.ccall('wp_is_curvilinear', 'number', ['number'], [ds]);
        const nx      = wasm.ccall('wp_nx', 'number', ['number'], [ds]);
        const ny      = wasm.ccall('wp_ny', 'number', ['number'], [ds]);
        const latsPtr = wasm.ccall('wp_ds_lats_ptr', 'number', ['number'], [ds]);
        const lonsPtr = wasm.ccall('wp_ds_lons_ptr', 'number', ['number'], [ds]);
        if (!nx || !ny) continue;

        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        const see = (a, o) => {
          if (Number.isFinite(a)) { if (a < minLat) minLat = a; if (a > maxLat) maxLat = a; }
          if (Number.isFinite(o)) {
            if (o > 180) o -= 360;      /* GRIB2 stores 0..360; we speak -180..180 */
            if (o < minLon) minLon = o;
            if (o > maxLon) maxLon = o;
          }
        };

        if (curv) {
          /* Curvilinear grids keep a lat/lon per cell, which refs_lats()/
           * refs_lons() do not expose, so read cells directly. Only the
           * boundary is walked: the projection is smooth, so the lat/lon
           * extremes of a rectangular index region lie on its edges. That is
           * 2*(nx+ny) cells instead of nx*ny -- 4k rather than ~1M for Stage IV. */
          const cellLat = wasm.cwrap('wp_cell_lat', 'number', ['number', 'number', 'number']);
          const cellLon = wasm.cwrap('wp_cell_lon', 'number', ['number', 'number', 'number']);
          for (let ix = 0; ix < nx; ix++) {
            see(cellLat(ds, 0, ix),      cellLon(ds, 0, ix));
            see(cellLat(ds, ny - 1, ix), cellLon(ds, ny - 1, ix));
          }
          for (let iy = 0; iy < ny; iy++) {
            see(cellLat(ds, iy, 0),      cellLon(ds, iy, 0));
            see(cellLat(ds, iy, nx - 1), cellLon(ds, iy, nx - 1));
          }
        } else {
          if (!latsPtr || !lonsPtr) continue;
          const lats = new Float32Array(wasm.HEAPF32.buffer, latsPtr, ny);
          const lons = new Float32Array(wasm.HEAPF32.buffer, lonsPtr, nx);
          for (let i = 0; i < ny; i++) see(lats[i], undefined);
          for (let i = 0; i < nx; i++) see(undefined, lons[i]);
        }

        if (!Number.isFinite(minLat) || !Number.isFinite(minLon) ||
            !(maxLat > minLat) || !(maxLon > minLon)) continue;

        return [minLon, minLat, maxLon, maxLat];
      } catch (_) {
        /* try the next variable rather than failing the whole scan */
      } finally {
        if (ds) { try { wasm.ccall('wp_close', null, ['number'], [ds]); } catch (_) {} }
      }
    }
    return null;
  }

  _extractGridCurvilinear(v, bbox, width, height, time, variable) {
    if (this._format !== 'grib2') return null;
    const wasm = this.wasm;
    const meta = wasm.ccall('wp_grid_coords', 'number', ['number', 'number'],
      [this.scanPtr, v.index]);
    if (!meta || meta === 0) return null;
    const isCurv = wasm.ccall('wp_is_curvilinear', 'number', ['number'], [meta]);
    const metaNt = wasm.ccall('wp_nt', 'number', ['number'], [meta]);
    wasm.ccall('wp_close', null, ['number'], [meta]);
    if (!isCurv) return null;                 // rectilinear → normal path

    const tt = Math.max(0, Math.min(time, metaNt - 1));
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const ptr = wasm.ccall('wp_grid_resample_polar', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [this.scanPtr, v.index, tt, minLon, minLat, maxLon, maxLat, width, height]);
    if (!ptr || ptr === 0) throw new Error(`Failed to resample curvilinear grid: ${v.name}`);
    const data = new Float32Array(wasm.HEAPF32.buffer, ptr, width * height).slice();
    wasm.ccall('wp_free', null, ['number'], [ptr]);
    return { data, width, height, bbox, variable, units: v.units || '', time };
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
      const sourceNt = v._timCoord ? v._timCoord.length : 1;
      const tt = Math.min(t, sourceNt - 1);
      const a = await this._normalizeNetCDF4ToArrays(v, tt, tt);
      return {
        lats: a.latsF32,
        lons: a.lonsF32,
        sliceData: a.dataF32,
        ny: a.ny, nx: a.nx, nt: a.nt,
        units: v.units || '',
        timeValue: a.timesF64[0],
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
    let gridTT = t;               // remapped timestep index within the decoded ds
    if (this._format === 'zarr') {
      ds = await Zarr.normalize(this._zarrScan, v.index, wasm);
    } else if (this._format === 'grib2') {
      // Bounded: decode only the requested timestep, not the whole cube.
      const meta = wasm.ccall('wp_grid_coords', 'number', ['number', 'number'],
        [this.scanPtr, v.index]);
      if (!meta || meta === 0) throw new Error(`Failed to decode variable: ${v.name}`);
      const metaNt = wasm.ccall('wp_nt', 'number', ['number'], [meta]);
      wasm.ccall('wp_close', null, ['number'], [meta]);
      const tt0 = Math.max(0, Math.min(t, metaNt - 1));
      ds = wasm.ccall('wp_normalize_range', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number'],
        [this.scanPtr, v.index, tt0, tt0, -1, -1]);
      gridTT = 0;                 // bounded ds holds exactly one timestep
    } else {
      const normFn = this._format === 'netcdf3' ? 'wp_nc3_normalize' : 'wp_normalize';
      ds = wasm.ccall(normFn, 'number', ['number', 'number'], [this.scanPtr, v.index]);
    }
    if (!ds || ds === 0) throw new Error(`Failed to decode variable: ${v.name}`);

    try {
      const ny = wasm.ccall('wp_ny', 'number', ['number'], [ds]);
      const nx = wasm.ccall('wp_nx', 'number', ['number'], [ds]);
      const nt = wasm.ccall('wp_nt', 'number', ['number'], [ds]);
      const tt = this._format === 'grib2' ? gridTT : Math.min(t, nt - 1);

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

      return { lats, lons, sliceData, ny, nx, nt, units: v.units || '' };
    } finally {
      wasm.ccall('wp_close', null, ['number'], [ds]);
    }
  }

  /* Helper that returns the same typed arrays _normalizeNetCDF4 builds, but
   * WITHOUT copying them into WASM. extractGrid uses this for the JS-only
   * pure-JS worker path. */
  async _normalizeNetCDF4ToArrays(varInfo, tStart = 0, tEnd = null) {
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
    const readT1 = Math.max(0, Math.min(tStart, nt - 1));
    const readT2 = Math.max(readT1, Math.min(tEnd ?? nt - 1, nt - 1));
    const outNt = timC ? (readT2 - readT1 + 1) : 1;

    const latRaw  = f.get(latC.name).value;
    const lonRaw  = f.get(lonC.name).value;
    const latsF32 = new Float32Array(ny);
    const lonsF32 = new Float32Array(nx);
    for (let i = 0; i < ny; i++) latsF32[i] = Number(latRaw[i]);
    for (let i = 0; i < nx; i++) lonsF32[i] = Number(lonRaw[i]);

    const timesF64 = new Float64Array(outNt);
    if (timC) {
      const timDS    = f.get(timC.name);
      const timUnits = String(this._nc4Attr(timDS.attrs, 'units') ?? 'days since 1970-01-01');
      const timRaw   = this._nc4ReadDatasetSlice(timDS, [[readT1, readT2 + 1]]);
      for (let i = 0; i < outNt; i++)
        timesF64[i] = this._nc4TimeToS(Number(timRaw[i]), timUnits);
    } else {
      for (let i = 0; i < outNt; i++) timesF64[i] = i * 86400;
    }

    const timDim = timC ? timC.dim : -1;
    const latDim = latC.dim;
    const lonDim = lonC.dim;
    const ranges = shape.map(() => [null, null]);
    if (timDim >= 0) ranges[timDim] = [readT1, readT2 + 1];
    const rawData = this._nc4ReadDatasetSlice(item, ranges);
    const sliceShape = shape.slice();
    if (timDim >= 0) sliceShape[timDim] = outNt;
    const strides = new Array(sliceShape.length);
    strides[sliceShape.length - 1] = 1;
    for (let d = sliceShape.length - 2; d >= 0; d--)
      strides[d] = strides[d + 1] * sliceShape[d + 1];

    const dataF32 = new Float32Array(outNt * ny * nx);

    for (let tt = 0; tt < outNt; tt++) {
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
    return { latsF32, lonsF32, timesF64, dataF32, ny, nx, nt: outNt };
  }

  _nc4ReadDatasetSlice(dataset, ranges) {
    if (typeof dataset.slice === 'function') return dataset.slice(ranges);
    return dataset.value;
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

    // Parquet magic: PAR1 at both head and tail.
    if (data.length >= 8 &&
        data[0] === 0x50 && data[1] === 0x41 && data[2] === 0x52 && data[3] === 0x31 &&
        data[data.length - 4] === 0x50 && data[data.length - 3] === 0x41 &&
        data[data.length - 2] === 0x52 && data[data.length - 1] === 0x31) return 'parquet';

    // Fallback: file extension
    const name = (source && source.name)      ? source.name
              : (typeof source === 'string')  ? source
              : (source instanceof URL)       ? source.pathname
              : '';
    if (/\.(grb2?|grib2?)$/i.test(name))         return 'grib2';
    if (/\.nc3$/i.test(name))                    return 'netcdf3';
    if (/\.(nc|nc4|netcdf)$/i.test(name))        return 'netcdf4'; // default .nc to nc4 (more common)
    if (/\.(zarr|zarr\.zip|zip)$/i.test(name))   return 'zarr';
    throw new Error('Cannot detect file format. Supported: GRIB2 (.grb2), NetCDF3 (.nc3), NetCDF4 (.nc), Zarr v2 (.zarr/.zip), Parquet (.parquet)');
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

  /* Attach a variable's units to a point-extract result.
   *
   * extract() returned no units for ANY format -- a NetCDF4 file that reports
   * "kg m-2" from scan() and from extractGrid() gave `units: undefined` from
   * extract(). The value was there the whole time, on the variable record; the
   * WASM query result simply never carried it.
   *
   * Only fills a gap, never overwrites: a path that already resolved units
   * (the range extractors read them from the file itself) keeps its own. */
  _withUnits(result, v) {
    if (!result || typeof result !== 'object' || result.units != null || !v) return result;
    /* Formats disagree on where units live on the variable record: GRIB2 and
     * NetCDF put them at the top level, Zarr keeps the raw .zattrs under
     * `attrs`. Both are the same fact about the same variable. */
    const units = v.units || (v.attrs && v.attrs.units);
    if (units) result.units = units;
    return result;
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

    /* Geographic extent, while the bytes are still in hand. See _nc3GeoBbox. */
    try { this._geoBbox = this._nc3GeoBbox(data); }
    catch (_) { this._geoBbox = null; }
  }

  /* -----------------------------------------------------------------------
   * _nc3GeoBbox — geographic envelope of a NetCDF3 Classic file.
   *
   * NetCDF3 was the one supported format that never reported an extent:
   * _geoBbox was only ever assigned in _scanNetCDF4, so the netcdf3 arm of
   * _geoBboxFor fell through to `default: return null`. That is the same gap
   * GRIB2 had -- and it bites the same way, because extractGrid() REQUIRES a
   * bbox it was never given, so a caller has to invent one. Inventing one is
   * how a CONUS field ends up drawn over Canada.
   *
   * Read from the header layout, NOT by decoding the variable. wp_nc3_normalize
   * would materialise every timestep of a data variable just to reach its axes;
   * on a multi-gigabyte file that turns scan() from metadata work into a full
   * decode. wp_nc3_full_layout already reports each variable's byte offset,
   * type and attributes, so the coordinate arrays -- a few kilobytes -- can be
   * read straight out of the file bytes. Cost is independent of file size.
   *
   * Coordinate identification mirrors _scanNetCDF4 exactly (name, axis,
   * standard_name, units), so the two NetCDF paths cannot drift into
   * disagreeing about which variable is the latitude.
   *
   * Returns null -- meaning "bbox legitimately absent", the documented
   * contract -- when there is no CF-identifiable lat/lon pair, when a
   * coordinate is a record variable (its values are interleaved across
   * records, not contiguous at `begin`), or when nothing finite is found.
   * --------------------------------------------------------------------- */
  _nc3GeoBbox(data) {
    const wasm = this.wasm;
    if (!wasm || !this.scanPtr) return null;
    if (typeof wasm._wp_nc3_full_layout !== 'function') return null;

    let layout;
    const ptr = wasm.ccall('wp_nc3_full_layout', 'number', ['number'], [this.scanPtr]);
    if (!ptr) return null;
    try { layout = JSON.parse(wasm.UTF8ToString(ptr)); }
    finally { wasm.ccall('wp_free', null, ['number'], [ptr]); }
    if (!layout || !Array.isArray(layout.vars)) return null;

    /* NetCDF3 external types. Only numeric ones can carry a coordinate. */
    const NC_BYTE = 1, NC_SHORT = 3, NC_INT = 4, NC_FLOAT = 5, NC_DOUBLE = 6;

    /* Attribute values arrive base64-encoded; they are latin1 text for NC_CHAR. */
    const attrText = (v, nm) => {
      const a = (v.atts || []).find((x) => x.name === nm);
      if (!a || typeof a.value_b64 !== 'string') return '';
      try {
        const bin = typeof atob === 'function'
          ? atob(a.value_b64)
          : Buffer.from(a.value_b64, 'base64').toString('latin1');
        return bin.replace(/\0+$/, '');
      } catch (_) { return ''; }
    };

    const classify = (v) => {
      const lname = String(v.name || '').toLowerCase();
      const axis  = attrText(v, 'axis').toUpperCase();
      const sname = attrText(v, 'standard_name').toLowerCase();
      const units = attrText(v, 'units').toLowerCase();
      if (lname === 'lat' || lname === 'latitude' || lname === 'y' || lname === 'rlat' ||
          axis === 'Y' || sname === 'latitude' || units.includes('degrees_north')) return 'lat';
      if (lname === 'lon' || lname === 'longitude' || lname === 'x' || lname === 'rlon' ||
          axis === 'X' || sname === 'longitude' || units.includes('degrees_east')) return 'lon';
      return null;
    };

    /* Read a 1-D numeric coordinate variable straight out of the file bytes.
     * NetCDF3 is big-endian and, for a non-record variable, contiguous at
     * `begin`. Returns null rather than a partial axis on any inconsistency. */
    const readAxis = (v) => {
      if (!v || v.ndims !== 1 || v.is_record) return null;
      const n = Array.isArray(v.shape) ? Number(v.shape[0]) : 0;
      const begin = Number(v.begin);
      if (!(n > 0) || !Number.isFinite(begin)) return null;

      const size = { [NC_BYTE]: 1, [NC_SHORT]: 2, [NC_INT]: 4, [NC_FLOAT]: 4, [NC_DOUBLE]: 8 }[v.type];
      if (!size) return null;                       // NC_CHAR or unknown
      if (begin + n * size > data.length) return null;

      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const o = begin + i * size;
        switch (v.type) {
          case NC_BYTE:   out[i] = dv.getInt8(o);            break;
          case NC_SHORT:  out[i] = dv.getInt16(o, false);    break;
          case NC_INT:    out[i] = dv.getInt32(o, false);    break;
          case NC_FLOAT:  out[i] = dv.getFloat32(o, false);  break;
          case NC_DOUBLE: out[i] = dv.getFloat64(o, false);  break;
          default: return null;
        }
      }
      return out;
    };

    let latV = null, lonV = null;
    for (const v of layout.vars) {
      const kind = classify(v);
      if (kind === 'lat' && !latV) latV = v;
      else if (kind === 'lon' && !lonV) lonV = v;
    }

    const lats = readAxis(latV);
    const lons = readAxis(lonV);
    if (!lats || !lons) return null;

    /* Min/max, not first/last: axes may descend, and a bbox that assumed
     * ascending order would come back inverted. */
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const a of lats) {
      if (!Number.isFinite(a)) continue;
      if (a < minLat) minLat = a;
      if (a > maxLat) maxLat = a;
    }
    for (let o of lons) {
      if (!Number.isFinite(o)) continue;
      if (o > 180) o -= 360;                        // 0..360 files; we speak -180..180
      if (o < minLon) minLon = o;
      if (o > maxLon) maxLon = o;
    }
    if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;

    return [minLon, minLat, maxLon, maxLat];
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
    } else if (this._format === 'parquet') {
      if (this._parquetScan) {
        try { Parquet.scanFree(this._parquetScan); } catch (_) {}
        this._parquetScan = null;
      }
      this._parquetSource = null;
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
    } else if (this._format === 'parquet') {
      if (!this._parquetScan) throw new Error('No file loaded. Call read() first.');
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

  /* Scan a Parquet / GeoParquet file via the JS helper. */
  async _scanParquet(data) {
    const scanResult = await Parquet.scan(data);
    this._parquetScan = scanResult;
    this.vars = JSON.parse(Parquet.scanGetVarsJson(scanResult));
    try { this._geoBbox = Parquet.geoBbox(scanResult); }
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

    // Write to h5wasm virtual FS. The FS is process-global and shared by every
    // instance, so the name has to be unique per open -- see hdf5/vfs-name.js.
    const fname = h5TempName('_wp');
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
  async _normalizeNetCDF4(varInfo, tStart = 0, tEnd = null) {
    const wasm = this.wasm;
    const { latsF32, lonsF32, timesF64, dataF32, ny, nx, nt } =
      await this._normalizeNetCDF4ToArrays(varInfo, tStart, tEnd);

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



