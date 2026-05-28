// lib/tiff/decoders/lzw.js
//
// LZW decoder for TIFF (Compression=5). MSB-first bit order, TIFF's
// "early change" code-width semantics per TIFF Tech Note 2.
//
// Algorithm:
//   - codes 0..255 = literal bytes
//   - code 256     = ClearCode (reset table to size 258, code width to 9)
//   - code 257     = EOICode (end-of-information)
//   - code 258..   = string-builder entries
//   - code width increases by 1 when the *next* code to be assigned would
//     no longer fit (TIFF's "early change" — one bit earlier than the
//     classic LZW spec, which matches GIF as well).

const CLEAR = 256;
const EOI   = 257;

export async function decode(bytes /*, expectedSize */) {
  const out = [];
  let codeWidth = 9;
  let table = null;            // index -> Uint8Array
  let prev = -1;

  // Bit reader (MSB-first)
  let bitBuf = 0;
  let bitCount = 0;
  let p = 0;

  function nextCode() {
    while (bitCount < codeWidth) {
      if (p >= bytes.length) return -1;
      bitBuf = (bitBuf << 8) | bytes[p++];
      bitCount += 8;
    }
    bitCount -= codeWidth;
    const code = (bitBuf >>> bitCount) & ((1 << codeWidth) - 1);
    return code;
  }

  function resetTable() {
    table = [];
    for (let i = 0; i < 256; i++) table.push(Uint8Array.of(i));
    table.push(null);    // CLEAR placeholder
    table.push(null);    // EOI placeholder
    codeWidth = 9;
    prev = -1;
  }

  resetTable();

  for (;;) {
    const code = nextCode();
    if (code === -1 || code === EOI) break;

    if (code === CLEAR) { resetTable(); continue; }

    let entry;
    if (code < table.length) {
      entry = table[code];
    } else if (code === table.length && prev !== -1) {
      // KwKwK case: build entry from prev + prev[0]
      const prevStr = table[prev];
      entry = new Uint8Array(prevStr.length + 1);
      entry.set(prevStr);
      entry[prevStr.length] = prevStr[0];
    } else {
      throw new Error(`lzw: invalid code ${code} (table size ${table.length})`);
    }

    for (let i = 0; i < entry.length; i++) out.push(entry[i]);

    if (prev !== -1) {
      const prevStr = table[prev];
      const newStr = new Uint8Array(prevStr.length + 1);
      newStr.set(prevStr);
      newStr[prevStr.length] = entry[0];
      table.push(newStr);
      // TIFF early-change semantics (matches libtiff). The decoder pushes
      // one fewer entry than the encoder has assigned (the first post-CLEAR
      // code has prev=-1 and skips the push). So when the encoder's
      // post-increment nextCode reaches 1<<width, the decoder's table.length
      // reaches (1<<width)-1 at the same code position — bump so the next
      // code we read uses the new width.
      if (table.length === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth++;
    }
    prev = code;
  }
  return new Uint8Array(out);
}
