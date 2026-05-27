// lib/zarr/decompressors.js
//
// Chunk-level decompression for Zarr v2.
// - inflateRaw: built-in via DecompressionStream (gzip / zlib / raw deflate)
// - _loadNumcodec: lazy-load blosc / zstd / lz4 via the `numcodecs` package
//                  (npm in Node, jsdelivr /+esm in browser)

/* numcodecs resolution:
 *   Browser  → jsdelivr ESM bundle (no `npm install` needed by end users).
 *   Node     → bare specifier from node_modules (we ship numcodecs in
 *              optionalDependencies for our own tests and Node consumers).
 * numcodecs base64-inlines its WASM into the JS bundle, so there is no
 * companion .wasm fetch — one HTTPS round trip covers everything.
 *
 * The whole module is fetched once and cached; per-codec classes are
 * resolved by name (`Blosc` / `Zstd` / `LZ4`) and re-cached so we only
 * pay the WASM init cost once per codec per process. */
const NUMCODECS_CDN = 'https://cdn.jsdelivr.net/npm/numcodecs@0.3.2/+esm';
const NUMCODECS_NAMES = { blosc: 'Blosc', zstd: 'Zstd', lz4: 'LZ4' };

let _numcodecsModule = null;
const _codecCache = new Map();

/** Raw deflate via the browser's built-in DecompressionStream. */
export async function inflateRaw(compBytes, expectedSize) {
  const stream = new Response(compBytes).body
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

async function _loadNumcodecsModule() {
  if (_numcodecsModule) return _numcodecsModule;
  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const spec   = isNode ? 'numcodecs' : NUMCODECS_CDN;
  try {
    const mod = await import(/* @vite-ignore */ spec);
    _numcodecsModule = mod.default ?? mod;
    return _numcodecsModule;
  } catch (e) {
    throw new Error(
      'Failed to load numcodecs from ' + spec + '. ' +
      (isNode
        ? 'In Node, install with: npm i numcodecs'
        : 'In the browser, check that ' + NUMCODECS_CDN + ' is reachable.') +
      ' Underlying error: ' + (e?.message || e)
    );
  }
}

async function _loadNumcodec(id) {
  if (_codecCache.has(id)) return _codecCache.get(id);
  const name = NUMCODECS_NAMES[id];
  if (!name) throw new Error('No numcodecs binding for compressor id: ' + id);
  const numcodecs = await _loadNumcodecsModule();
  const Codec = numcodecs[name];
  if (!Codec) throw new Error('numcodecs has no export named "' + name + '" (id=' + id + ')');
  _codecCache.set(id, Codec);
  return Codec;
}

export async function decompressChunk(bytes, compressor) {
  if (!compressor || compressor.id == null) return bytes;
  const id = String(compressor.id).toLowerCase();

  /* Built-in fast paths via the browser's DecompressionStream — no JS dep. */
  if (id === 'gzip') {
    const s = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  if (id === 'zlib') {
    const s = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  /* numcodecs-backed codecs (blosc, zstd, lz4). Loaded on demand. */
  if (id === 'blosc' || id === 'zstd' || id === 'lz4') {
    const Codec = await _loadNumcodec(id);
    const codec = Codec.fromConfig(compressor);
    const out   = await codec.decode(bytes);
    /* numcodecs may return a Uint8Array view over a larger buffer; normalize. */
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  throw new Error('Unsupported Zarr compressor: ' + id +
    '  (built-in: null / gzip / zlib; via numcodecs: blosc / zstd / lz4)');
}
