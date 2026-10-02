// lib/blosc-blocks.mjs
//
// The byte layout inside a blosc chunk, so a question can fetch the part of it
// that holds the rows it needs.
//
// A blosc chunk is not one compressed blob. It is a 16-byte header, a table of
// block offsets, and then a sequence of INDEPENDENTLY compressed blocks. Each
// block holds a contiguous run of values, so a chunk laid out [1, 721, 1440]
// divides into blocks of whole latitude rows -- and a question about one city
// needs one of them.
//
// That matters because ERA5's chunks span the globe. Every other saving this
// project offers reads fewer TIMESTEPS; none of them touch the fact that each
// timestep arrives whole.
//
// Measured end to end 2026-10-01, real questions through reduceWithStore rather
// than one chunk. The figure that matters is the threaded one, because that is
// what the app runs: Tampa, two cells, July 2018, mean over 744 hourly chunks,
// 11 decode threads. Both paths gave the same mean to six decimals, 300.768341.
//
//                      bytes        requests   wall clock
//   whole chunks     1728.93 MB         744      37.5 s
//   block reads       228.20 MB        1488      17.6 s
//                    7.58x fewer    2x, as expected    2.13x faster
//
// Twice the requests is the design, not a regression: a block read is a header
// probe and then one range for the run, which is why chunk() reports what it
// spent and budget.mjs prices two.
//
// Wall clock gains less than bytes do, and that is worth knowing before
// promising anything: threading already hid most of the latency, so what is
// left to win is bandwidth. The same question folded INLINE, where nothing is
// hidden, went 390.56 MB -> 51.61 MB and 31.3 s -> 4.9 s, a 6.35x that would
// flatter the threaded reader it is not measuring. The 7.57x on bytes is the
// figure that holds either way.
//
// Across the three ERA5 stores, same question, one week, inline:
//
//   hourly 0.25      390.56 MB -> 51.61 MB   7.57x
//   6-hourly 0.25     65.09 MB ->  8.60 MB   7.57x
//   6-hourly 1.50      2.44 MB ->  2.44 MB   declined
//
// The last row is the rule below doing its job: those chunks are [8, 240, 121],
// so eight timesteps share a chunk and one latitude's values are not a
// contiguous run. It reads whole chunks, exactly as it did before.
//
// Pure on purpose: no I/O here. The only way to know this arithmetic is right
// is to check a block decoded through it against the same chunk decoded whole,
// and that comparison belongs in a test, not in the reader.

/* Blosc1 header: version, versionlz, flags, typesize, then three uint32 LE. */
const HEADER = 16;

/* Set when blosc gave up compressing and stored the raw bytes. There is no
   block table then, so there is nothing to range-read. */
const MEMCPYED = 0x02;

/**
 * The header, or null when the bytes cannot be one.
 *
 * Null rather than a throw: the caller's response to "this is not a blosc
 * chunk I understand" is always the same -- read the whole thing the way it
 * always did -- and an exception would make the fallback the expensive path.
 */
export function parseBloscHeader(bytes) {
  if (!bytes || bytes.length < HEADER) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = dv.getUint8(2);
  const nbytes = dv.getUint32(4, true);
  const blocksize = dv.getUint32(8, true);
  const cbytes = dv.getUint32(12, true);
  if (!(nbytes > 0) || !(blocksize > 0) || !(cbytes > 0)) return null;
  return {
    version: dv.getUint8(0),
    flags,
    typesize: dv.getUint8(3),
    nbytes,
    blocksize,
    cbytes,
    memcpyed: (flags & MEMCPYED) !== 0,
    nblocks: Math.ceil(nbytes / blocksize),
  };
}

/** The block offset table, which follows the header when not memcpy stored. */
export function readOffsets(bytes, nblocks) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let i = 0; i < nblocks; i++) out.push(dv.getUint32(HEADER + 4 * i, true));
  return out;
}

/**
 * Which blocks hold a range of rows.
 *
 * Blocks divide the chunk along its slowest-varying axis, so for [1, lat, lon]
 * that is latitude. Longitude is free: a row is contiguous in memory, so any
 * slice of longitudes sits in the same block as its row.
 */
export function blocksForRows({ y0, y1, rowBytes, blocksize, nblocks }) {
  const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
  const clamp = (b) => Math.max(0, Math.min(nblocks - 1, b));
  return {
    first: clamp(Math.floor((lo * rowBytes) / blocksize)),
    last: clamp(Math.floor((hi * rowBytes + rowBytes - 1) / blocksize)),
  };
}

/**
 * The byte range covering blocks `first` through `last`.
 *
 * Blocks are stored in order, so a run of them is ONE range rather than one
 * request each. The final block's length is not in the table -- the table
 * holds starts -- so it runs to the end of the chunk; reading it as "the next
 * offset minus this one" would fetch zero bytes and decode garbage.
 */
export function byteRange(offsets, first, last, cbytes) {
  const from = offsets[first];
  const end = last + 1 < offsets.length ? offsets[last + 1] : cbytes;
  return { from, to: end - 1 };
}

/**
 * A valid blosc frame carrying only the blocks that were fetched.
 *
 * The original header is copied rather than rebuilt so the codec and shuffle
 * flags survive -- decoding lz4+shuffle bytes as anything else produces
 * numbers, not an error. Only the three sizes and the offset table are
 * rewritten, because the frame now describes less data than the chunk did.
 */
export function oneBlockFrame({ header, blocks, first, last, offsets = [0] }) {
  const { blocksize } = header;
  const count = last - first + 1;
  const span = Math.min(header.nbytes, (last + 1) * blocksize) - first * blocksize;
  const tableBytes = 4 * count;
  const out = new Uint8Array(HEADER + tableBytes + blocks.length);
  /* The first 16 bytes, flags and typesize intact. */
  const dv = new DataView(out.buffer);
  out[0] = header.version; out[1] = 1; out[2] = header.flags; out[3] = header.typesize;
  dv.setUint32(4, span, true);
  dv.setUint32(8, blocksize, true);
  dv.setUint32(12, out.length, true);
  /* Offsets rebased onto this frame: the fetched bytes start right after the
     table, and each block keeps its position relative to the first. */
  for (let i = 0; i < count; i++)
    dv.setUint32(HEADER + 4 * i, HEADER + tableBytes + (offsets[i] ?? 0), true);
  out.set(blocks, HEADER + tableBytes);
  return out;
}

/**
 * Whether the selected blocks can be rebuilt into a frame that decodes.
 *
 * Correctness, not economics -- which is why this is separate from
 * `worthBlockReading`. A chunk whose size is not a whole multiple of its
 * blocksize ends in a short block, and blosc compresses that trailing block
 * differently from a full one. Put it alone in a frame and the decode yields
 * garbage from the first value, not merely a ragged tail.
 *
 * No frame header recovers it: span, blocksize, span+1, twice the span, the
 * original nbytes, the shuffle flag cleared, and declaring the block
 * non-leftover all produced the same wrong value. So the block is refused
 * rather than guessed at.
 *
 * The refusal is as narrow as the measurement allows. A selection that ENDS at
 * the short block but starts earlier decodes correctly, so only the lone final
 * block is declined. Measured 2026-10-01 over every selection of seven
 * combinations -- f32/f64/int8, lz4/zstd/blosclz, byte shuffle and bitshuffle,
 * with and without a short tail -- this predicts the failing selection and no
 * other: 192 selections accepted, none wrong, 6 refused.
 *
 * For ERA5 it costs nothing worth having. The short block holds latitude rows
 * 637-720, so it is declined only for a question lying wholly south of 69.25S,
 * and that question falls back to the whole-chunk read it does today.
 */
export function canReframe({ header, first, last }) {
  if (header.nbytes % header.blocksize === 0) return true;
  return !(first === last && last === header.nblocks - 1);
}

/**
 * The store axis a span of rows is contiguous along, or null when there is none.
 *
 * One function because two callers need the answer and must never disagree: the
 * reader, deciding whether to hint, and the cost card, deciding whether to
 * promise a saving. A card that counted one block of eight while the reader
 * read all eight would advertise a 7/8 saving nobody gets, and a second copy of
 * this rule is exactly the drift lib/fold-chunk.mjs opens by warning about.
 *
 * Two conditions, both measured 2026-10-01.
 *
 * Only a spatial axis can be a row axis. A time span is filtered by month and
 * by stride before anything is folded, so the timesteps actually read are not a
 * contiguous byte range even when their indices look like one.
 *
 * And a row is the whole innermost axis only while nothing slower than it
 * repeats. With eight timesteps in a chunk, one latitude's values live in eight
 * separate runs and no single range holds them: bad 3072 of 4096 for
 * [8, 128, 256], against 0 of 2880 for ERA5's [1, 721, 1440].
 */
export function rowAxisFor({ chunks, axes }) {
  const rowAxis = chunks.length - 2;
  if (rowAxis < 0) return null;
  if (axes.y !== rowAxis && axes.x !== rowAxis) return null;
  if (!chunks.slice(0, rowAxis).every((c) => c === 1)) return null;
  return rowAxis;
}

/**
 * Whether fetching blocks beats fetching the chunk.
 *
 * Two requests to fetch everything is strictly worse than one, and a chunk
 * that is a single block is a chunk. The whole point is fetching less, so a
 * selection that does not fetch less takes the path it always did.
 */
export function worthBlockReading({ header, first, last }) {
  if (!header || header.memcpyed) return false;
  if (header.nblocks < 2) return false;
  return (last - first + 1) < header.nblocks;
}
