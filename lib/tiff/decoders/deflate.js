// lib/tiff/decoders/deflate.js
//
// Deflate decode via the Web-standard DecompressionStream
// (native in Node 18+; works in browser without polyfills).
//
// TIFF Compression 8 / 32946 is zlib-wrapped deflate (RFC 1950) per the spec,
// and that is what GDAL, libtiff and every COG writer produce. SciWrid used to
// write raw deflate (RFC 1951) instead, so files it exported before that was
// fixed are raw. Pick the format per stream, so both stay readable.
function isZlib(bytes) {
  if (bytes.length < 2) return false;
  // CMF low nibble 8 = deflate; CMF*256+FLG must be a multiple of 31 (FCHECK).
  return (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
}

export async function decode(bytes /*, expectedSize */) {
  const format = isZlib(bytes) ? 'deflate' : 'deflate-raw';
  const stream = new Response(bytes).body
    .pipeThrough(new DecompressionStream(format));
  const ab = await new Response(stream).arrayBuffer();
  const out = new Uint8Array(ab);
  // libtiff/GDAL never write raw deflate, so a raw block can only be a SciWrid
  // file from before the fix; flag it so predictor 3 can use the old plane order.
  if (format === 'deflate-raw') out.rawDeflate = true;
  return out;
}
