/*
 * lib/kerchunk-helper.js - kerchunk-parquet reader for SciWrid Toolkit.
 *
 * Produces the same scanResult shape as lib/zarr-helper.js so the downstream
 * scanGetVarsJson / normalize / scanFree surface is shared.
 */

import { openRefIndex, openRefIndexFromBuffer } from './kerchunk/parquet-refs.js';
import { KerchunkRefStore } from './kerchunk/ref-store.js';
import { RemoteKerchunkRefStore } from './sources/remote-ref-store.js';
import { translateUrl } from './sources/range-fetcher.js';
import { resolveCoordRefs } from './zarr/metadata.js';
import { readArrayAsFloat64 } from './zarr/chunk-grid.js';
import { decodeTimes } from './time-decoder.js';

export { scanGetVarsJson, normalize, scanFree } from './zarr-helper.js';

function _discoverArrays(refIndex, label) {
  const arrays = [];
  for (const key of refIndex.listMetaKeys()) {
    if (!key.endsWith('/.zarray') && key !== '.zarray') continue;

    const root = key === '.zarray' ? '' : key.slice(0, -'.zarray'.length);
    const meta = JSON.parse(new TextDecoder().decode(refIndex.getMeta(key)));
    const attrsBytes = refIndex.getMeta(root + '.zattrs');
    const attrs = attrsBytes ? JSON.parse(new TextDecoder().decode(attrsBytes)) : null;
    const name = root.endsWith('/') ? root.slice(0, -1) : (root || '/');
    arrays.push({ name: name || '/', root, meta, attrs });
  }

  if (arrays.length === 0)
    throw new Error('kerchunk-helper: no .zarray entries found in ' + label);

  for (const a of arrays) {
    if (a.meta.zarr_format !== 2) {
      throw new Error('kerchunk-helper: array "' + a.name + '" is zarr_format ' +
        a.meta.zarr_format + ' (only v2 supported)');
    }
  }
  return arrays;
}

async function _finishScan(scanResult) {
  scanResult._timesByVar = new Map();
  scanResult._timesWarnings = new Map();
  for (const a of scanResult.arrays) {
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

export async function kerchunkScan(parquetPath) {
  const refIndex = await openRefIndex(parquetPath);
  const arrays = _discoverArrays(refIndex, parquetPath);
  const source = new KerchunkRefStore(refIndex, arrays);
  return _finishScan({ source, arrays });
}

export async function kerchunkScanRemote(parquetUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function')
    throw new Error('kerchunk-helper: no fetch available; pass opts.fetchImpl in this runtime');

  const url = translateUrl(parquetUrl);
  const res = await fetchImpl(url);
  if (!res.ok)
    throw new Error('kerchunk-helper: failed to fetch parquet ' + url + ': ' + res.status);

  const buf = new Uint8Array(await res.arrayBuffer());
  const refIndex = await openRefIndexFromBuffer(buf, url);
  const arrays = _discoverArrays(refIndex, parquetUrl);
  const source = new RemoteKerchunkRefStore(refIndex, arrays, {
    cache: opts.cache,
    fetchImpl: opts.fetchImpl,
  });
  return _finishScan({ source, arrays });
}
