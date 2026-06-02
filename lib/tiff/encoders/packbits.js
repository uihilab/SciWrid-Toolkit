// lib/tiff/encoders/packbits.js
//
// TIFF Compression=32773 encoder. Greedy RLE: 3+ run → repeat block;
// otherwise literal block. Symmetric with lib/tiff/decoders/packbits.js.
export function encode(bytes /*, opts */) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let runLen = 1;
    while (runLen < 128 && i + runLen < bytes.length && bytes[i + runLen] === bytes[i]) runLen++;
    if (runLen >= 3) {
      out.push((257 - runLen) & 0xff);
      out.push(bytes[i]);
      i += runLen;
      continue;
    }
    let litStart = i;
    while (i < bytes.length && i - litStart < 128) {
      if (i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i + 1] === bytes[i + 2]) break;
      i++;
    }
    const litLen = i - litStart;
    out.push(litLen - 1);
    for (let k = 0; k < litLen; k++) out.push(bytes[litStart + k]);
  }
  return new Uint8Array(out);
}
