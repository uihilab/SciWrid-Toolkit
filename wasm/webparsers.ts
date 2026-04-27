/**
 * webparsers.ts  --  JavaScript/TypeScript library for meteorological data parsing
 *
 * Supported formats today: GRIB2 (grid templates 0, 30, 40)
 * Planned:                 NetCDF, HDF5, GeoTIFF, Zarr, Parquet
 *
 * Usage:
 *   const lib = new webparsers();
 *   await lib.read('https://example.com/data.grb2');
 *   // or
 *   await lib.read(fileInputElement.files[0]);
 *   // or
 *   await lib.read(arrayBuffer);
 *
 *   const vars = lib.getvariables();
 *   const result = await lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0 });
 *   const csv    = await lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0, type: 'csv' });
 */

/* =========================================================================
 * Types
 * ======================================================================= */

export interface WPConfig {
  /** Override path to webparsers.js if not in same directory */
  wasmPath?: string;
  /** Study area bounding box [minLon, minLat, maxLon, maxLat] */
  studyArea?: [number, number, number, number];
}

export interface WPVariable {
  index:          number;
  name:           string;
  cat:            number;
  num:            number;
  grid_template:  number;
  data_template:  number;
  nx:             number;
  ny:             number;
  messages:       number;
  supported:      boolean;
}

export interface WPExtractOptions {
  /** Variable name(s) to extract. Omit to extract all supported variables. */
  variable?: string | string[];
  /** Latitude for point query */
  lat?: number;
  /** Longitude for point query */
  lon?: number;
  /** Bounding box [minLon, minLat, maxLon, maxLat] — not yet implemented */
  bbox?: [number, number, number, number];
  /** Polygon vertices [[lon, lat], ...] — not yet implemented */
  polygon?: [number, number][];
  /** Start time index (default 0) */
  t1?: number;
  /** End time index (default last) */
  t2?: number;
  /** Output format: 'json' | 'csv' | 'geojson' (default 'json') */
  type?: 'json' | 'csv' | 'geojson';
}

/* =========================================================================
 * Internal WASM module type
 * ======================================================================= */

interface WasmModule {
  ccall: (name: string, ret: string | null, argTypes: string[], args: any[]) => any;
  UTF8ToString: (ptr: number) => string;
  stringToUTF8: (str: string, ptr: number, maxBytes: number) => void;
  lengthBytesUTF8: (str: string) => number;
}

declare function WebParsers(): Promise<WasmModule>;

/* =========================================================================
 * webparsers class
 * ======================================================================= */

export class webparsers {
  private wasm:     WasmModule | null = null;
  private scanPtr:  number = 0;
  private vars:     WPVariable[] = [];
  private config:   WPConfig;

  constructor(config: WPConfig = {}) {
    this.config = config;
  }

  /* -----------------------------------------------------------------------
   * init — load the WASM module (called automatically by read())
   * --------------------------------------------------------------------- */
  async init(): Promise<void> {
    if (this.wasm) return;
    this.wasm = await WebParsers();
  }

  /* -----------------------------------------------------------------------
   * read — load a GRIB2 file from a File, URL, ArrayBuffer, or Uint8Array
   *
   *   await lib.read(file)            // browser File object
   *   await lib.read('https://...')   // remote URL (fetch)
   *   await lib.read(arrayBuffer)     // raw ArrayBuffer
   *   await lib.read(uint8Array)      // raw bytes
   * --------------------------------------------------------------------- */
  async read(source: File | string | URL | ArrayBuffer | Uint8Array): Promise<void> {
    await this.init();
    this._freeScan();

    const data = await this._toUint8Array(source);
    const format = this._detectFormat(source, data);

    if (format === 'grib2') {
      await this._scanGrib2(data);
    } else {
      throw new Error(`Format '${format}' not yet supported. Supported: grib2`);
    }
  }

  /* -----------------------------------------------------------------------
   * metadata — summary info about the loaded file
   * --------------------------------------------------------------------- */
  metadata(): object {
    this._requireScan();
    const supported = this.vars.filter(v => v.supported);
    return {
      total_variables: this.vars.length,
      supported_variables: supported.length,
      grid_templates: [...new Set(this.vars.map(v => v.grid_template))],
      data_templates: [...new Set(this.vars.map(v => v.data_template))],
      variables: this.vars.map(v => v.name),
    };
  }

  /* -----------------------------------------------------------------------
   * getvariables — returns an array of variable descriptors
   * --------------------------------------------------------------------- */
  getvariables(): WPVariable[] {
    this._requireScan();
    return this.vars;
  }

  /* -----------------------------------------------------------------------
   * variables — returns variable list as a GeoJSON FeatureCollection.
   * Each feature has no geometry (no spatial extent yet) but full properties.
   * --------------------------------------------------------------------- */
  variables(): object {
    this._requireScan();
    return {
      type: 'FeatureCollection',
      features: this.vars.map(v => ({
        type: 'Feature',
        geometry: null,
        properties: {
          index:         v.index,
          name:          v.name,
          category:      v.cat,
          number:        v.num,
          grid_template: v.grid_template,
          data_template: v.data_template,
          grid_size:     `${v.nx}x${v.ny}`,
          messages:      v.messages,
          supported:     v.supported,
        },
      })),
    };
  }

  /* -----------------------------------------------------------------------
   * extract — decode and query data
   *
   * Point query:
   *   lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0 })
   *   lib.extract({ variable: ['TMP', 'UGRD'], lat: 40.7, lon: -74.0, type: 'csv' })
   *
   * Time range:
   *   lib.extract({ variable: 'TMP', lat: 40.7, lon: -74.0, t1: 0, t2: 5 })
   *
   * All variables:
   *   lib.extract({ lat: 40.7, lon: -74.0 })
   * --------------------------------------------------------------------- */
  async extract(options: WPExtractOptions): Promise<any> {
    this._requireScan();
    const wasm = this.wasm!;

    const { variable, lat, lon, t1 = 0, t2, type = 'json' } = options;

    // Resolve target variables
    let targets: WPVariable[];
    if (!variable) {
      targets = this.vars.filter(v => v.supported);
    } else {
      const names = Array.isArray(variable) ? variable : [variable];
      targets = this.vars.filter(v => names.includes(v.name) && v.supported);
      const missing = names.filter(n => !this.vars.find(v => v.name === n));
      if (missing.length > 0) throw new Error(`Variable(s) not found: ${missing.join(', ')}`);
      if (targets.length === 0) throw new Error(`None of the requested variables are supported`);
    }

    const results: any[] = [];

    for (const v of targets) {
      const ds: number = wasm.ccall('wp_normalize', 'number',
        ['number', 'number'], [this.scanPtr, v.index]);

      if (ds === 0) {
        console.warn(`[webparsers] Failed to decode variable: ${v.name}`);
        continue;
      }

      try {
        const nt: number = wasm.ccall('wp_nt', 'number', ['number'], [ds]);
        const actualT1 = Math.min(t1, nt - 1);
        const actualT2 = Math.min(t2 ?? nt - 1, nt - 1);

        // Nearest-neighbor lookup
        let latIdx = -1, lonIdx = -1;
        if (lat !== undefined) {
          latIdx = wasm.ccall('wp_find_nearest_lat', 'number', ['number', 'number'], [ds, lat]);
        }
        if (lon !== undefined) {
          lonIdx = wasm.ccall('wp_find_nearest_lon', 'number', ['number', 'number'], [ds, lon]);
        }

        const resultPtr: number = wasm.ccall('wp_query', 'number',
          ['number', 'number', 'number', 'number', 'number'],
          [ds, actualT1, actualT2, latIdx, lonIdx]);

        if (resultPtr !== 0) {
          const json = wasm.UTF8ToString(resultPtr);
          wasm.ccall('wp_free', null, ['number'], [resultPtr]);
          results.push(JSON.parse(json));
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
   * close — free all WASM resources
   * --------------------------------------------------------------------- */
  close(): void {
    this._freeScan();
    this.wasm = null;
  }

  /* =========================================================================
   * Private helpers
   * ======================================================================= */

  private async _toUint8Array(
    source: File | string | URL | ArrayBuffer | Uint8Array
  ): Promise<Uint8Array> {
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (source instanceof File) return new Uint8Array(await source.arrayBuffer());

    // string or URL — fetch
    const url = source instanceof URL ? source.href : source;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.statusText}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  private _detectFormat(source: any, data: Uint8Array): string {
    // Check GRIB2 magic bytes: 0x47 0x52 0x49 0x42 ('GRIB')
    if (data.length >= 4 &&
        data[0] === 0x47 && data[1] === 0x52 &&
        data[2] === 0x49 && data[3] === 0x42) {
      return 'grib2';
    }
    // Fallback: check file extension
    const name = (source instanceof File)   ? source.name
               : (typeof source === 'string') ? source
               : (source instanceof URL)      ? source.pathname
               : '';
    if (/\.(grb2?|grib2?)$/i.test(name)) return 'grib2';
    throw new Error('Cannot detect file format. Supported: GRIB2 (.grb2, .grib2)');
  }

  private async _scanGrib2(data: Uint8Array): Promise<void> {
    const wasm = this.wasm!;

    // Copy data into WASM heap in 64KB chunks
    const ptr: number = wasm.ccall('wp_malloc', 'number', ['number'], [data.length]);
    if (ptr === 0) throw new Error('WASM out of memory');

    const CHUNK = 65536;
    for (let off = 0; off < data.length; off += CHUNK) {
      const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
      wasm.ccall('wp_memcpy', null, ['number', 'array', 'number'], [ptr + off, slice, slice.length]);
    }

    this.scanPtr = wasm.ccall('wp_scan', 'number', ['number', 'number'], [ptr, data.length]);
    wasm.ccall('wp_free', null, ['number'], [ptr]);

    if (this.scanPtr === 0) throw new Error('Failed to parse GRIB2 file');

    // Parse variable list
    const varsJsonPtr: number = wasm.ccall('wp_scan_get_vars_json', 'number',
      ['number'], [this.scanPtr]);
    const varsJson = wasm.UTF8ToString(varsJsonPtr);
    wasm.ccall('wp_free', null, ['number'], [varsJsonPtr]);

    this.vars = JSON.parse(varsJson);
  }

  private _freeScan(): void {
    if (this.scanPtr && this.wasm) {
      this.wasm.ccall('wp_scan_free', null, ['number'], [this.scanPtr]);
      this.scanPtr = 0;
      this.vars = [];
    }
  }

  private _requireScan(): void {
    if (!this.scanPtr) throw new Error('No file loaded. Call read() first.');
  }

  private _toCSV(data: any): string {
    const items: any[] = data.variables ?? [data];
    const rows: string[] = [];

    for (const item of items) {
      const varName = item.variable ?? 'value';
      if (item.timeseries) {
        if (rows.length === 0) rows.push('variable,time,value,lat,lon');
        const lat = item.location?.lat ?? '';
        const lon = item.location?.lon ?? '';
        for (const pt of item.timeseries) {
          rows.push(`${varName},${pt.time},${pt.value},${lat},${lon}`);
        }
      } else if (item.value !== undefined) {
        if (rows.length === 0) rows.push('variable,time,value,lat,lon');
        const lat = item.location?.lat ?? '';
        const lon = item.location?.lon ?? '';
        rows.push(`${varName},${item.time ?? ''},${item.value},${lat},${lon}`);
      }
    }

    return rows.join('\n');
  }

  private _toGeoJSON(data: any): object {
    const items: any[] = data.variables ?? [data];
    const features: any[] = [];

    for (const item of items) {
      const lat = item.location?.lat;
      const lon = item.location?.lon;
      features.push({
        type: 'Feature',
        geometry: (lat !== undefined && lon !== undefined)
          ? { type: 'Point', coordinates: [lon, lat] }
          : null,
        properties: {
          variable:   item.variable ?? null,
          timeseries: item.timeseries ?? null,
          value:      item.value ?? null,
          time:       item.time ?? null,
        },
      });
    }

    return { type: 'FeatureCollection', features };
  }
}
