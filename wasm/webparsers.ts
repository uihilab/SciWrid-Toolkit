/**
 * webparsers.ts  --  TypeScript wrapper around the WASM module
 *
 * Usage:
 *   const wp = await WebParsersLib.create();
 *   const ds = await wp.open('data/temperature.refs.json', 'data/temperature.bin');
 *   console.log(ds.variable, ds.nx, ds.ny, ds.nt, ds.isTimeseries);
 *   const result = ds.query({ t1: 0, t2: 3, lat: 40.7, lon: -74.0 });
 *   console.log(JSON.parse(result));
 *   ds.close();
 */

interface WasmModule {
  ccall: (name: string, returnType: string | null, argTypes: string[], args: any[]) => any;
  cwrap: (name: string, returnType: string | null, argTypes: string[]) => (...args: any[]) => any;
  UTF8ToString: (ptr: number) => string;
  stringToUTF8: (str: string, ptr: number, maxBytes: number) => void;
  lengthBytesUTF8: (str: string) => number;
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
}

declare function WebParsers(): Promise<WasmModule>;

export interface QueryOptions {
  t1?: number;        // start time index (default 0)
  t2?: number;        // end time index (default last)
  lat?: number;       // latitude (nearest neighbor lookup, default all)
  lon?: number;       // longitude (nearest neighbor lookup, default all)
  latIdx?: number;    // direct lat index (skip lookup)
  lonIdx?: number;    // direct lon index (skip lookup)
}

export interface DatasetHandle {
  variable: string;
  nx: number;
  ny: number;
  nt: number;
  isTimeseries: boolean;
  query: (opts?: QueryOptions) => any;
  close: () => void;
}

export class WebParsersLib {
  private wasm: WasmModule;

  private constructor(wasm: WasmModule) {
    this.wasm = wasm;
  }

  /** Initialize the WASM module */
  static async create(): Promise<WebParsersLib> {
    const wasm = await WebParsers();
    return new WebParsersLib(wasm);
  }

  /** Open a dataset from URLs to .refs.json and .bin files */
  async open(refsUrl: string, binUrl: string): Promise<DatasetHandle> {
    const [jsonText, binBuf] = await Promise.all([
      fetch(refsUrl).then(r => r.text()),
      fetch(binUrl).then(r => r.arrayBuffer())
    ]);

    return this.openFromBuffers(jsonText, new Uint8Array(binBuf));
  }

  /** Open a dataset from in-memory buffers */
  openFromBuffers(jsonStr: string, binData: Uint8Array): DatasetHandle {
    const wasm = this.wasm;

    // Allocate and copy JSON string into WASM memory
    const jsonLen = wasm.lengthBytesUTF8(jsonStr);
    const jsonPtr = wasm._malloc(jsonLen + 1);
    wasm.stringToUTF8(jsonStr, jsonPtr, jsonLen + 1);

    // Allocate and copy bin data into WASM memory
    const binPtr = wasm._malloc(binData.length);
    wasm.HEAPU8.set(binData, binPtr);

    // Call wp_open
    const dsPtr = wasm.ccall('wp_open', 'number',
      ['number', 'number', 'number', 'number'],
      [jsonPtr, jsonLen, binPtr, binData.length]);

    // Free the JSON copy (bin must stay alive while ds is open)
    wasm._free(jsonPtr);

    if (dsPtr === 0) {
      wasm._free(binPtr);
      throw new Error('Failed to open dataset — check console for validation errors');
    }

    // Read metadata
    const variable = wasm.UTF8ToString(
      wasm.ccall('wp_variable_name', 'number', ['number'], [dsPtr])
    );
    const nx = wasm.ccall('wp_nx', 'number', ['number'], [dsPtr]) as number;
    const ny = wasm.ccall('wp_ny', 'number', ['number'], [dsPtr]) as number;
    const nt = wasm.ccall('wp_nt', 'number', ['number'], [dsPtr]) as number;
    const isTimeseries = wasm.ccall('wp_is_timeseries', 'number', ['number'], [dsPtr]) !== 0;

    const self = this;

    return {
      variable,
      nx, ny, nt,
      isTimeseries,

      query(opts: QueryOptions = {}): any {
        const t1 = opts.t1 ?? 0;
        const t2 = opts.t2 ?? (nt - 1);

        let latIdx: number = opts.latIdx ?? -1;
        let lonIdx: number = opts.lonIdx ?? -1;

        // If lat/lon provided, do nearest-neighbor lookup
        if (opts.lat !== undefined && latIdx < 0) {
          latIdx = wasm.ccall('wp_find_nearest_lat', 'number',
            ['number', 'number'], [dsPtr, opts.lat]) as number;
        }
        if (opts.lon !== undefined && lonIdx < 0) {
          lonIdx = wasm.ccall('wp_find_nearest_lon', 'number',
            ['number', 'number'], [dsPtr, opts.lon]) as number;
        }

        const resultPtr = wasm.ccall('wp_query', 'number',
          ['number', 'number', 'number', 'number', 'number'],
          [dsPtr, t1, t2, latIdx, lonIdx]);

        if (resultPtr === 0) {
          throw new Error('Query failed');
        }

        const jsonResult = wasm.UTF8ToString(resultPtr);
        wasm.ccall('wp_free', null, ['number'], [resultPtr]);

        return JSON.parse(jsonResult);
      },

      close() {
        wasm.ccall('wp_close', null, ['number'], [dsPtr]);
        wasm._free(binPtr);
      }
    };
  }
}
