/*
 * scripts/perf/spike-hdf5-chunkinfo.mjs — Task 1 spike for range-native NetCDF4.
 *
 * Confirms (a) that h5wasm surfaces per-chunk byte offset/size + dataset
 * shape/chunks/dtype/filters, and (b) probes whether h5wasm can read a file
 * through a JS byte-callback (lazy) rather than a full in-memory copy.
 *
 * Run: node scripts/perf/spike-hdf5-chunkinfo.mjs [path-to.nc]
 */
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || 'E:/gldas_50mb.nc';

const mod = await import('h5wasm');
const h5 = mod.default ?? mod;
const { FS } = await h5.ready;

// 1) What chunk/dataset introspection exists on the Dataset prototype?
const dsMethods = Object.getOwnPropertyNames(h5.Dataset.prototype)
  .filter((m) => /chunk|offset|filter|dtype|shape|value|slice|metadata/i.test(m));
console.log('Dataset members:', dsMethods.join(', '));

// 2) Load GLDAS via the in-memory FS and inspect one 3-D dataset.
const bytes = new Uint8Array(readFileSync(FILE));
FS.writeFile('/g.nc', bytes);
const f = new h5.File('/g.nc', 'r');

function firstDataset(group, prefix = '') {
  for (const key of group.keys()) {
    const obj = group.get(key);
    const name = prefix ? `${prefix}/${key}` : key;
    if (obj instanceof h5.Dataset && obj.shape && obj.shape.length >= 3) return { name, ds: obj };
    if (obj instanceof h5.Group) { const r = firstDataset(obj, name); if (r) return r; }
  }
  return null;
}

const found = firstDataset(f);
if (!found) { console.log('NO 3-D dataset found'); f.close(); process.exit(2); }
const { name, ds } = found;
console.log('dataset:', name);
console.log('  shape  :', JSON.stringify(ds.shape));
console.log('  chunks :', JSON.stringify(ds.chunks));
console.log('  dtype  :', JSON.stringify(ds.dtype));
console.log('  filters:', JSON.stringify(ds.filters));
console.log('  metadata:', JSON.stringify(ds.metadata));

// 3) Probe the chunk-info surface (names vary by h5wasm version).
for (const m of ['get_num_chunks', 'get_chunk_info', 'get_chunk_info_by_coord', 'iter_chunks']) {
  const has = typeof ds[m] === 'function';
  console.log(`  has ${m}:`, has);
}
try {
  if (typeof ds.get_num_chunks === 'function') {
    const n = ds.get_num_chunks();
    console.log('  get_num_chunks() =>', n);
    if (typeof ds.get_chunk_info === 'function') {
      console.log('  get_chunk_info(0) =>', JSON.stringify(ds.get_chunk_info(0)));
      console.log('  get_chunk_info(1) =>', JSON.stringify(ds.get_chunk_info(1)));
    }
  }
} catch (e) { console.log('  chunk-info call error:', e.message); }

f.close();

// 4) Probe lazy/custom-VFS read support (the Task-3 crux). Just report what
//    hooks exist; do not implement here.
console.log('FS.createLazyFile:', typeof FS.createLazyFile);
console.log('FS.createDevice  :', typeof FS.createDevice);
console.log('h5.ready keys    :', Object.keys(await h5.ready).join(', '));
