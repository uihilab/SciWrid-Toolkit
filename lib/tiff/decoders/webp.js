// lib/tiff/decoders/webp.js
//
// WebP decoder for TIFF (Compression=50001 — libtiff custom extension).
// Browser-only in v2: uses `createImageBitmap` + an `OffscreenCanvas` (or a
// regular canvas as fallback) to get RGBA pixel data. Node 22+ has gained
// `WebAssembly`-based WebP decoders in some builds, but there's no stable
// pure-JS or built-in WebP decode path we can rely on, so we throw clearly.

import { UnsupportedFormatError } from '../../errors.js';

export async function decode(bytes, opts = {}) {
  if (typeof createImageBitmap === 'undefined')
    throw new UnsupportedFormatError(
      'tiff: WebP-compressed TIFF can only be decoded in a browser environment in v2. ' +
      'Node support is tracked as a follow-up.');

  const blob   = new Blob([bytes], { type: 'image/webp' });
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width, h = bitmap.height;
  /* OffscreenCanvas is available in workers + most modern main threads.
   * Fall back to a regular canvas when not. */
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(w, h)
    : (() => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const spp = opts.samplesPerPixel ?? 3;
  const total = w * h;
  if (spp === 4) return new Uint8Array(rgba);
  if (spp === 3) {
    const out = new Uint8Array(total * 3);
    for (let i = 0, j = 0; i < total; i++, j += 4) {
      out[i * 3]     = rgba[j];
      out[i * 3 + 1] = rgba[j + 1];
      out[i * 3 + 2] = rgba[j + 2];
    }
    return out;
  }
  // spp === 1 → grayscale (R channel only)
  const out = new Uint8Array(total);
  for (let i = 0, j = 0; i < total; i++, j += 4) out[i] = rgba[j];
  return out;
}
