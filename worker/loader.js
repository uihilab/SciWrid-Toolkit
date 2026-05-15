/*
 * worker/loader.js  --  Worker factory + pool for parallel grid extraction
 *
 * Exports:
 *   createWorker()                       — creates one Worker matching the runtime
 *   WorkerPool({size, factory, signal})  — pool of workers with chunk dispatch
 *   inlineExtract(state, onProgress?)    — synchronous fallback (no workers)
 *
 * Browser path:  new Worker(new URL('./worker.js', import.meta.url), {type:'module'})
 * Node path:     dynamic-import node:worker_threads → wrap with browser-shaped API
 *                so the pool code is identical across runtimes.
 *
 * Pool routes incoming messages by chunk id via a single persistent listener
 * per worker — no per-chunk add/remove dance, no listener leaks on Node.
 */

/* ------------------------------------------------------------------ */
/* createWorker                                                        */
/* ------------------------------------------------------------------ */
const _isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

export async function createWorker() {
  const url = new URL('./worker.js', import.meta.url);

  if (_isNode) {
    /* Node 18+ — use worker_threads. Checked first because some Node versions
     * also expose a browser-compatible `Worker` global which doesn't accept
     * file:// URLs the same way. */
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const w = new NodeWorker(url);
    return {
      _kind: 'node',
      _w: w,
      postMessage(msg, transfer) { w.postMessage(msg, transfer || []); },
      onMessage(fn) { w.on('message', fn); },
      onError(fn)   { w.on('error',   fn); },
      terminate() { w.terminate(); },
    };
  }

  if (typeof Worker !== 'undefined') {
    /* Browser */
    const w = new Worker(url, { type: 'module' });
    return {
      _kind: 'browser',
      _w: w,
      postMessage(msg, transfer) { w.postMessage(msg, transfer || []); },
      onMessage(fn) { w.addEventListener('message', (e) => fn(e.data)); },
      onError(fn)   { w.addEventListener('error',   fn); },
      terminate() { w.terminate(); },
    };
  }

  throw new Error('No worker runtime available — use { workers: 0 } for inline extraction.');
}

/* ------------------------------------------------------------------ */
/* WorkerPool                                                          */
/*                                                                     */
/* Lifecycle:                                                          */
/*   const pool = new WorkerPool({ size, factory });                   */
/*   await pool.initAll(i => ({ msg, transfer }));                     */
/*   await Promise.all(chunks.map(c => pool.enqueue(c).then(...)));    */
/*   pool.dispose();                                                   */
/* ------------------------------------------------------------------ */
export class WorkerPool {
  constructor({ size, factory, signal } = {}) {
    this.size      = size;
    this.factory   = factory || createWorker;
    this.signal    = signal || null;

    /* Per-worker entry: { wrapper, busy, retries: Map<id, count>, current?: item } */
    this.workers   = [];
    this.available = [];           /* indices of idle workers (stack) */
    this.queue     = [];           /* pending chunks: { msg, resolve, reject } */

    this._disposed = false;
    this._disposeReason = null;

    if (signal) {
      signal.addEventListener('abort', () => this.dispose(new Error('AbortError')));
    }
  }

  async initAll(buildInitMessage) {
    /* Spawn workers, install single persistent listeners, init each. */
    for (let i = 0; i < this.size; i++) {
      const wrapper = await this.factory();
      const entry = { wrapper, retries: new Map(), current: null, ready: false, readyResolve: null };
      this.workers.push(entry);

      const idx = i;
      wrapper.onMessage((m) => this._onMessage(idx, m));
      wrapper.onError((err) => this._onError(idx, err));
    }

    /* Build ready-promises before posting init so messages can't race. */
    const ready = this.workers.map((entry) => new Promise((resolve) => {
      entry.readyResolve = resolve;
    }));

    for (let i = 0; i < this.workers.length; i++) {
      const { msg, transfer } = buildInitMessage(i);
      this.workers[i].wrapper.postMessage(msg, transfer);
    }
    await Promise.all(ready);
  }

  enqueue(chunkMsg) {
    if (this._disposed)
      return Promise.reject(this._disposeReason || new Error('pool disposed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ msg: chunkMsg, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.available.length > 0 && this.queue.length > 0 && !this._disposed) {
      const workerIdx = this.available.pop();
      const item = this.queue.shift();
      const entry = this.workers[workerIdx];
      entry.current = item;
      entry.wrapper.postMessage(item.msg);
    }
  }

  _onMessage(workerIdx, m) {
    if (!m || typeof m !== 'object') return;
    const entry = this.workers[workerIdx];

    if (m.type === 'ready') {
      entry.ready = true;
      if (entry.readyResolve) {
        entry.readyResolve();
        entry.readyResolve = null;
      }
      this.available.push(workerIdx);
      this._dispatch();
      return;
    }

    const item = entry.current;
    if (!item) return;             /* stale message, no in-flight chunk */
    if (m.id !== item.msg.id) return;

    entry.current = null;

    if (m.type === 'chunkDone') {
      this.available.push(workerIdx);
      item.resolve(m);
      this._dispatch();
      return;
    }

    if (m.type === 'chunkError') {
      const retries = entry.retries.get(item.msg.id) || 0;
      if (retries < 1) {
        entry.retries.set(item.msg.id, retries + 1);
        this.queue.unshift(item);   /* re-queue at front for retry */
        this.available.push(workerIdx);
        this._dispatch();
      } else {
        this.available.push(workerIdx);
        item.reject(new Error(`chunk ${item.msg.id} failed: ${m.message}`));
        this._dispatch();
      }
    }
  }

  _onError(workerIdx, err) {
    /* A worker died. Fail its in-flight chunk; don't try to revive the worker. */
    const entry = this.workers[workerIdx];
    if (entry.current) {
      entry.current.reject(err instanceof Error ? err : new Error(String(err)));
      entry.current = null;
    }
    /* Don't return this worker to available — it's gone. */
  }

  dispose(reason) {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeReason = reason || new Error('pool disposed');

    /* Reject pending */
    for (const item of this.queue) item.reject(this._disposeReason);
    this.queue.length = 0;

    /* Reject in-flight */
    for (const entry of this.workers) {
      if (entry.current) entry.current.reject(this._disposeReason);
      entry.current = null;
    }

    /* Terminate workers */
    for (const entry of this.workers) {
      try { entry.wrapper.terminate(); } catch (_) {}
    }
    this.workers.length = 0;
    this.available.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* inlineExtract — single-threaded fallback                            */
/* ------------------------------------------------------------------ */
export function inlineExtract(state, onProgress) {
  const { lats, lons, data, nx, latsAscending, lonsAscending,
          lonRange, bbox, width, height } = state;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dx = (maxLon - minLon) / width;
  const dy = (maxLat - minLat) / height;

  const out = new Float32Array(width * height);
  const total = width * height;

  function nearest(coords, target, asc) {
    const n = coords.length;
    if (n === 1) return 0;
    if (asc) {
      if (target <= coords[0])   return 0;
      if (target >= coords[n-1]) return n - 1;
    } else {
      if (target >= coords[0])   return 0;
      if (target <= coords[n-1]) return n - 1;
    }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const v = coords[mid];
      if ((asc && v < target) || (!asc && v > target)) lo = mid; else hi = mid;
    }
    return Math.abs(coords[lo] - target) <= Math.abs(coords[hi] - target) ? lo : hi;
  }
  function normLon(lon) {
    const [mn, mx] = lonRange;
    if (lon >= mn && lon <= mx) return lon;
    if (lon + 360 >= mn && lon + 360 <= mx) return lon + 360;
    if (lon - 360 >= mn && lon - 360 <= mx) return lon - 360;
    return lon;
  }

  for (let y = 0; y < height; y++) {
    const lat = maxLat - (y + 0.5) * dy;
    const iy  = nearest(lats, lat, latsAscending);
    const rowBase = iy * nx;
    const outBase = y * width;
    for (let x = 0; x < width; x++) {
      const lon = normLon(minLon + (x + 0.5) * dx);
      const ix  = nearest(lons, lon, lonsAscending);
      out[outBase + x] = data[rowBase + ix];
    }
    if (onProgress) onProgress({ done: (y + 1) * width, total });
  }
  return out;
}
