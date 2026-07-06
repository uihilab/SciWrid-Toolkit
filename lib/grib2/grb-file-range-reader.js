/*
 * lib/grib2/grb-file-range-reader.js
 * Seekable LOCAL source for range-native GRIB2 (Node only). Same interface as
 * GrbRangeReader (size / read / stats) but backed by fs positional reads, so a
 * large local file is never loaded whole — the header walk reads ~1 KB/message
 * and the decode reads only the needed message(s).
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs';

export class GrbFileRangeReader {
  constructor(path) {
    this._path = path;
    this._size = null;
    this._fd = null;
    this._stats = { requests: 0, bytes: 0 };
  }

  async size() {
    if (this._size == null) this._size = statSync(this._path).size;
    return this._size;
  }

  /* Read exactly [offset, offset+length) (clamped to EOF) via a positional read. */
  async read(offset, length) {
    const total = await this.size();
    const end = Math.min(offset + length, total);
    const len = Math.max(0, end - offset);
    if (len === 0) return new Uint8Array(0);
    if (this._fd == null) this._fd = openSync(this._path, 'r');
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(this._fd, buf, 0, len, offset);
    this._stats.requests += 1;
    this._stats.bytes += n;
    return new Uint8Array(buf.subarray(0, n));   // copy out of the shared pool
  }

  stats() { return { ...this._stats }; }

  close() { if (this._fd != null) { closeSync(this._fd); this._fd = null; } }
}
