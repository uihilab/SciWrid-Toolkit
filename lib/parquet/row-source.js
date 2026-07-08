import { fetchRange } from '../sources/range-fetcher.js';
import { MemoryChunkCache, cacheKey } from '../sources/chunk-cache.js';
import { schemaColumnNames } from './metadata.js';

let hyparquetModule = null;
export async function loadHyparquet() {
  if (hyparquetModule) return hyparquetModule;
  try {
    hyparquetModule = await import('hyparquet');
    return hyparquetModule;
  } catch (e) {
    throw new Error('parquet-helper: hyparquet not installed. Run: npm i hyparquet. Underlying error: ' + (e?.message || e));
  }
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function columnStats(rowGroup) {
  const stats = {};
  for (const c of rowGroup.columns || []) {
    const md = c.meta_data || {};
    const name = Array.isArray(md.path_in_schema) ? md.path_in_schema[0] : md.path_in_schema;
    if (name) stats[name] = md.statistics || null;
  }
  return stats;
}

export class WholeFileRowSource {
  constructor(buffer, metadata, hyparquet) {
    this.buffer = toArrayBuffer(buffer);
    this.metadata = metadata;
    this.hyparquet = hyparquet;
    this.bytesFetched = this.buffer.byteLength;
  }

  static async open(source) {
    const h = await loadHyparquet();
    const buffer = toArrayBuffer(source);
    const metadata = h.parquetMetadata(buffer);
    return new WholeFileRowSource(buffer, metadata, h);
  }

  schemaColumns() { return schemaColumnNames(this.metadata); }
  keyValueMetadata() { return this.metadata.key_value_metadata || []; }
  listRowGroups() {
    return (this.metadata.row_groups || []).map((rg, index) => ({ index, numRows: Number(rg.num_rows), stats: columnStats(rg) }));
  }

  async readColumns(colNames, rowGroupIndices = null) {
    const rows = await this.hyparquet.parquetReadObjects({ file: this.buffer, metadata: this.metadata, columns: colNames });
    return rowsToColumns(rows, colNames, rowGroupIndices, this.metadata);
  }

  async close() {}
}

async function headLength(url, fetchImpl) {
  const res = await fetchImpl(url, { method: 'HEAD' });
  if (!res.ok) throw new Error('Parquet: HEAD failed for ' + url + ': ' + res.status);
  const len = Number(res.headers.get('content-length'));
  if (!Number.isFinite(len)) throw new Error('Parquet: missing Content-Length for ' + url);
  return len;
}

class RangeAsyncBuffer {
  constructor(url, byteLength, fetchImpl, cache = new MemoryChunkCache()) {
    this.url = url;
    this.byteLength = byteLength;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.bytesFetched = 0;
  }

  async slice(start, end) {
    const offset = Number(start);
    const length = Number(end) - offset;
    const key = cacheKey(this.url, offset, length);
    const cached = this.cache.get(key);
    if (cached) return cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength);
    const bytes = await fetchRange(this.url, offset, length, this.fetchImpl);
    this.bytesFetched += bytes.length;
    this.cache.set(key, bytes);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

export class RangedRowSource {
  constructor(url, asyncBuffer, metadata, hyparquet) {
    this.url = url;
    this.asyncBuffer = asyncBuffer;
    this.metadata = metadata;
    this.hyparquet = hyparquet;
  }

  static async open(url, { fetchImpl = globalThis.fetch } = {}) {
    const h = await loadHyparquet();
    const byteLength = await headLength(url, fetchImpl);
    const asyncBuffer = new RangeAsyncBuffer(url, byteLength, fetchImpl);
    const metadata = await h.parquetMetadataAsync(asyncBuffer);
    return new RangedRowSource(url, asyncBuffer, metadata, h);
  }

  get bytesFetched() { return this.asyncBuffer.bytesFetched; }
  schemaColumns() { return schemaColumnNames(this.metadata); }
  keyValueMetadata() { return this.metadata.key_value_metadata || []; }
  listRowGroups() {
    return (this.metadata.row_groups || []).map((rg, index) => ({ index, numRows: Number(rg.num_rows), stats: columnStats(rg) }));
  }

  async readColumns(colNames, rowGroupIndices = null) {
    const rows = await this.hyparquet.parquetReadObjects({ file: this.asyncBuffer, metadata: this.metadata, columns: colNames });
    return rowsToColumns(rows, colNames, rowGroupIndices, this.metadata);
  }

  async close() {}
}

function rowGroupRanges(metadata) {
  let start = 0;
  return (metadata.row_groups || []).map((rg, index) => {
    const end = start + Number(rg.num_rows);
    const out = { index, start, end };
    start = end;
    return out;
  });
}

function rowsToColumns(rows, colNames, rowGroupIndices, metadata) {
  let selectedRows = rows;
  if (rowGroupIndices && rowGroupIndices.length && rowGroupIndices.length < (metadata.row_groups || []).length) {
    const keep = new Set(rowGroupIndices);
    const ranges = rowGroupRanges(metadata).filter(r => keep.has(r.index));
    selectedRows = [];
    for (const r of ranges) selectedRows.push(...rows.slice(r.start, r.end));
  }
  const out = {};
  for (const c of colNames) out[c] = new Array(selectedRows.length);
  for (let i = 0; i < selectedRows.length; i++) {
    const row = selectedRows[i];
    for (const c of colNames) out[c][i] = row[c];
  }
  return out;
}

export function isUrlSource(source) {
  const s = source instanceof URL ? source.href : source;
  return typeof s === 'string' && /^(https?|s3|gs):\/\//i.test(s);
}

export async function openRowSource(source, opts = {}) {
  if (isUrlSource(source)) return RangedRowSource.open(source instanceof URL ? source.href : source, opts);
  return WholeFileRowSource.open(source);
}
