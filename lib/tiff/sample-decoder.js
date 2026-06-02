// lib/tiff/sample-decoder.js
//
// Pull one typed value out of a decoded strip/tile byte buffer.
// Handles chunky (PlanarConfiguration=1) only in v1 phase 3 — separate
// planes (=2) is handled later when we wire scan/extract for multi-band.

function bytesPerSample(dtype) {
  switch (dtype) {
    case 'uint8':   return 1;
    case 'int8':    return 1;
    case 'uint16':  return 2;
    case 'int16':   return 2;
    case 'float32': return 4;
    default: throw new Error(`sample-decoder: unsupported dtype ${dtype}`);
  }
}

export function sampleValue(blockBytes, {
  rowInBlock, colInBlock, blockWidth,
  samplesPerPixel, bandIndex, dtype, le = true,
}) {
  const bps = bytesPerSample(dtype);
  const byteOff =
    ((rowInBlock * blockWidth) + colInBlock) * samplesPerPixel * bps
    + bandIndex * bps;
  const dv = new DataView(blockBytes.buffer, blockBytes.byteOffset + byteOff, bps);
  switch (dtype) {
    case 'uint8':   return dv.getUint8(0);
    case 'int8':    return dv.getInt8(0);
    case 'uint16':  return dv.getUint16(0, le);
    case 'int16':   return dv.getInt16(0, le);
    case 'float32': return dv.getFloat32(0, le);
  }
}
