// lib/tiff/decoders/jpeg.js
//
// JPEG decoder for TIFF (Compression=7). Lazy-loads `jpeg-js` — bare
// specifier in Node (resolved from optionalDependencies), jsdelivr ESM in
// the browser — mirroring lib/zarr/decompressors.js's numcodecs pattern.
//
// jpeg-js decodes a full JPEG bitstream and returns RGBA pixels. The TIFF
// caller already knows the block's geometry from the IFD, so we surface an
// `{ width, height, data }` shape — the sample-decoder treats this output as
// a self-describing block.

const JPEG_CDN = 'https://cdn.jsdelivr.net/npm/jpeg-js@0.4.4/+esm';

let _jpegPromise = null;
async function loadJpeg() {
  if (_jpegPromise) return _jpegPromise;
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const spec   = isNode ? 'jpeg-js' : JPEG_CDN;
  _jpegPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ spec);
      return mod.default ?? mod;
    } catch (e) {
      throw new Error(
        'tiff: failed to load jpeg-js from ' + spec + '. ' +
        (isNode
          ? 'In Node, install with: npm i jpeg-js'
          : 'In the browser, check that ' + JPEG_CDN + ' is reachable.') +
        ' Underlying error: ' + (e?.message || e)
      );
    }
  })();
  return _jpegPromise;
}

/**
 * Decode a JPEG bitstream from a TIFF strip/tile and flatten the RGBA
 * output to a chunky byte buffer matching the TIFF's SamplesPerPixel:
 *   spp=1 → grayscale (R channel only), length = w*h
 *   spp=3 → RGB chunky (R,G,B,R,G,B,...), length = w*h*3
 *   spp=4 → RGBA, length = w*h*4 (passed through verbatim)
 *
 * Returns a Uint8Array; sample-decoder consumes it the same as any other
 * uncompressed block.
 */
export async function decode(bytes, opts = {}) {
  const jpeg = await loadJpeg();
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const { width, height, data } = decoded;     // data: Uint8Array(w*h*4) RGBA
  const spp = opts.samplesPerPixel ?? 3;
  const total = width * height;

  if (spp === 4) return data;                  // already RGBA chunky

  if (spp === 3) {
    const out = new Uint8Array(total * 3);
    for (let i = 0, j = 0; i < total; i++, j += 4) {
      out[i * 3]     = data[j];
      out[i * 3 + 1] = data[j + 1];
      out[i * 3 + 2] = data[j + 2];
    }
    return out;
  }

  // spp === 1 → grayscale (R channel only)
  const out = new Uint8Array(total);
  for (let i = 0, j = 0; i < total; i++, j += 4) out[i] = data[j];
  return out;
}
