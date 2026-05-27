/*
 * lib/slim/zarr.js
 *
 * Zarr v2 (zip-of-zarr) slim — zip-entry filter, no decode.
 *
 * Strategy:
 *   1. Walk the source ZIP's central directory to enumerate every entry
 *      with its raw byte span (compressed payload preserved verbatim).
 *   2. For each requested variable, parse <var>/.zarray + <var>/.zattrs
 *      to learn the chunk grid and which axis is "time" (heuristic:
 *      look at _ARRAY_DIMENSIONS for a name in {'time','t','Time'};
 *      fall back to axis 0).
 *   3. Decide which chunks to keep:
 *        - No t1/t2: all chunks
 *        - With t1/t2: every chunk whose time extent intersects
 *          [t1, t2+1). Boundary-widening (kept range may extend to chunk
 *          boundaries) is surfaced in result.warnings.
 *   4. Re-emit a new ZIP containing: .zgroup, top-level .zattrs (if any),
 *      and for each kept variable its .zarray + .zattrs + selected chunks.
 *      Entry method (stored=0 / deflate=8) is preserved per-entry — no
 *      recompression.
 *
 * CRC-32 is set to 0 for stored entries; the existing zarr-helper readZip
 * also ignores CRC, mirroring the project's existing buildZip convention
 * in scripts/test-zarr.js.
 *
 * Out of scope (v1): spatial bbox slicing; partial-chunk extraction along
 * the time axis (which would require decode + re-encode). Both deferred.
 */

import { SlimError } from './errors.js';
import { VariableNotFoundError } from '../errors.js';

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG   = 0x02014b50;

/* ── ZIP walker — returns raw byte spans, no decompression ─────────────── */

function findEOCD(data) {
  const dv  = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const min = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD_SIG) return i;
  }
  throw new SlimError('Zarr slim: not a ZIP file (no EOCD found)');
}

/**
 * Returns an array of { name, method, compSize, uncompSize, dataOff }.
 * dataOff is the absolute byte offset of the entry's compressed payload
 * within `data`. compSize bytes starting at dataOff are the raw stream.
 */
function parseZipEntries(data) {
  const dv      = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd    = findEOCD(data);
  const nEntry  = dv.getUint16(eocd + 10, true);
  const cdSize  = dv.getUint32(eocd + 12, true);
  const cdOff   = dv.getUint32(eocd + 16, true);

  const dec = new TextDecoder();
  const out = [];
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  for (let i = 0; i < nEntry && p < cdEnd; i++) {
    if (dv.getUint32(p, true) !== ZIP_CD_SIG)
      throw new SlimError(`Zarr slim: corrupt central directory at ${p}`);
    const method     = dv.getUint16(p + 10, true);
    const compSize   = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen    = dv.getUint16(p + 28, true);
    const extraLen   = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localHdr   = dv.getUint32(p + 42, true);
    const name       = dec.decode(data.subarray(p + 46, p + 46 + nameLen));

    /* Skip into the local header to find the actual data offset (local
     * header sizes can differ from CD entries because of extra fields). */
    if (dv.getUint32(localHdr, true) !== 0x04034b50)
      throw new SlimError(
        `Zarr slim: corrupt local header for entry '${name}' at ${localHdr}`);
    const lhNameLen  = dv.getUint16(localHdr + 26, true);
    const lhExtraLen = dv.getUint16(localHdr + 28, true);
    const dataOff    = localHdr + 30 + lhNameLen + lhExtraLen;

    out.push({ name, method, compSize, uncompSize, dataOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ── ZIP writer — preserves per-entry method, no recompression ───────────
 *
 * Two entry shapes are accepted:
 *   Passthrough: { name, method, compSize, uncompSize, dataOff }   ← from parseZipEntries
 *   Synthetic:   { name, bytes }   ← method assumed to be 0 (stored)
 * Synthetic entries are used when we have to emit a freshly built file
 * (e.g. a rewritten .zarray with the slimmed shape).
 * ----------------------------------------------------------------------- */

function writeZip(entries, sourceData) {
  const enc        = new TextEncoder();
  const localParts = [];
  const cdParts    = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes  = enc.encode(e.name);
    const method     = e.bytes ? 0 : e.method;
    const compSize   = e.bytes ? e.bytes.length : e.compSize;
    const uncompSize = e.bytes ? e.bytes.length : e.uncompSize;
    const payload    = e.bytes
                     ? e.bytes
                     : sourceData.subarray(e.dataOff, e.dataOff + e.compSize);

    /* Local file header (30B + name) */
    const lh   = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0,  0x04034b50, true);
    lhDV.setUint16(4,  20, true);
    lhDV.setUint16(6,  0,  true);
    lhDV.setUint16(8,  method, true);
    lhDV.setUint16(10, 0,  true);
    lhDV.setUint16(12, 0,  true);
    lhDV.setUint32(14, 0,  true);            /* CRC=0 (reader ignores) */
    lhDV.setUint32(18, compSize,   true);
    lhDV.setUint32(22, uncompSize, true);
    lhDV.setUint16(26, nameBytes.length, true);
    lhDV.setUint16(28, 0,  true);
    lh.set(nameBytes, 30);
    localParts.push(lh, payload);

    /* Central directory entry (46B + name) */
    const cd   = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0,  0x02014b50, true);
    cdDV.setUint16(4,  20, true);
    cdDV.setUint16(6,  20, true);
    cdDV.setUint16(8,  0,  true);
    cdDV.setUint16(10, method, true);
    cdDV.setUint16(12, 0,  true);
    cdDV.setUint16(14, 0,  true);
    cdDV.setUint32(16, 0,  true);
    cdDV.setUint32(20, compSize,   true);
    cdDV.setUint32(24, uncompSize, true);
    cdDV.setUint16(28, nameBytes.length, true);
    cdDV.setUint16(30, 0,  true);
    cdDV.setUint16(32, 0,  true);
    cdDV.setUint16(34, 0,  true);
    cdDV.setUint16(36, 0,  true);
    cdDV.setUint32(38, 0,  true);
    cdDV.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + payload.length;
  }

  /* Re-thread: keep the unused-binding lint quiet in case sourceData isn't
   * referenced (when every entry is synthetic). */
  void sourceData;

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0,  0x06054b50, true);
  eocdDV.setUint16(4,  0, true);
  eocdDV.setUint16(6,  0, true);
  eocdDV.setUint16(8,  entries.length, true);
  eocdDV.setUint16(10, entries.length, true);
  eocdDV.setUint32(12, cdSize, true);
  eocdDV.setUint32(16, cdOffset, true);
  eocdDV.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of cdParts)    { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

/* ── Helpers to decode small JSON entries (zarray/zattrs) ───────────────── */

function readEntryUtf8(data, entry) {
  if (entry.method !== 0)
    throw new SlimError(
      `Zarr slim: expected entry '${entry.name}' to be stored ` +
      `(method=0); got method=${entry.method}. ` +
      `Zarr metadata files (.zarray/.zattrs/.zgroup) are conventionally ` +
      `uncompressed; refusing to silently re-decompress.`);
  const bytes = data.subarray(entry.dataOff, entry.dataOff + entry.compSize);
  return new TextDecoder().decode(bytes);
}

/* ── Variable / chunk identification ────────────────────────────────────── */

/**
 * Group entries into variables. A "variable" is any path segment that has
 * a `<name>/.zarray` entry. Returns:
 *   {
 *     topLevel:  Entry[]   (e.g. .zgroup, top-level .zattrs)
 *     vars: Map<name, { zarray, zattrs, chunks: Entry[] }>
 *   }
 */
function groupEntries(entries) {
  const topLevel = [];
  const vars     = new Map();

  for (const e of entries) {
    const slash = e.name.indexOf('/');
    if (slash < 0) { topLevel.push(e); continue; }

    const varName = e.name.slice(0, slash);
    const subPath = e.name.slice(slash + 1);
    if (!vars.has(varName))
      vars.set(varName, { zarray: null, zattrs: null, chunks: [] });
    const v = vars.get(varName);
    if      (subPath === '.zarray') v.zarray = e;
    else if (subPath === '.zattrs') v.zattrs = e;
    else                            v.chunks.push(e);
  }

  /* Drop "variables" that don't actually have a .zarray (e.g. sub-groups). */
  for (const [name, v] of vars.entries())
    if (!v.zarray) vars.delete(name);

  return { topLevel, vars };
}

/**
 * Determine the time-axis position for a Zarr variable, defaulting to 0.
 * Looks at the .zattrs `_ARRAY_DIMENSIONS` field if present.
 */
function timeAxisIndex(zattrsObj) {
  const dims = zattrsObj && zattrsObj._ARRAY_DIMENSIONS;
  if (!Array.isArray(dims)) return 0;
  for (let i = 0; i < dims.length; i++) {
    const d = String(dims[i] ?? '').toLowerCase();
    if (d === 'time' || d === 't') return i;
  }
  return 0;
}

/**
 * Parse a chunk key like "3.0.5" or "3/0/5" into a numeric index array.
 * The separator comes from the zarray's dimension_separator (default '.').
 */
function parseChunkKey(key, sep) {
  const parts = key.split(sep);
  const out   = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (!Number.isFinite(n)) return null;   /* bail; treat as non-chunk */
    out[i] = n;
  }
  return out;
}

/* ── Main entry point ───────────────────────────────────────────────────── */

async function loadAll(byteSource) {
  const size = await byteSource.size();
  return byteSource.read(0, size);
}

export async function slim(byteSource, opts /*, ctx */) {
  const data    = await loadAll(byteSource);
  const entries = parseZipEntries(data);
  const { topLevel, vars: allVars } = groupEntries(entries);

  /* Validate requested variables. */
  const requested = new Set(opts.variables);
  const missing   = opts.variables.filter(v => !allVars.has(v));
  if (missing.length === opts.variables.length)
    throw new VariableNotFoundError(
      `Zarr slim: none of the requested variables are present ` +
      `(requested: ${opts.variables.join(', ')}; ` +
      `available: ${[...allVars.keys()].join(', ')})`);
  if (missing.length > 0)
    throw new VariableNotFoundError(
      `Zarr slim: variable(s) not found: ${missing.join(', ')}`);

  const haveT   = opts.t1 != null || opts.t2 != null;
  const t1      = opts.t1 ?? 0;
  const enc     = new TextEncoder();

  /* Build the output entry list. Each entry is either:
   *   - a passthrough entry (one of the parsed source entries, by reference), or
   *   - a synthetic entry { name, bytes } for rewritten .zarray files. */
  const passthrough = new Set();     /* source entries to copy verbatim */
  const synthetic   = [];            /* { name, bytes, sourceOrder } */
  const renameMap   = new Map();     /* sourceEntry → newName */
  const warnings    = [];

  for (const e of topLevel) passthrough.add(e);

  for (const [name, v] of allVars.entries()) {
    if (!requested.has(name)) continue;

    /* zattrs: always pass through unchanged. */
    if (v.zattrs) passthrough.add(v.zattrs);

    const zarray = JSON.parse(readEntryUtf8(data, v.zarray));
    const zattrs = v.zattrs ? JSON.parse(readEntryUtf8(data, v.zattrs)) : {};
    const sep    = zarray.dimension_separator || '.';
    const chunks = zarray.chunks;
    const shape  = zarray.shape;

    /* No time slice OR shape too odd to slice → keep .zarray + all chunks verbatim. */
    if (!haveT || !Array.isArray(chunks) || !Array.isArray(shape) ||
        chunks.length === 0) {
      passthrough.add(v.zarray);
      for (const c of v.chunks) passthrough.add(c);
      continue;
    }

    const tAxis  = timeAxisIndex(zattrs);
    const tChunk = chunks[tAxis];
    const tLen   = shape[tAxis];
    const t2     = opts.t2 != null ? opts.t2 : (tLen - 1);

    if (t1 >= tLen)
      throw new SlimError(
        `Zarr slim: t1=${t1} >= time axis length (${tLen}) for variable '${name}'`);
    const tLoReq = Math.max(0, t1);
    const tHiReq = Math.min(tLen - 1, t2);

    /* Inclusive chunk-index range along the time axis. */
    const chunkLo = Math.floor(tLoReq / tChunk);
    const chunkHi = Math.floor(tHiReq / tChunk);
    const tEffLo  = chunkLo * tChunk;
    const tEffHi  = Math.min(tLen - 1, (chunkHi + 1) * tChunk - 1);
    if (tEffLo !== tLoReq || tEffHi !== tHiReq) {
      warnings.push(
        `Zarr variable '${name}': time range [${tLoReq},${tHiReq}] widened ` +
        `to [${tEffLo},${tEffHi}] because chunk size along time axis is ${tChunk}`);
    }

    /* Did the time axis actually shrink (any chunk dropped)? */
    const origChunkCount = Math.ceil(tLen / tChunk);
    const keptChunkCount = chunkHi - chunkLo + 1;
    const shrunk = (keptChunkCount < origChunkCount);

    if (!shrunk) {
      /* Range covers every chunk → no rewrite needed. */
      passthrough.add(v.zarray);
      for (const c of v.chunks) passthrough.add(c);
      continue;
    }

    /* Time axis really shrank: emit a rewritten .zarray (new shape) and
     * rename kept chunks so their time index is 0-based in the output. */
    const newTLen   = Math.min(tLen - tEffLo, keptChunkCount * tChunk);
    const newShape  = shape.slice();
    newShape[tAxis] = newTLen;
    const newZarray = { ...zarray, shape: newShape };
    synthetic.push({
      name:  v.zarray.name,
      bytes: enc.encode(JSON.stringify(newZarray)),
      sourceOrder: entries.indexOf(v.zarray),
    });

    for (const c of v.chunks) {
      const subPath = c.name.slice(name.length + 1);
      const idx     = parseChunkKey(subPath, sep);
      if (!idx || idx.length !== chunks.length) continue;
      const ti = idx[tAxis];
      if (ti < chunkLo || ti > chunkHi) continue;

      const newIdx     = idx.slice();
      newIdx[tAxis]    = ti - chunkLo;
      const newSubPath = newIdx.join(sep);
      const newName    = name + '/' + newSubPath;
      if (newName === c.name) {
        passthrough.add(c);
      } else {
        renameMap.set(c, newName);
        passthrough.add(c);                /* still passthrough bytes */
      }
    }
  }

  /* Compose final entry list in stable original CD order. */
  const ordered = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    /* Synthetic entry takes precedence (e.g. rewritten .zarray). */
    const syn = synthetic.find(s => s.sourceOrder === i);
    if (syn) { ordered.push({ name: syn.name, bytes: syn.bytes }); continue; }
    if (!passthrough.has(e)) continue;
    if (renameMap.has(e))
      ordered.push({ ...e, name: renameMap.get(e) });
    else
      ordered.push(e);
  }

  const bytes = writeZip(ordered, data);
  return {
    bytes,
    warnings,
    variablesKept:    requested.size,
    variablesDropped: allVars.size - requested.size,
  };
}
