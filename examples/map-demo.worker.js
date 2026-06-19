// examples/map-demo.worker.js — offload extractGrid + gridToImageData.
//
// A module worker (`new Worker(url, { type: 'module' })`). The main thread
// posts { requestId, source, variable, bbox, width, height, ramp }; this worker
// extracts the grid, colors it, and posts back { requestId, image } where
// image = { width, height, data: Uint8ClampedArray }. The RGBA buffer is
// transferred (zero-copy) back to the main thread.
//
// extractGrid runs inline here (workers: 0) — this worker is already off the
// main thread, and inline avoids relying on nested-worker support.

import { extractGrid, gridToImageData } from '../index.js';
import { autoRange } from '../lib/render/index.js';
import { mercatorWarpGrid } from './map-demo-bbox.js';

self.onmessage = async (e) => {
  const { requestId, source, variable, bbox, width, height, ramp, time } = e.data;
  try {
    const grid = await extractGrid(source, { variable, bbox, width, height, workers: 0, time });
    // Reproject equirectangular rows → Web-Mercator so the raster lines up with
    // the Mercator basemap (otherwise it drifts poleward at large lat extents).
    const warped = mercatorWarpGrid(grid);
    const range = autoRange(warped.data);
    const image = gridToImageData(warped, { ramp });
    self.postMessage({ requestId, image, range }, [image.data.buffer]);
  } catch (err) {
    self.postMessage({ requestId, error: err && err.message ? err.message : String(err) });
  }
};
