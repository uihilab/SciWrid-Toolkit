// lib/tiff/decoders/packbits.js
//
// PackBits decoder (TIFF Compression=32773). Run-length encoding from the
// Apple TIFF spec. Each control byte n governs the next bytes:
//   0..127     copy n+1 literal bytes
//   -1..-127   repeat next byte (1 - n) times (i.e. 2..128 times)
//   -128       no-op
//
// PackBits is read as signed bytes — interpret the control byte as Int8.

export async function decode(bytes /*, expectedSize */) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const n = bytes[i++];
    if (n < 128) {                  // 0..127 → copy n+1 literal bytes
      const count = n + 1;
      for (let k = 0; k < count && i < bytes.length; k++) out.push(bytes[i++]);
    } else if (n === 128) {         // no-op (rare in practice)
      continue;
    } else {                         // 129..255 (signed: -127..-1) → repeat
      const repeat = 257 - n;       // n=255 → 2; n=129 → 128
      if (i >= bytes.length) break;
      const v = bytes[i++];
      for (let k = 0; k < repeat; k++) out.push(v);
    }
  }
  return new Uint8Array(out);
}
