/*
 * lib/kerchunk/parquet-refs.js
 *
 * Reads a single-file kerchunk-parquet ref bundle into an in-memory RefIndex.
 * Entry points:
 *   - openRefIndex(parquetPath)            Node local file path
 *   - openRefIndexFromBuffer(buf, baseUrl) browser/Node already-fetched bytes
 *
 * Chunk ref kinds:
 *   { kind:'inline', bytes }
 *   { kind:'file',   path, offset, length }
 *   { kind:'remote', url,  offset, length }
 *
 * Node builtins are imported dynamically inside openRefIndex so browser
 * bundles can safely import this module and use openRefIndexFromBuffer.
 */

let _hyparquetModule = null;
async function _loadHyparquet() {
  if (_hyparquetModule) return _hyparquetModule;
  try {
    _hyparquetModule = await import('hyparquet');
    return _hyparquetModule;
  } catch (e) {
    throw new Error(
      'kerchunk-helper: hyparquet not installed. Run: npm i hyparquet. ' +
      'Underlying error: ' + (e?.message || e),
    );
  }
}

function _isRemote(p) {
  return /^(https?|s3|gs):\/\//i.test(p);
}

async function _readRows(file) {
  const hyparquet = await _loadHyparquet();
  return hyparquet.parquetReadObjects({ file });
}

function _toNumber(v, label, key) {
  if (v == null) throw new Error("ref '" + key + "' missing " + label);
  if (typeof v === 'bigint') {
    if (v > Number.MAX_SAFE_INTEGER)
      throw new Error("ref '" + key + "' " + label + ' exceeds Number.MAX_SAFE_INTEGER');
    return Number(v);
  }
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("ref '" + key + "' bad " + label + ': ' + v);
  return n;
}

function _buildIndex(rows, resolveChunk) {
  const metaEntries = new Map();
  const chunkEntries = new Map();

  for (const row of rows) {
    if (row == null || row.key == null) continue;
    const key = String(row.key);

    if (row.raw != null) {
      const bytes = (row.raw instanceof Uint8Array)
        ? row.raw
        : new TextEncoder().encode(String(row.raw));
      if (/(\.zarray|\.zattrs|\.zgroup|\.zmetadata)$/.test(key)) {
        metaEntries.set(key, bytes);
      } else {
        chunkEntries.set(key, { kind: 'inline', bytes });
      }
      continue;
    }

    if (row.path != null) {
      const offset = _toNumber(row.offset, 'offset', key);
      const length = _toNumber(row.size, 'size', key);
      chunkEntries.set(key, { ...resolveChunk(String(row.path)), offset, length });
    }
  }

  return {
    listMetaKeys() { return [...metaEntries.keys()]; },
    getMeta(key) { return metaEntries.get(key) || null; },
    listChunkKeys(varName) {
      if (varName == null) return [...chunkEntries.keys()];
      const prefix = varName + '/';
      const out = [];
      for (const k of chunkEntries.keys()) {
        if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
    getRef(varName, chunkKey) {
      return chunkEntries.get(varName + '/' + chunkKey) || null;
    },
  };
}

export async function openRefIndex(parquetPath) {
  const { promises: fs } = await import('node:fs');
  const { dirname, isAbsolute, join } = await import('node:path');

  const stat = await fs.stat(parquetPath);
  if (stat.isDirectory()) {
    throw new Error(
      "kerchunk-helper: expected a single .parquet file at '" + parquetPath +
      "', got a directory. LazyReferenceMapper-style directory bundles are not yet supported.",
    );
  }

  const buf = await fs.readFile(parquetPath);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const rows = await _readRows(file);
  const baseDir = dirname(parquetPath);

  const resolveLocal = (raw) => {
    let s = raw;
    if (s.startsWith('file://')) s = s.slice('file://'.length);
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    return isAbsolute(s) ? s : join(baseDir, s);
  };

  const resolveChunk = (raw) =>
    _isRemote(raw)
      ? { kind: 'remote', url: raw }
      : { kind: 'file', path: resolveLocal(raw) };

  return _buildIndex(rows, resolveChunk);
}

export async function openRefIndexFromBuffer(buf, baseUrl) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const file = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const rows = await _readRows(file);

  const resolveChunk = (raw) =>
    _isRemote(raw)
      ? { kind: 'remote', url: raw }
      : { kind: 'remote', url: new URL(raw, baseUrl).href };

  return _buildIndex(rows, resolveChunk);
}
