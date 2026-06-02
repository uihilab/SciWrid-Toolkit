// lib/render/to-png.js
//
// Tiny PNG encoder. Output: 8-bit RGBA PNG, no interlace, filter 0 (None).
// Works in Node (uses `node:zlib`) and the browser (uses `CompressionStream`).
import { gridToImageData } from './to-imagedata.js';

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);

async function zlibDeflate(bytes) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { deflateSync } = await import('node:zlib');
    return new Uint8Array(deflateSync(bytes));
  }
  const stream = new Response(bytes).body.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// CRC32 (PNG variant — polynomial 0xEDB88320)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(8 + len + 4);
  const dv  = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC over type + data
  const crcBytes = out.subarray(4, 8 + len);
  dv.setUint32(8 + len, crc32(crcBytes));
  return out;
}

/** Encode a grid as a PNG (browser + Node). Returns Uint8Array. */
export async function gridToPNG(grid, opts = {}) {
  const img = gridToImageData(grid, opts);
  const { width, height, data } = img;

  // Prepend filter byte (0 = None) to each scanline
  const scanlineLen = width * 4;
  const filtered = new Uint8Array(height * (1 + scanlineLen));
  for (let r = 0; r < height; r++) {
    filtered[r * (1 + scanlineLen)] = 0;
    filtered.set(data.subarray(r * scanlineLen, (r + 1) * scanlineLen),
                 r * (1 + scanlineLen) + 1);
  }
  const idat = await zlibDeflate(filtered);

  // IHDR: width(4) height(4) bit-depth(1) color-type(1) compression(1) filter(1) interlace(1)
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type: RGBA
  ihdr[10] = 0;   // compression: deflate
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace: none

  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', idat);
  const iendChunk = chunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(PNG_SIG.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let p = 0;
  out.set(PNG_SIG, p); p += PNG_SIG.length;
  out.set(ihdrChunk, p); p += ihdrChunk.length;
  out.set(idatChunk, p); p += idatChunk.length;
  out.set(iendChunk, p);
  return out;
}
