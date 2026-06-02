// lib/render/to-imagedata.js
import { resolveRamp, sampleRamp } from './colorramps.js';
import { autoRange, normalize }    from './normalize.js';

/**
 * Convert an ExtractGridResult to an RGBA image.
 *
 *   gridToImageData(grid, {
 *     ramp: 'viridis',          // built-in name or custom Ramp array
 *     vmin, vmax,                // optional — defaults to autoRange(data)
 *     nodataColor: [0,0,0,0],    // RGBA for NaN cells (default: transparent)
 *   })
 *
 * Returns { width, height, data: Uint8ClampedArray }. In a browser, you can
 * wrap this in `new ImageData(data, width, height)` to feed `putImageData`.
 */
export function gridToImageData(grid, opts = {}) {
  const { data, width, height } = grid;
  const ramp = resolveRamp(opts.ramp ?? 'viridis');
  const nd   = opts.nodataColor ?? [0, 0, 0, 0];
  let vmin = opts.vmin, vmax = opts.vmax;
  if (vmin == null || vmax == null) {
    const r = autoRange(data);
    if (!r) {
      // All non-finite — fill with nodataColor and return
      const out = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        out[i * 4]     = nd[0];
        out[i * 4 + 1] = nd[1];
        out[i * 4 + 2] = nd[2];
        out[i * 4 + 3] = nd[3] ?? 255;
      }
      return { width, height, data: out };
    }
    vmin ??= r.vmin;
    vmax ??= r.vmax;
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const t = normalize(data[i], vmin, vmax);
    if (!Number.isFinite(t)) {
      out[i * 4]     = nd[0];
      out[i * 4 + 1] = nd[1];
      out[i * 4 + 2] = nd[2];
      out[i * 4 + 3] = nd[3] ?? 255;
    } else {
      const [r, g, b] = sampleRamp(ramp, t);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return { width, height, data: out };
}
