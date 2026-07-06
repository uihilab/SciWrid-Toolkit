/*
 * lib/grib2/grib2-range.js
 * Range-native GRIB2 point extraction. Index the messages, resolve the variable
 * to (cat,num), select the matching messages in the requested time window (in
 * FILE order — matching the whole-file wp_normalize path and the oracle), then
 * stream them one at a time through the existing WASM decode — never holding the
 * whole file. Returns the same shape as extract(), or null to fall back.
 */
import SciWridWasm from '../../wasm/sciwrid.js';
import { GrbRangeReader } from './grb-range-reader.js';
import { indexMessages } from './grib2-index.js';

let _wasmPromise = null;
function getWasm() { return (_wasmPromise ||= SciWridWasm()); }

/* Copy bytes into the WASM heap; caller frees the returned ptr after wp_scan
 * (wp_scan makes its own copy). */
function toHeap(wasm, bytes) {
  const ptr = wasm.ccall('wp_malloc', 'number', ['number'], [bytes.length]);
  wasm.HEAPU8.set(bytes, ptr);
  return ptr;
}

/* Scan a single-message buffer → scan pointer (or 0). Frees the input buffer. */
function scanOne(wasm, bytes) {
  const ptr = toHeap(wasm, bytes);
  const scan = wasm.ccall('wp_scan', 'number', ['number', 'number'], [ptr, bytes.length]);
  wasm.ccall('wp_free', null, ['number'], [ptr]);        // wp_scan copied it
  return scan;
}

function varsOf(wasm, scan) {
  const jp = wasm.ccall('wp_scan_get_vars_json', 'number', ['number'], [scan]);
  return JSON.parse(wasm.UTF8ToString(jp));               // [{index,name,cat,num,supported,...}]
}

function isoUtc(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace('.000Z', 'Z');
}

export async function grib2RangePointExtract(url, query, opts = {}) {
  try {
    const { variable, lat, lon, t1, t2 } = query;
    if (variable == null || lat == null || lon == null) return null;

    const reader = new GrbRangeReader(url, { fetchImpl: opts.fetchImpl });
    const magic = await reader.read(0, 8);                 // range-safe format check
    if (!(magic[0] === 0x47 && magic[1] === 0x52 && magic[2] === 0x49 && magic[3] === 0x42) || magic[7] !== 2)
      return null;

    const { messages } = await indexMessages(reader);
    if (messages.length === 0) return null;

    const wasm = await getWasm();

    // Resolve variable name -> (cat,num) by scanning a representative message per
    // distinct (cat,num) until the name matches.
    let target = null;
    const seen = new Set();
    for (const m of messages) {
      const key = `${m.cat}:${m.num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scan = scanOne(wasm, await reader.read(m.offset, m.length));
      if (!scan) continue;
      const hit = varsOf(wasm, scan).find(v => v.name === variable);
      wasm.ccall('wp_scan_free', null, ['number'], [scan]);
      if (hit) { target = { cat: m.cat, num: m.num }; break; }
    }
    if (!target) return null;

    // Selected messages in FILE order (matches whole-file wp_normalize sel order),
    // then the time-index window.
    let sel = messages.filter(m => m.cat === target.cat && m.num === target.num);
    const lo = Math.max(0, t1 ?? 0);
    const hi = Math.min(sel.length - 1, t2 ?? sel.length - 1);
    sel = sel.slice(lo, hi + 1);
    if (sel.length === 0) return null;

    // Nearest cell from the first selected message's grid (Section 3), once.
    let iy = -1, ix = -1;
    {
      const scan = scanOne(wasm, await reader.read(sel[0].offset, sel[0].length));
      if (!scan) return null;
      const vi = varsOf(wasm, scan).find(v => v.name === variable);
      const meta = wasm.ccall('wp_grid_coords', 'number', ['number', 'number'], [scan, vi.index]);
      if (!meta) { wasm.ccall('wp_scan_free', null, ['number'], [scan]); return null; }
      if (wasm.ccall('wp_is_curvilinear', 'number', ['number'], [meta])) {
        const nx = wasm.ccall('wp_nx', 'number', ['number'], [meta]);
        const flat = wasm.ccall('wp_find_nearest_cell', 'number',
          ['number', 'number', 'number'], [meta, lat, lon]);
        iy = Math.floor(flat / nx); ix = flat % nx;
      } else {
        iy = wasm.ccall('wp_find_nearest_lat', 'number', ['number', 'number'], [meta, lat]);
        ix = wasm.ccall('wp_find_nearest_lon', 'number', ['number', 'number'], [meta, lon]);
      }
      wasm.ccall('wp_close', null, ['number'], [meta]);
      wasm.ccall('wp_scan_free', null, ['number'], [scan]);
    }

    // Stream each selected message: decode -> pull the cell -> discard.
    const timeseries = [];
    for (const m of sel) {
      const scan = scanOne(wasm, await reader.read(m.offset, m.length));
      if (!scan) continue;
      const vi = varsOf(wasm, scan).find(v => v.name === variable) ?? { index: 0 };
      const ds = wasm.ccall('wp_normalize_range', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number'],
        [scan, vi.index, 0, 0, iy, ix]);
      if (ds) {
        const rp = wasm.ccall('wp_query', 'number',
          ['number', 'number', 'number', 'number', 'number'], [ds, 0, 0, 0, 0]);
        if (rp !== 0) {
          const out = JSON.parse(wasm.UTF8ToString(rp));
          wasm.ccall('wp_free', null, ['number'], [rp]);
          const v = out.timeseries && out.timeseries[0] ? out.timeseries[0].value : null;
          timeseries.push({ time: isoUtc(m.time), value: v });
        }
        wasm.ccall('wp_close', null, ['number'], [ds]);
      }
      wasm.ccall('wp_scan_free', null, ['number'], [scan]);
    }

    return { variable, location: { lat, lon }, timeseries, _stats: reader.stats() };
  } catch (_) { return null; }
}
