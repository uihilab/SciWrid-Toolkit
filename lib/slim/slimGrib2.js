/*
 * lib/slim/grib2.js
 *
 * GRIB2 slim — message-stream byte-cut. No decode.
 *
 * Pipeline:
 *   1. Pull the full source into a Uint8Array (slim has to address every
 *      kept byte; for streaming-Range we'd buffer the same data anyway).
 *   2. Run wp_scan() + wp_scan_messages_layout() to get a JSON index of
 *      every GRIB2 message: {start, len, name, valid_time, supported}.
 *   3. Filter the index by opts.variables (set membership) and, if
 *      opts.t1/t2 given, by per-variable time-axis position (messages of
 *      the same variable are sorted by valid_time; index → t).
 *   4. Concatenate the kept byte spans verbatim — bit-identical message
 *      bodies — into the output buffer.
 *
 * GRIB2 messages are self-contained framed records:
 *     "GRIB" [reserved][discipline][edition][total_len:uint64]  ← Section 0 (16B)
 *     ...sections 1..7...
 *     "7777"                                                     ← Section 8 (4B)
 * so concatenating any subset produces a valid GRIB2 stream.
 */

import { SlimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';
import WebParsers from '../../wasm/webparsers.js';

const CHUNK = 65536;

async function loadAll(byteSource) {
  const size = await byteSource.size();
  return byteSource.read(0, size);
}

function copyIntoWasm(wasm, data) {
  const ptr = wasm.ccall('wp_malloc', 'number', ['number'], [data.length]);
  if (ptr === 0) throw new SlimError('GRIB2 slim: WASM out of memory');
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
    wasm.ccall('wp_memcpy', null,
      ['number', 'array', 'number'],
      [ptr + off, slice, slice.length]);
  }
  return ptr;
}

/**
 * @param {object} byteSource          byte-source (lib/slim/byte-source.js)
 * @param {object} opts                { variables, t1?, t2? }
 * @param {object} ctx                 { format, inputSize, wasmFactory? }
 * @returns {{bytes:Uint8Array, warnings:string[], variablesKept:number, variablesDropped:number}}
 */
export async function slim(byteSource, opts, ctx) {
  const data    = await loadAll(byteSource);
  const factory = opts.wasmFactory || ctx?.wasmFactory || WebParsers;
  const wasm    = await factory();

  const inPtr = copyIntoWasm(wasm, data);
  let scanPtr = 0;
  try {
    scanPtr = wasm.ccall('wp_scan', 'number', ['number', 'number'],
                         [inPtr, data.length]);
    wasm.ccall('wp_free', null, ['number'], [inPtr]);
    if (scanPtr === 0)
      throw new SlimError('GRIB2 slim: wp_scan failed (malformed file?)');

    const jsonPtr = wasm.ccall('wp_scan_messages_layout', 'number',
                               ['number'], [scanPtr]);
    if (jsonPtr === 0)
      throw new SlimError('GRIB2 slim: wp_scan_messages_layout returned NULL');
    const json = wasm.UTF8ToString(jsonPtr);
    wasm.ccall('wp_free', null, ['number'], [jsonPtr]);

    /** @type {Array<{index:number,start:number,len:number,name:string,
     *               cat:number,num:number,grid_template:number,
     *               valid_time:number,supported:boolean}>} */
    const messages = JSON.parse(json);

    return assembleSlim(data, messages, opts);
  } finally {
    if (scanPtr) {
      try { wasm.ccall('wp_scan_free', null, ['number'], [scanPtr]); }
      catch (_) {}
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Slim assembly: pure filter + concat over the parsed message index.     */
/* Pulled out for direct unit-testability without spinning up WASM.       */
/* ---------------------------------------------------------------------- */
export function assembleSlim(data, messages, opts) {
  const requested = new Set(opts.variables);
  const availableNames = new Set(messages.map(m => m.name));

  /* Surface unknown variable names eagerly (consistent with extract()). */
  const missing = opts.variables.filter(v => !availableNames.has(v));
  if (missing.length === opts.variables.length)
    throw new VariableNotFoundError(
      `GRIB2 slim: none of the requested variables are present in the file ` +
      `(requested: ${opts.variables.join(', ')}; ` +
      `available: ${[...availableNames].join(', ')})`);
  if (missing.length > 0)
    throw new VariableNotFoundError(
      `GRIB2 slim: variable(s) not found in file: ${missing.join(', ')}`);

  /* Group kept messages by variable, sort each by valid_time so we can
   * resolve opts.t1/t2 as time-axis indices (matching extract()'s ordering). */
  const byVar = new Map();
  for (const m of messages) {
    if (!requested.has(m.name)) continue;
    if (!byVar.has(m.name)) byVar.set(m.name, []);
    byVar.get(m.name).push(m);
  }
  for (const arr of byVar.values())
    arr.sort((a, b) => a.valid_time - b.valid_time);

  /* Apply optional time-axis slice per variable. */
  const t1 = opts.t1 ?? 0;
  const haveT = opts.t1 != null || opts.t2 != null;
  const kept  = [];
  const warnings = [];

  for (const [name, arr] of byVar.entries()) {
    const t2 = opts.t2 != null ? opts.t2 : arr.length - 1;
    if (haveT) {
      if (t1 >= arr.length)
        throw new SlimError(
          `GRIB2 slim: t1=${t1} >= number of timesteps (${arr.length}) ` +
          `for variable '${name}'`);
      const lo = Math.max(0, t1);
      const hi = Math.min(arr.length - 1, t2);
      for (let i = lo; i <= hi; i++) kept.push(arr[i]);
      if (lo > 0 || hi < arr.length - 1)
        warnings.push(
          `GRIB2 variable '${name}': kept timesteps ${lo}..${hi} of ` +
          `${arr.length} available`);
    } else {
      for (const m of arr) kept.push(m);
    }
  }

  /* Preserve original message order in the output stream (concat by
   * ascending start offset — keeps the file well-formed for tools that
   * assume forward-only parsing). */
  kept.sort((a, b) => a.start - b.start);

  let outLen = 0;
  for (const m of kept) outLen += m.len;
  const out = new Uint8Array(outLen);
  let off = 0;
  for (const m of kept) {
    out.set(data.subarray(m.start, m.start + m.len), off);
    off += m.len;
  }

  const variablesKept    = byVar.size;
  const variablesDropped =
    new Set(messages.map(m => m.name)).size - variablesKept;

  return { bytes: out, warnings, variablesKept, variablesDropped };
}
