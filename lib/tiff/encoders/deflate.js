// lib/tiff/encoders/deflate.js
//
// Raw deflate encoder — Node uses node:zlib (sync), browser uses
// CompressionStream('deflate-raw') (the symmetric of the decoder path).
export async function encode(bytes /*, opts */) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { deflateRawSync } = await import('node:zlib');
    return new Uint8Array(deflateRawSync(bytes));
  }
  const stream = new Response(bytes).body
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
