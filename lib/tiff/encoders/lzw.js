// lib/tiff/encoders/lzw.js
//
// TIFF-LZW encoder (Compression=5). Mirrors the decoder in
// lib/tiff/decoders/lzw.js: MSB-first bit packing, "early change" width
// bump (matches libtiff — width grows when the just-assigned entry's
// index reaches 2^width - 1).

const CLEAR = 256, EOI = 257;

export function encode(bytes /*, opts */) {
  const table = new Map();
  let nextCode;
  let codeWidth = 9;

  function reset() {
    table.clear();
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
    nextCode = 258;
    codeWidth = 9;
  }

  const bits = [];
  function emit(code) {
    for (let i = codeWidth - 1; i >= 0; i--) bits.push((code >>> i) & 1);
  }

  reset();
  emit(CLEAR);

  let w = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = String.fromCharCode(bytes[i]);
    const wc = w + c;
    if (table.has(wc)) {
      w = wc;
    } else {
      emit(table.get(w));
      table.set(wc, nextCode++);
      if (nextCode === (1 << codeWidth) && codeWidth < 12) codeWidth++;
      w = c;
    }
  }
  if (w !== '') emit(table.get(w));
  emit(EOI);

  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}
