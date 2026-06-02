/*
 * lib/kerchunk/parquet-refs.js
 *
 * Internal helper. Reads a single-file kerchunk-parquet ref bundle (the
 * layout our build-kerchunk-fixture.js emits, and a reasonable target for
 * future producers) into an in-memory RefIndex.
 *
 * Parquet schema (one row per refs entry):
 *   key:    string                ← path-like key, e.g. ".zgroup", "tas/.zarray", "tas/0.0"
 *   path:   string | null         ← source file (for chunk refs)
 *   offset: int64  | null         ← byte offset within source file
 *   size:   int64  | null         ← byte length to read
 *   raw:    string | null         ← inline metadata (JSON for .zarray etc.)
 *
 * Rows fall into two shapes:
 *   - metadata: key + raw populated; path/offset/size null
 *   - chunk:    key + path/offset/size populated; raw null
 *
 * Paths in the parquet are resolved relative to the parquet file's
 * directory. Absolute paths are honored as-is.
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

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

/**
 * Walk one parquet file into two maps.
 *   metaEntries:  Map<key, Uint8Array>  ← .zarray / .zattrs / .zgroup, JSON bytes
 *   chunkEntries: Map<key, Ref>         ← "<var>/<chunkKey>" → Ref
 *
 * Ref shape:
 *   { kind: 'file',   path, offset, length }
 *   { kind: 'inline', bytes }
 */
async function _readBundle(parquetPath) {
  const stat = await fs.stat(parquetPath);
  if (stat.isDirectory()) {
    throw new Error(
      "kerchunk-helper: expected a single .parquet file at '" + parquetPath +
      "', got a directory. LazyReferenceMapper-style directory bundles are " +
      "not yet supported — a small adapter lives in the follow-up plan.",
    );
  }

  const hyparquet = await _loadHyparquet();
  const buf  = await fs.readFile(parquetPath);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const rows = await hyparquet.parquetReadObjects({ file });

  const baseDir = dirname(parquetPath);
  const metaEntries  = new Map();
  const chunkEntries = new Map();

  for (const row of rows) {
    if (row == null || row.key == null) continue;
    const key = String(row.key);

    if (row.raw != null) {
      /* Metadata row (or inline chunk). String → bytes. */
      const bytes = (row.raw instanceof Uint8Array)
        ? row.raw
        : new TextEncoder().encode(String(row.raw));
      /* Heuristic: keys ending with .zarray/.zattrs/.zgroup/.zmetadata are
       * always metadata. Anything else with a non-null raw is an inline chunk. */
      if (/(\.zarray|\.zattrs|\.zgroup|\.zmetadata)$/.test(key)) {
        metaEntries.set(key, bytes);
      } else {
        chunkEntries.set(key, { kind: 'inline', bytes });
      }
      continue;
    }

    if (row.path != null) {
      const path = _resolvePath(String(row.path), baseDir);
      const offset = _toNumber(row.offset, 'offset', key);
      const length = _toNumber(row.size,   'size',   key);
      chunkEntries.set(key, { kind: 'file', path, offset, length });
      continue;
    }

    /* All-null row: chunk omitted (treat as fill_value). Don't store. */
  }

  return { metaEntries, chunkEntries };
}

function _toNumber(v, label, key) {
  if (v == null) throw new Error("ref '" + key + "' missing " + label);
  if (typeof v === 'bigint') {
    if (v > Number.MAX_SAFE_INTEGER) {
      throw new Error("ref '" + key + "' " + label + ' exceeds Number.MAX_SAFE_INTEGER');
    }
    return Number(v);
  }
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("ref '" + key + "' bad " + label + ': ' + v);
  return n;
}

function _resolvePath(p, baseDir) {
  let s = p;
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  /* Windows: file:///C:/... → /C:/...; strip leading slash if drive letter follows */
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  if (isAbsolute(s)) return s;
  return join(baseDir, s);
}

/**
 * Public entry: open a single-file kerchunk-parquet ref bundle.
 *
 *   openRefIndex(parquetPath) → {
 *     listMetaKeys(): string[],
 *     getMeta(key):   Uint8Array | null,
 *     listChunkKeys(varName?): string[],
 *     getRef(varName, chunkKey):
 *       { kind:'file',   path, offset, length } |
 *       { kind:'inline', bytes }                |
 *       null,
 *   }
 */
export async function openRefIndex(parquetPath) {
  const { metaEntries, chunkEntries } = await _readBundle(parquetPath);
  return {
    listMetaKeys() { return [...metaEntries.keys()]; },
    getMeta(key)   { return metaEntries.get(key) || null; },
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
