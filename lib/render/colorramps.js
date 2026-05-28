/**
 * colorramps.js — color-ramp registry for grid rendering.
 *
 * A ramp is an array of stops, each `[t, [r, g, b]]` where `t ∈ [0, 1]` and
 * `r,g,b` are 0..255 ints. Interpolation is linear in RGB (sRGB-naive — good
 * enough for v1; perceptual interpolation through LAB is a follow-up).
 *
 *   type Stop = [number, [number, number, number]];
 *   type Ramp = Stop[];
 *
 * Built-ins use the canonical Matplotlib / ColorBrewer stops. The data is
 * small (~9 stops per ramp).
 */

/** Built-in ramps. Each is a 9-stop array (grayscale is the trivial 2-stop). */
export const RAMPS = {
  // Matplotlib viridis (perceptually uniform, sequential)
  viridis: [
    [0.0,   [68, 1, 84]],   [0.125, [72, 40, 120]],  [0.25,  [62, 73, 137]],
    [0.375, [49, 104, 142]], [0.5,   [38, 130, 142]], [0.625, [31, 158, 137]],
    [0.75,  [53, 183, 121]], [0.875, [110, 206, 88]], [1.0,   [253, 231, 37]],
  ],
  // Matplotlib plasma (perceptually uniform, sequential)
  plasma: [
    [0.0,   [13, 8, 135]],   [0.125, [75, 3, 161]],   [0.25,  [125, 3, 168]],
    [0.375, [168, 34, 150]], [0.5,   [203, 70, 121]], [0.625, [229, 107, 93]],
    [0.75,  [248, 148, 65]], [0.875, [253, 195, 40]], [1.0,   [240, 249, 33]],
  ],
  // Simple linear grayscale
  grayscale: [
    [0.0, [0, 0, 0]],
    [1.0, [255, 255, 255]],
  ],
  // ColorBrewer RdBu (diverging — anomalies / temperatures). Red at 0,
  // white at the 0.5 midpoint, blue at 1.
  RdBu: [
    [0.0,   [103, 0, 31]],   [0.125, [178, 24, 43]],  [0.25,  [214, 96, 77]],
    [0.375, [244, 165, 130]], [0.5,   [247, 247, 247]], [0.625, [146, 197, 222]],
    [0.75,  [67, 147, 195]], [0.875, [33, 102, 172]], [1.0,   [5, 48, 97]],
  ],
};

/** Returns [r, g, b] (0..255 ints) for t ∈ [0, 1]. NaN → black. */
export function sampleRamp(ramp, t) {
  if (!Number.isFinite(t)) return [0, 0, 0]; // NaN → black
  if (t <= ramp[0][0]) return ramp[0][1];
  if (t >= ramp[ramp.length - 1][0]) return ramp[ramp.length - 1][1];
  // Binary search for the bracketing stops
  let lo = 0, hi = ramp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ramp[mid][0] <= t) lo = mid; else hi = mid;
  }
  const [t0, c0] = ramp[lo], [t1, c1] = ramp[hi];
  const a = (t - t0) / (t1 - t0);
  return [
    Math.round(c0[0] + a * (c1[0] - c0[0])),
    Math.round(c0[1] + a * (c1[1] - c0[1])),
    Math.round(c0[2] + a * (c1[2] - c0[2])),
  ];
}

/** Resolve a `ramp` arg (built-in name or custom stop array) to a Ramp. */
export function resolveRamp(ramp) {
  if (typeof ramp === 'string') {
    if (!RAMPS[ramp])
      throw new Error(`Unknown ramp "${ramp}". Built-ins: ${Object.keys(RAMPS).join(', ')}`);
    return RAMPS[ramp];
  }
  if (Array.isArray(ramp) && ramp.length >= 2) return ramp;
  throw new Error('ramp must be a built-in name or an array of [t, [r,g,b]] stops');
}
