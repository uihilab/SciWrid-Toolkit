// lib/tiff/predictors.js
//
// Reverse TIFF predictor encoding. In-place over the supplied Uint8Array.
//
// predictor 1 = none (no-op)
// predictor 2 = horizontal: each sample within a row was diffed from the
//               previous sample of the same channel
// predictor 3 = floating-point: each byte within a row was diffed from the
//               previous byte AFTER the row was shuffled
//               (byte i of sample j → position (j*bytesPerSample + i))

function bytesPerSample(dtype) {
  switch (dtype) {
    case 'uint8': case 'int8':   return 1;
    case 'uint16': case 'int16': return 2;
    case 'float32':              return 4;
    default: throw new Error(`predictor: unsupported dtype ${dtype}`);
  }
}

export function unpredict(bytes, { predictor, width, height, samplesPerPixel, dtype }) {
  if (predictor === 1 || predictor === undefined) return;

  const bps = bytesPerSample(dtype);
  const rowBytes = width * samplesPerPixel * bps;

  if (predictor === 2) {
    // Horizontal per-sample (NOT per-byte): for each row, for each sample
    // in scan order, view it as a typed value and add the previous sample.
    for (let r = 0; r < height; r++) {
      const rowOff = r * rowBytes;
      // Sample i, channel c: index in row = (i * samplesPerPixel + c) * bps.
      // Diff is per channel: out[i,c] = enc[i,c] + out[i-1,c]
      // To stay typed-correct, view the row as the right typed array.
      switch (dtype) {
        case 'uint8': case 'int8': {
          const arr = bytes.subarray(rowOff, rowOff + rowBytes);
          for (let i = samplesPerPixel; i < width * samplesPerPixel; i++) {
            arr[i] = (arr[i] + arr[i - samplesPerPixel]) & 0xff;
          }
          break;
        }
        case 'uint16': case 'int16': {
          const view = new DataView(bytes.buffer, bytes.byteOffset + rowOff, rowBytes);
          const signed = dtype === 'int16';
          const get = signed ? (i) => view.getInt16(i * 2, true)  : (i) => view.getUint16(i * 2, true);
          const set = signed ? (i, v) => view.setInt16(i * 2, v, true) : (i, v) => view.setUint16(i * 2, v, true);
          for (let i = samplesPerPixel; i < width * samplesPerPixel; i++) {
            set(i, (get(i) + get(i - samplesPerPixel)) | 0);
          }
          break;
        }
        default:
          throw new Error(`predictor 2: unsupported dtype ${dtype}`);
      }
    }
    return;
  }

  if (predictor === 3) {
    // Floating-point: per row, undo per-byte horizontal diff, then unshuffle.
    if (dtype !== 'float32')
      throw new Error(`predictor 3 only defined for float32 in v1 (got ${dtype})`);

    const tmp = new Uint8Array(rowBytes);
    for (let r = 0; r < height; r++) {
      const rowOff = r * rowBytes;
      // 1) undo horizontal diff per byte
      for (let i = 1; i < rowBytes; i++) {
        bytes[rowOff + i] = (bytes[rowOff + i] + bytes[rowOff + i - 1]) & 0xff;
      }
      // 2) unshuffle: byte (j*bps + i)  ←  position (i * (rowBytes/bps) + j)
      const samplesInRow = width * samplesPerPixel;
      for (let b = 0; b < bps; b++) {
        for (let s = 0; s < samplesInRow; s++) {
          tmp[s * bps + b] = bytes[rowOff + b * samplesInRow + s];
        }
      }
      bytes.set(tmp, rowOff);
    }
    return;
  }

  throw new Error(`Unsupported predictor ${predictor}`);
}
