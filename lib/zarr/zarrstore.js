// lib/zarrstore.mjs
//
// A Zarr v2 array, read one chunk at a time, over whatever holds the keys.
//
// Two backends, one interface. Locally the keys live in a zip; in the cloud
// they are objects behind HTTP. The reducer above this does not care which,
// which is what lets the same code path answer a demo question and a 40 TB one.
//
// Deliberately v2-only for now. Both cloud stores in the catalog turn out to be
// v2 with consolidated metadata despite one of them being named "-v3", so v2 is
// what is actually needed; v3 can follow when a store requires it.

import { openZip } from './zarrzip.js';
import { parseBloscHeader, readOffsets, blocksForRows, byteRange,
  oneBlockFrame, worthBlockReading, canReframe, rowAxisFor } from './blosc-blocks.js';

const BLOSC_PROBE_END = 16 + 4 * 256 - 1;

function readableBloscProbe(info, bytes) {
  const header = parseBloscHeader(bytes);
  if (!header || header.memcpyed || header.nblocks < 2 || header.nblocks > 256
    || bytes.length < 16 + 4 * header.nblocks) return null;
  const { Ctor } = dtypeInfo(info.dtype);
  const itemsize = Ctor.BYTES_PER_ELEMENT;
  if (header.blocksize % itemsize !== 0) return null;
  const offsets = readOffsets(bytes, header.nblocks);
  const tableEnd = 16 + 4 * header.nblocks;
  if (offsets[0] < tableEnd || !offsets.every((o, i) => o < header.cbytes
    && (i === 0 || o > offsets[i - 1]))) return null;
  return { header, offsets, Ctor, itemsize };
}

const DTYPES = {
  f4: Float32Array, f8: Float64Array,
  i1: Int8Array, i2: Int16Array, i4: Int32Array, i8: BigInt64Array,
  u1: Uint8Array, u2: Uint16Array, u4: Uint32Array, u8: BigUint64Array,
};

/** Typed-array constructor for a numpy dtype string, little-endian only. */
export function dtypeInfo(dtype) {
  const m = /^([<>|])?([fiub])(\d+)$/.exec(String(dtype).trim());
  if (!m) throw new Error(`unsupported dtype: ${dtype}`);
  const [, order, kind, width] = m;
  if (order === '>' && Number(width) > 1)
    throw new Error(`big-endian dtype ${dtype} is not supported`);
  const Ctor = DTYPES[kind + width];
  if (!Ctor) throw new Error(`unsupported dtype: ${dtype}`);
  return { Ctor, itemsize: Ctor.BYTES_PER_ELEMENT };
}

let bloscPromise = null;
async function blosc() {
  if (!bloscPromise) bloscPromise = import('numcodecs').then((m) => m.Blosc);
  return bloscPromise;
}

/** Decompress one raw chunk according to the array's declared compressor. */
async function decompress(raw, compressor) {
  if (!compressor) return raw;
  const id = compressor.id;
  if (id === 'blosc') {
    const Blosc = await blosc();
    return new Uint8Array(await Blosc.fromConfig(compressor).decode(raw));
  }
  const mod = await import('numcodecs');
  const Codec = { zlib: mod.Zlib, gzip: mod.GZip, zstd: mod.Zstd, lz4: mod.LZ4 }[id];
  if (!Codec) throw new Error(`unsupported Zarr compressor: ${id}`);
  return new Uint8Array(await Codec.fromConfig(compressor).decode(raw));
}

/* ── key backends ─────────────────────────────────────────────────────────── */

function zipBackend(bytes) {
  const zip = openZip(bytes);
  return {
    kind: 'local',
    async getJSON(key) {
      const e = zip.read(key);
      return e ? JSON.parse(new TextDecoder().decode(e.bytes)) : null;
    },
    async get(key) { return zip.read(key); },
    async size(key) { return zip.size(key); },
  };
}

/** gs:// and s3:// are addressable over plain HTTPS; nothing else is. */
export function httpUrlFor(base) {
  if (/^https?:\/\//i.test(base)) return base.replace(/\/$/, '');
  let m = /^gs:\/\/(.+)$/.exec(base);
  if (m) return `https://storage.googleapis.com/${m[1]}`.replace(/\/$/, '');
  m = /^s3:\/\/([^/]+)\/(.*)$/.exec(base);
  if (m) return `https://${m[1]}.s3.amazonaws.com/${m[2]}`.replace(/\/$/, '');
  throw new Error(`unsupported store URL scheme: ${base}`);
}

function httpBackend(url, { fetchImpl = globalThis.fetch } = {}) {
  const base = httpUrlFor(url);
  /* A decode thread reopens a store from its address, which only works when
     nothing process-local is in play. An injected fetch is exactly that, so a
     store built on one declines to advertise an address and the reader folds
     inline -- the same rule the GRIB2 pool applies at grib2-file.mjs. */
  const threadable = fetchImpl === globalThis.fetch;
  /* Consolidated metadata: one request for every .zarray and .zattrs in the
     store, instead of one per array. Without it a store this wide would cost
     hundreds of round trips before a single value was read. */
  let consolidated = null;

  async function loadConsolidated() {
    if (consolidated !== null) return consolidated;
    const r = await fetchImpl(`${base}/.zmetadata`);
    consolidated = r.ok ? (await r.json()).metadata ?? {} : {};
    return consolidated;
  }

  return {
    kind: 'url',
    /* The address a decode thread can reopen this store from. A zip-backed
       store has none -- its bytes are already in this process -- which is why
       lib/reduce.mjs threads only when this is set. */
    url: threadable ? base : null,
    async getJSON(key) {
      const c = await loadConsolidated();
      if (key in c) return c[key];
      const r = await fetchImpl(`${base}/${key}`);
      return r.ok ? await r.json() : null;
    },
    async get(key) {
      const r = await fetchImpl(`${base}/${key}`);
      /* 404 on a chunk key is not a failure: Zarr does not write chunks that
         are entirely fill_value. */
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`fetching ${key}: HTTP ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { bytes: buf, compressedLength: buf.length };
    },
    async range(key, from, to) {
      const r = await fetchImpl(`${base}/${key}`, {
        headers: { Range: `bytes=${from}-${to}` },
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`fetching ${key}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { bytes, compressedLength: bytes.length, partial: r.status === 206 };
    },

    /* HEAD returns Content-Length without the body, so asking what a chunk
       costs is a round trip, not a download. */
    async size(key) {
      const r = await fetchImpl(`${base}/${key}`, { method: 'HEAD' });
      if (r.status === 404) return 0;      /* unwritten chunk: nothing to fetch */
      if (!r.ok) return null;
      const len = r.headers.get('content-length');
      return len === null ? null : Number(len);
    },
  };
}

/* ── the store ────────────────────────────────────────────────────────────── */

/**
 * @param source Uint8Array of a zipped store, or a gs://, s3:// or https:// URL.
 */
export function openStore(source, opts = {}) {
  const backend = source instanceof Uint8Array
    ? zipBackend(source)
    : httpBackend(String(source), opts);

  const metaCache = new Map();

  function canProbeBlocks(info) {
    const n = info.chunks.length;
    return info.compressor?.id === 'blosc'
      && rowAxisFor({ chunks: info.chunks, axes: { y: n - 2, x: n - 1 } }) !== null
      && typeof backend.range === 'function';
  }

  async function meta(name) {
    if (metaCache.has(name)) return metaCache.get(name);
    const zarray = await backend.getJSON(`${name}/.zarray`);
    if (!zarray) throw new Error(`array "${name}" is not in this store`);
    const zattrs = (await backend.getJSON(`${name}/.zattrs`)) ?? {};
    const info = {
      name,
      shape: zarray.shape,
      chunks: zarray.chunks,
      dtype: zarray.dtype,
      fillValue: zarray.fill_value,
      compressor: zarray.compressor,
      filters: zarray.filters,
      order: zarray.order ?? 'C',
      separator: zarray.dimension_separator ?? '.',
      attrs: zattrs,
    };
    if (info.order !== 'C')
      throw new Error(`array "${name}" is Fortran-ordered; only C order is supported`);
    if (info.filters && info.filters.length)
      throw new Error(`array "${name}" uses filters, which are not supported yet`);
    metaCache.set(name, info);
    return info;
  }

  return {
    kind: backend.kind,
    url: backend.url ?? null,
    meta,

    /** The measured Blosc layout of one chunk, or no block-read candidate. */
    async blockLayout(info, idx) {
      if (!canProbeBlocks(info)) return null;
      const key = `${info.name}/${idx.join(info.separator)}`;
      try {
        const probe = await backend.range(key, 0, BLOSC_PROBE_END);
        return probe?.partial ? readableBloscProbe(info, probe.bytes)?.header ?? null : null;
      } catch { return null; }
    },

    /**
     * One decoded chunk, or null when the chunk was never written.
     * `compressedLength` is measured, not estimated -- this is where the
     * EXPLAIN card's download figure stops being a guess.
     */
    async chunk(info, idx, opts = {}) {
      const key = `${info.name}/${idx.join(info.separator)}`;
      let raw = null;
      let downloaded = 0;
      /* Round trips actually made, not chunks touched. A block read costs two
         -- the header probe and the block run -- and budget.mjs turns this
         count into a time estimate, so reporting one would price a block read
         as if the probe were free. lib/sources/tiff-file.mjs counts the same
         way for the same reason. */
      let requests = 0;
      if (opts.rows && canProbeBlocks(info)) {
        try {
          requests++;
          const probe = await backend.range(key, 0, BLOSC_PROBE_END);
          if (!probe) return null;
          downloaded += probe.compressedLength;
          if (!probe.partial) raw = probe;
          else {
            const layout = readableBloscProbe(info, probe.bytes);
            if (layout) {
              const { header, offsets, Ctor, itemsize } = layout;
              const rowBytes = info.chunks.at(-1) * itemsize;
              const { first, last } = blocksForRows({ ...opts.rows, rowBytes,
                blocksize: header.blocksize, nblocks: header.nblocks });
              if (Number.isInteger(opts.rows.y0) && Number.isInteger(opts.rows.y1)
                && worthBlockReading({ header, first, last })
                && canReframe({ header, first, last })) {
                const { from, to } = byteRange(offsets, first, last, header.cbytes);
                requests++;
                const run = await backend.range(key, from, to);
                if (!run) return null;
                downloaded += run.compressedLength;
                if (!run.partial) raw = run;
                else if (run.bytes.length === to - from + 1) {
                  const frame = oneBlockFrame({ header, blocks: run.bytes,
                    first, last,
                    offsets: offsets.slice(first, last + 1).map((o) => o - from) });
                  const bytes = await decompress(frame, info.compressor);
                  const values = new Ctor(bytes.buffer, bytes.byteOffset,
                    Math.floor(bytes.byteLength / itemsize));
                  return { values, compressedLength: downloaded, requests,
                    valueOffset: first * header.blocksize / itemsize };
                }
              }
            }
          }
        } catch { /* Any uncertain range read takes the whole-chunk path. */ }
      }
      if (!raw) {
        requests++;
        raw = await backend.get(key);
        if (raw) downloaded += raw.compressedLength;
      }
      if (!raw) return null;
      const bytes = await decompress(raw.bytes, info.compressor);
      const { Ctor } = dtypeInfo(info.dtype);
      const values = new Ctor(bytes.buffer, bytes.byteOffset,
        Math.floor(bytes.byteLength / Ctor.BYTES_PER_ELEMENT));
      return { values, compressedLength: downloaded, requests, valueOffset: 0 };
    },

    /** Compressed bytes for one chunk, without transferring it. */
    async chunkSize(info, idx) {
      return backend.size(`${info.name}/${idx.join(info.separator)}`);
    },

    /** A whole 1-D coordinate array, as Float64. These are small by design. */
    async coord(name) {
      const info = await meta(name);
      if (info.shape.length !== 1)
        throw new Error(`coordinate "${name}" is not 1-D`);
      const out = new Float64Array(info.shape[0]);
      const [n] = info.shape, [c] = info.chunks;
      for (let ci = 0; ci * c < n; ci++) {
        const ch = await this.chunk(info, [ci]);
        for (let i = 0; i < c && ci * c + i < n; i++)
          out[ci * c + i] = ch ? Number(ch.values[i]) : NaN;
      }
      return { values: out, attrs: info.attrs };
    },
  };
}

/**
 * Everything a store advertises about itself, in one request.
 *
 * Used to judge a candidate store before it goes in the catalog: what arrays
 * it holds, how they are chunked, whether they carry units. Consolidated
 * metadata is required -- a store without it would cost one request per array
 * to answer the same question, and a store that expensive to interrogate is
 * not one worth cataloguing.
 *
 * @returns {{ url, arrays: Array<{ name, meta, attrs }> }}
 */
export async function openRemoteZarr(url, { fetchImpl = globalThis.fetch } = {}) {
  const base = httpUrlFor(url);
  const r = await fetchImpl(`${base}/.zmetadata`);
  if (!r.ok)
    throw new Error(`no consolidated metadata (.zmetadata): HTTP ${r.status}`);

  const meta = (await r.json()).metadata ?? {};
  const arrays = [];
  for (const key of Object.keys(meta)) {
    if (!key.endsWith('/.zarray')) continue;
    const name = key.slice(0, -'/.zarray'.length);
    arrays.push({ name, meta: meta[key], attrs: meta[`${name}/.zattrs`] ?? {} });
  }
  if (arrays.length === 0) throw new Error('consolidated metadata lists no arrays');

  return { url, base, arrays };
}

/* ── CF time ──────────────────────────────────────────────────────────────── */

const UNIT_MS = {
  day: 86400000, days: 86400000, hour: 3600000, hours: 3600000,
  minute: 60000, minutes: 60000, second: 1000, seconds: 1000,
  millisecond: 1, milliseconds: 1,
};

/**
 * Decode a CF time axis to epoch milliseconds.
 *
 * Only the real-world calendars. A 360-day calendar would silently produce
 * dates that do not exist, so it is refused rather than approximated.
 */
export function decodeTime(values, attrs) {
  const units = String(attrs?.units ?? '');
  const m = /^(\w+)\s+since\s+(.+)$/i.exec(units.trim());
  if (!m) throw new Error(`cannot decode time units: ${units || '(absent)'}`);
  const step = UNIT_MS[m[1].toLowerCase()];
  if (!step) throw new Error(`unsupported time unit: ${m[1]}`);

  const cal = String(attrs.calendar ?? 'standard').toLowerCase();
  if (!['standard', 'gregorian', 'proleptic_gregorian'].includes(cal))
    throw new Error(`unsupported calendar "${cal}": dates would not be real dates`);

  let iso = m[2].trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const base = Date.parse(iso);
  if (Number.isNaN(base)) throw new Error(`cannot parse time origin: ${m[2]}`);

  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = base + Number(values[i]) * step;
  return out;
}
