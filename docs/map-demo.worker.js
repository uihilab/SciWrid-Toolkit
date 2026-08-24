// examples/map-demo.worker.js — offload extractGrid + gridToImageData.
//
// Missing message `type` preserves the original one-frame protocol. Animation
// requests decode every selected timestep once, lock one global colour range,
// and transfer ImageBitmaps rather than raw grids to keep playback off the main
// thread.

import { extractGrid, gridToImageData } from 'https://cdn.jsdelivr.net/gh/uihilab/SciWrid-Toolkit@main/dist/index.js';
import { autoRange } from 'https://cdn.jsdelivr.net/gh/uihilab/SciWrid-Toolkit@main/dist/index.js';
import { mercatorWarpGrid } from './map-demo-bbox.js';

let animCancelled = null;

function cancelled(requestId) {
  return animCancelled === requestId;
}

async function renderAnimation({ requestId, source, variable, bbox, width, height, ramp, times }) {
  animCancelled = null;
  const frames = new Array(times.length);
  const ranges = new Array(times.length);
  const bitmaps = [];

  for (let i = 0; i < times.length; i++) {
    if (cancelled(requestId)) {
      self.postMessage({ requestId, type: 'anim-cancelled' });
      return;
    }
    const grid = await extractGrid(source, {
      variable, bbox, width, height, workers: 0, time: times[i],
    });
    const warped = mercatorWarpGrid(grid);
    frames[i] = warped;
    ranges[i] = autoRange(warped.data);
    self.postMessage({ requestId, type: 'anim-progress', done: i + 1, total: times.length });
  }

  let vmin = Infinity, vmax = -Infinity;
  for (const range of ranges) {
    if (!range) continue;
    if (range.vmin < vmin) vmin = range.vmin;
    if (range.vmax > vmax) vmax = range.vmax;
  }
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax))
    throw new Error('All animation frames contain only non-finite values');

  for (let i = 0; i < frames.length; i++) {
    if (cancelled(requestId)) {
      for (const bitmap of bitmaps) bitmap.close();
      self.postMessage({ requestId, type: 'anim-cancelled' });
      return;
    }
    const image = gridToImageData(frames[i], { ramp, vmin, vmax });
    frames[i] = null; // release each Float32Array before creating the next RGBA frame
    bitmaps.push(await createImageBitmap(new ImageData(image.data, image.width, image.height)));
  }

  self.postMessage({
    requestId, type: 'anim-done', bitmaps, range: { vmin, vmax }, width, height,
  }, bitmaps);
}

self.onmessage = async (e) => {
  const message = e.data;
  if (message.type === 'anim-cancel') {
    animCancelled = message.requestId;
    return;
  }

  if (message.type === 'anim') {
    try {
      await renderAnimation(message);
    } catch (err) {
      self.postMessage({
        requestId: message.requestId,
        type: 'anim-error',
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }

  const { requestId, source, variable, bbox, width, height, ramp, time } = message;
  try {
    const grid = await extractGrid(source, { variable, bbox, width, height, workers: 0, time });
    // Reproject equirectangular rows → Web-Mercator so the raster lines up with
    // the Mercator basemap (otherwise it drifts poleward at large lat extents).
    const warped = mercatorWarpGrid(grid);
    const range = autoRange(warped.data);
    const image = gridToImageData(warped, { ramp });
    const gridOut = { data: grid.data, width: grid.width, height: grid.height, bbox: grid.bbox };
    self.postMessage({ requestId, image, range, grid: gridOut },
                     [image.data.buffer, grid.data.buffer]);
  } catch (err) {
    self.postMessage({ requestId, error: err && err.message ? err.message : String(err) });
  }
};
