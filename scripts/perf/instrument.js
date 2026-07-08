/*
 * scripts/perf/instrument.js — measurement helpers for the perf harness.
 *
 *  - installFetchCounter(): wraps globalThis.fetch to count requests and sum
 *    bytes from Content-Length / Content-Range headers. This is a client-side
 *    cross-check of the server's byte accounting and also works against real
 *    cloud URLs (where we don't control the server).
 *  - rssSampler(): polls process RSS so we can report peak memory of a query.
 *  - timeit(): runs a function with warmups + reps and returns timing stats.
 */

export function installFetchCounter() {
  const original = globalThis.fetch;
  const state = { requests: 0, bytesFromHeaders: 0, byStatus: {} };

  globalThis.fetch = async (...args) => {
    const res = await original(...args);
    state.requests += 1;
    state.byStatus[res.status] = (state.byStatus[res.status] || 0) + 1;
    // Prefer the total entity size from Content-Range; else Content-Length.
    const cr = res.headers.get('content-range');     // "bytes a-b/total"
    const cl = res.headers.get('content-length');
    if (cr) {
      const m = /bytes\s+(\d+)-(\d+)\//.exec(cr);
      if (m) state.bytesFromHeaders += (Number(m[2]) - Number(m[1]) + 1);
      else if (cl) state.bytesFromHeaders += Number(cl);
    } else if (cl) {
      state.bytesFromHeaders += Number(cl);
    }
    return res;
  };

  return {
    state,
    reset() { state.requests = 0; state.bytesFromHeaders = 0; state.byStatus = {}; },
    restore() { globalThis.fetch = original; },
  };
}

/** Poll RSS at `intervalMs`; returns a handle with .stop() → peak bytes. */
export function rssSampler(intervalMs = 15) {
  let peak = process.memoryUsage().rss;
  const id = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, intervalMs);
  if (id.unref) id.unref();
  return { stop() { clearInterval(id); return peak; } };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    reps: sorted.length,
    all: samples,
  };
}

/**
 * Run `fn` (async) `warmup` times unmeasured, then `reps` times measured.
 * `onRep(i)` may reset per-rep counters (called right before each measured rep).
 * Returns { time: {median,min,max,...}, peakRss, lastResult }.
 */
export async function timeit(fn, { reps = 3, warmup = 1, onRep } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  let lastResult;
  const sampler = rssSampler();
  for (let i = 0; i < reps; i++) {
    if (onRep) onRep(i);
    const t0 = performance.now();
    lastResult = await fn();
    samples.push(performance.now() - t0);
  }
  const peakRss = sampler.stop();
  return { time: summarize(samples), peakRss, lastResult };
}

export const fmtBytes = (n) => {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

export const fmtMs = (n) => (n == null ? '–' : n < 1 ? n.toFixed(2) : n.toFixed(n < 100 ? 1 : 0));
