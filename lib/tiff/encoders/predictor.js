// lib/tiff/encoders/predictor.js
//
// Apply (in-place) the predictor encoding before compression. Mirrors the
// inverse routines in lib/tiff/predictors.js so a decoded buffer round-
// trips losslessly through encoder → decoder.

function bytesPerSample(dtype) {
  switch (dtype) {
    case 'uint8': case 'int8':   return 1;
    case 'uint16': case 'int16': return 2;
    case 'float32':              return 4;
    default: throw new Error(`predictor-encode: unsupported dtype ${dtype}`);
  }
}

export function applyPredictor(bytes, { predictor, width, height, samplesPerPixel, dtype, le = true }) {
  if (predictor === 1 || predictor === undefined) return;

  const bps = bytesPerSample(dtype);
  const rowBytes = width * samplesPerPixel * bps;

  if (predictor === 2) {
    // Per-sample horizontal diff. Iterate from RIGHT to LEFT so the diff
    // sees the original sample, not the already-diffed one.
    for (let r = 0; r < height; r++) {
      const rowOff = r * rowBytes;
      switch (dtype) {
        case 'uint8': case 'int8': {
          const arr = bytes.subarray(rowOff, rowOff + rowBytes);
          for (let i = width * samplesPerPixel - 1; i >= samplesPerPixel; i--) {
            arr[i] = (arr[i] - arr[i - samplesPerPixel]) & 0xff;
          }
          break;
        }
        case 'uint16': case 'int16': {
          const view = new DataView(bytes.buffer, bytes.byteOffset + rowOff, rowBytes);
          const signed = dtype === 'int16';
          const get = signed ? (i) => view.getInt16(i * 2, le)  : (i) => view.getUint16(i * 2, le);
          const set = signed ? (i, v) => view.setInt16(i * 2, v, le) : (i, v) => view.setUint16(i * 2, v, le);
          for (let i = width * samplesPerPixel - 1; i >= samplesPerPixel; i--) {
            set(i, (get(i) - get(i - samplesPerPixel)) | 0);
          }
          break;
        }
        default:
          throw new Error(`predictor 2 encode: unsupported dtype ${dtype}`);
      }
    }
    return;
  }

  if (predictor === 3) {
    if (dtype !== 'float32')
      throw new Error(`predictor 3 only defined for float32 (got ${dtype})`);
    const tmp = new Uint8Array(rowBytes);
    for (let r = 0; r < height; r++) {
      const rowOff = r * rowBytes;
      // 1) Shuffle: byte (j*bps + i) -> position (i * samplesInRow + j)
      const samplesInRow = width * samplesPerPixel;
      for (let b = 0; b < bps; b++) {
        for (let s = 0; s < samplesInRow; s++) {
          tmp[b * samplesInRow + s] = bytes[rowOff + s * bps + b];
        }
      }
      // 2) Horizontal diff per byte (right-to-left so we read originals)
      for (let i = rowBytes - 1; i >= 1; i--) tmp[i] = (tmp[i] - tmp[i - 1]) & 0xff;
      bytes.set(tmp, rowOff);
    }
    return;
  }

  throw new Error(`Unsupported predictor ${predictor}`);
}
