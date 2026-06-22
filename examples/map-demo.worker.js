// examples/map-demo.worker.js - offload extractGrid + gridToImageData.
//
// A module worker (`new Worker(url, { type: 'module' })`). The main thread
// posts { requestId, source, variable, bbox, width, height, ramp }; this worker
// extracts the grid, colors it, and posts back { requestId, image } where
// image = { width, height, data: Uint8ClampedArray }. The RGBA buffer is
// transferred back to the main thread.
//
// extractGrid runs inline here (workers: 0). This worker is already off the
// main thread, and inline avoids relying on nested-worker support.

import { extractGrid, gridToImageData } from '../index.js';
import { autoRange } from '../lib/render/index.js';
import { mercatorWarpGrid } from './map-demo-bbox.js';

self.onmessage = async (e) => {
  const { requestId, source, variable, bbox, width, height, ramp, time } = e.data;
  const timestamp = new Date().toISOString();
  const perfStart = performance.now();
  const wallStart = Date.now();
  const phases = {};
  let phase = 'extractGrid';
  let phaseStart = perfStart;

  const mark = (name) => {
    const now = performance.now();
    phases[phase] = (phases[phase] || 0) + (now - phaseStart);
    phase = name;
    phaseStart = now;
  };

  const finishPerf = (extra = {}) => {
    const now = performance.now();
    phases[phase] = (phases[phase] || 0) + (now - phaseStart);
    return {
      file: source?.name,
      bytes: source?.size ?? source?.byteLength ?? 0,
      variable,
      width,
      height,
      time,
      timestamp,
      perfMs: now - perfStart,
      wallMs: Date.now() - wallStart,
      phases,
      ...extra,
    };
  };

  try {
    const grid = await extractGrid(source, { variable, bbox, width, height, workers: 0, time });
    mark('warp');
    const warped = mercatorWarpGrid(grid);
    mark('range');
    const range = autoRange(warped.data);
    mark('image');
    const image = gridToImageData(warped, { ramp });
    mark('postMessage');
    const perf = finishPerf();
    self.postMessage({ requestId, image, range, perf }, [image.data.buffer]);
  } catch (err) {
    const perf = finishPerf({ error: err && err.message ? err.message : String(err) });
    self.postMessage({ requestId, error: perf.error, perf });
  }
};
