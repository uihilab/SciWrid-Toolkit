// lib/tiff/encoders/deflate.js
//
// zlib-wrapped deflate encoder (RFC 1950), which is what TIFF Compression 8
// means. Raw deflate opens only in SciWrid; GDAL and libtiff reject it.
// Node uses node:zlib (sync), browser uses CompressionStream('deflate')
// (the symmetric of the decoder path).
export async function encode(bytes /*, opts */) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { deflateSync } = await import('node:zlib');
    return new Uint8Array(deflateSync(bytes));
  }
  const stream = new Response(bytes).body
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
