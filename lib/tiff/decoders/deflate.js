// lib/tiff/decoders/deflate.js
//
// Raw deflate decode via the Web-standard DecompressionStream
// (native in Node 18+; works in browser without polyfills).

export async function decode(bytes /*, expectedSize */) {
  const stream = new Response(bytes).body
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
