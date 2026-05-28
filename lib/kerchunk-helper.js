/*
 * lib/kerchunk-helper.js — Node-side kerchunk-parquet reader for webparsers.
 *
 * Same scan/normalize shape as lib/zarr-helper.js, but the chunk-byte
 * source is a KerchunkRefStore (reads slices from the original archive
 * files referenced by the parquet bundle) instead of an in-memory zip.
 *
 * Usage (Node ≥18, ESM):
 *
 *   import {
 *     kerchunkScan, scanGetVarsJson, normalize, scanFree,
 *   } from 'webparsers/lib/kerchunk-helper.js';
 *
 *   const sr = await kerchunkScan('./refs.parquet');
 *   const ds = await normalize(sr, 0, wasmModule);
 *   // then wp_query / wp_nt / wp_close as today
 *
 * Supported:
 *   - single-file parquet bundles emitted by scripts/build-kerchunk-fixture.js
 *   - underlying chunks with codecs (null, gzip, zlib, blosc, zstd, lz4)
 *     and the shuffle filter
 *
 * Not supported (clear errors):
 *   - LazyReferenceMapper directory-layout bundles (follow-up adapter)
 *   - HTTPS / S3 refs (Node fs only)
 *   - Zarr v3, big-endian dtypes (inherited from zarr-helper)
 */
import { openRefIndex } from './kerchunk/parquet-refs.js';
import { KerchunkRefStore } from './kerchunk/ref-store.js';
import { resolveCoordRefs } from './zarr/metadata.js';
import { readArrayAsFloat64 } from './zarr/chunk-grid.js';
import { decodeTimes } from './time-decoder.js';

/* Re-export downstream surface unchanged so callers can swap kerchunkScan
 * in place of zarr-helper.scan and use the rest of the pipeline as-is. */
export { scanGetVarsJson, normalize, scanFree } from './zarr-helper.js';

/**
 * Open a kerchunk-parquet ref bundle and return a scanResult shaped
 * identically to zarr-helper.scan()'s return:
 *   { source: ChunkSource, arrays: ArrayInfo[] }
 */
export async function kerchunkScan(parquetPath) {
  const refIndex = await openRefIndex(parquetPath);

  /* Discover arrays by scanning meta keys for .zarray entries. */
  const arrays = [];
  for (const key of refIndex.listMetaKeys()) {
    if (!key.endsWith('/.zarray') && key !== '.zarray') continue;

    const root = key === '.zarray' ? '' : key.slice(0, -'.zarray'.length);
    const metaBytes = refIndex.getMeta(key);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));

    const attrsBytes = refIndex.getMeta(root + '.zattrs');
    const attrs = attrsBytes
      ? JSON.parse(new TextDecoder().decode(attrsBytes))
      : null;

    const name = root.endsWith('/') ? root.slice(0, -1) : (root || '/');
    arrays.push({ name: name || '/', root, meta, attrs });
  }

  if (arrays.length === 0)
    throw new Error('kerchunk-helper: no .zarray entries found in ' + parquetPath);

  for (const a of arrays) {
    if (a.meta.zarr_format !== 2)
      throw new Error('kerchunk-helper: array "' + a.name + '" is zarr_format ' +
        a.meta.zarr_format + ' (only v2 supported)');
  }

  const source = new KerchunkRefStore(refIndex, arrays);
  const scanResult = { source, arrays };

  /* Decode CF times per multi-dim variable. Mirrors lib/zarr-helper.js:scan. */
  scanResult._timesByVar = new Map();
  scanResult._timesWarnings = new Map();
  for (const a of arrays) {
    const shape = (a.meta && a.meta.shape) || [];
    if (shape.length < 3) continue;
    const refs = resolveCoordRefs(scanResult, a);
    if (!refs.timeRef || !refs.timeRef.attrs || !refs.timeRef.attrs.units) continue;
    try {
      const raw = await readArrayAsFloat64(scanResult, refs.timeRef);
      const decoded = decodeTimes(
        raw,
        refs.timeRef.attrs.units,
        refs.timeRef.attrs.calendar || 'standard',
      );
      scanResult._timesByVar.set(a.name, decoded);
    } catch (e) {
      const msg = `Could not decode times for "${a.name}": ${e.message}. ` +
                  `Raw values still available via extract({time: n}).`;
      const list = scanResult._timesWarnings.get(a.name) || [];
      list.push(msg);
      scanResult._timesWarnings.set(a.name, list);
    }
  }

  return scanResult;
}
