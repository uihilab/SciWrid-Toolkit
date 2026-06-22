/*
 * worker/worker.js  --  pure-JS nearest-neighbor query worker
 *
 * Receives a one-time `init` message containing the dataset's lats/lons coord
 * arrays and a flattened single-time-slice data buffer, then handles repeated
 * `chunk` messages that ask for a row band of an output grid. Each chunk is
 * resolved by binary-search nearest-neighbor lookup against the coord arrays.
 *
 * No WebAssembly is loaded here. The main thread did the WASM parse once and
 * shipped the decoded arrays via Transferable ArrayBuffers; this worker is
 * therefore lightweight (no heap, no init cost beyond message handling).
 *
 * Runtime shim: works in browsers (Web Workers) and Node 18+ (worker_threads).
 *
 * Message protocol:
 *   init    {type:'init', lats:ArrayBuffer, lons:ArrayBuffer, data:ArrayBuffer,
 *            ny, nx, latsAscending, lonsAscending, lonRange:[min,max],
 *            bbox:[minLon,minLat,maxLon,maxLat], width, height}
 *   chunk   {type:'chunk', id, y0, y1}
 *   chunkDone {type:'chunkDone', id, y0, y1, values:ArrayBuffer (Float32)}
 *   chunkError {type:'chunkError', id, message}
 *   ready   {type:'ready'}                       (worker → main after init)
 *   close   {type:'close'}                       (main → worker)
 */

/* ------------------------------------------------------------------ */
/* Cross-runtime shim: browser Worker vs Node worker_threads          */
/* Detection: Node has `process.versions.node`; browsers do not.       */
/* ------------------------------------------------------------------ */
import { isOutsideCoverage, isOutsideLonRange } from './sample.js';

const _isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

let _post, _onMessage;
if (_isNode) {
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('worker.js loaded outside of a worker context');
  _post = (msg, transfer) => parentPort.postMessage(msg, transfer || []);
  _onMessage = (fn) => { parentPort.on('message', fn); };
} else {
  /* Browser / Web Worker */
  _post = (msg, transfer) => self.postMessage(msg, transfer || []);
  _onMessage = (fn) => { self.onmessage = (e) => fn(e.data); };
}

/* ------------------------------------------------------------------ */
/* Worker state set on `init`                                         */
/* ------------------------------------------------------------------ */
let state = null;

/* ------------------------------------------------------------------ */
/* nearestIdx — binary search the nearest index in a sorted 1-D array */
/* ------------------------------------------------------------------ */
function nearestIdx(coords, target, ascending) {
  const n = coords.length;
  if (n === 1) return 0;
  const first = coords[0];
  const last  = coords[n - 1];
  if (ascending) {
    if (target <= first) return 0;
    if (target >= last)  return n - 1;
  } else {
    if (target >= first) return 0;
    if (target <= last)  return n - 1;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const v = coords[mid];
    if ((ascending && v < target) || (!ascending && v > target)) lo = mid;
    else hi = mid;
  }
  return Math.abs(coords[lo] - target) <= Math.abs(coords[hi] - target) ? lo : hi;
}

/* Normalize a query longitude into the dataset's lon range.
 * If dataset uses [0, 360] and query is -74, return 286. And vice-versa. */
function normalizeLon(lon, lonRange) {
  const [min, max] = lonRange;
  if (lon >= min && lon <= max) return lon;
  /* Try wrapping by ±360 */
  if (lon + 360 >= min && lon + 360 <= max) return lon + 360;
  if (lon - 360 >= min && lon - 360 <= max) return lon - 360;
  /* Out of range entirely — return as-is, nearestIdx clamps to ends */
  return lon;
}

/* ------------------------------------------------------------------ */
/* Handle `chunk`: compute row band y in [y0, y1) of the output grid  */
/* ------------------------------------------------------------------ */
function handleChunk(msg) {
  const { id, y0, y1 } = msg;
  const { lats, lons, data, ny, nx, latsAscending, lonsAscending,
          lonRange, bbox, width, height } = state;

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dx = (maxLon - minLon) / width;
  const dy = (maxLat - minLat) / height;

  const rows = y1 - y0;
  const out = new Float32Array(rows * width);

  for (let y = y0; y < y1; y++) {
    /* Row 0 is at maxLat (north-up) */
    const lat = maxLat - (y + 0.5) * dy;
    const latOutside = isOutsideCoverage(lats, lat);
    const iy = latOutside ? -1 : nearestIdx(lats, lat, latsAscending);
    const rowBase = iy * nx;
    const outRowBase = (y - y0) * width;
    for (let x = 0; x < width; x++) {
      const lon = normalizeLon(minLon + (x + 0.5) * dx, lonRange);
      if (latOutside || isOutsideLonRange(lon, lonRange) || isOutsideCoverage(lons, lon)) {
        out[outRowBase + x] = NaN;
        continue;
      }
      const ix = nearestIdx(lons, lon, lonsAscending);
      out[outRowBase + x] = data[rowBase + ix];
    }
  }

  _post(
    { type: 'chunkDone', id, y0, y1, values: out.buffer },
    [out.buffer],
  );
}

/* ------------------------------------------------------------------ */
/* Message dispatcher                                                 */
/* ------------------------------------------------------------------ */
_onMessage((msg) => {
  try {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init': {
        state = {
          lats:           new Float32Array(msg.lats),
          lons:           new Float32Array(msg.lons),
          data:           new Float32Array(msg.data),
          ny:             msg.ny,
          nx:             msg.nx,
          latsAscending:  !!msg.latsAscending,
          lonsAscending:  !!msg.lonsAscending,
          lonRange:       msg.lonRange,
          bbox:           msg.bbox,
          width:          msg.width,
          height:         msg.height,
        };
        _post({ type: 'ready' });
        break;
      }
      case 'chunk': {
        if (!state) throw new Error('chunk received before init');
        handleChunk(msg);
        break;
      }
      case 'close': {
        state = null;
        /* In Node, exiting the worker_threads worker requires a process.exit;
         * but the parent's terminate() handles that. We just clear state. */
        break;
      }
      default:
        break;
    }
  } catch (e) {
    _post({
      type: 'chunkError',
      id: msg && msg.id,
      message: (e && e.message) ? e.message : String(e),
    });
  }
});
