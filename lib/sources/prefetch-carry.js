/*
 * lib/sources/prefetch-carry.js — hand a declined range path's bytes to the
 * whole-file fallback instead of throwing them away.
 *
 * THE PROBLEM
 *
 * A range fast path is speculative. It reads a front region of the file, tries
 * to parse the metadata there, and gives up if it cannot. Giving up used to
 * cost the caller everything it had already read: the fallback called fetch(url)
 * and started again at byte zero, so the front region was paid for twice.
 *
 * That is the shared root cause behind both measured overspends. On a 32.2 MB
 * GOES-18 file whose HDF5 metadata jsfive cannot parse at any size, the grow
 * loop spent 16.78 MB discovering that, then the fallback moved 32.22 MB, for
 * 49.00 MB -- 152.1% of a file the whole-file path answers at 100%. The gates
 * added afterwards (unprofitableBeforeRead, and METADATA_BUDGET capping the
 * grow loop) bounded the overspend but did not remove it: they made the
 * speculative read smaller, not reusable.
 *
 * THE CARRY
 *
 * A carry is one object threaded through a single extract() call. The range
 * path drops its front bytes into it on the way out; resolveSource() picks
 * them up and asks the server only for what is missing. Worst case becomes one
 * whole file -- the same as never having tried the range path -- rather than
 * the file plus whatever the attempt cost.
 *
 * It is deliberately per-call, not a module-level cache: nothing here survives
 * the call that created it, so there is no shared state to invalidate and no
 * way for one request's bytes to reach another's.
 *
 * WHAT MAKES IT SAFE TO SPLICE
 *
 * Stitching a fresh tail onto an older head is only sound if both halves come
 * from the same file. Two independent guards, both cheap:
 *
 *   - the URL must match exactly, before any translation, and
 *   - the tail request must return 206 with EXACTLY the expected byte count.
 *
 * The second is what catches a file that changed underneath us. If the object
 * was replaced between the head read and the tail read, its length almost
 * certainly differs, the 206 is short or long, and the splice is abandoned for
 * a clean whole-file fetch. A same-length replacement would slip through, and
 * no header a browser is allowed to read would catch it -- ETag and
 * Content-Range are not CORS-safelisted, which is the same constraint that
 * shapes remoteSize(). The window is one HTTP round trip inside a single call.
 *
 * Anything unexpected -- no carry, a different URL, a server that ignores
 * Range, a short read -- returns null, and the caller does exactly what it did
 * before this module existed.
 */
import { fetchRange } from './range-fetcher.js';

/** A fresh, empty carry. One per extract()/extractGrid() call. */
export function createCarry() {
  return { url: null, bytes: null, size: 0 };
}

/**
 * recordCarry(carry, url, bytes, size)
 *
 * Called by a range path that is about to decline. `bytes` must be the file's
 * bytes starting at offset 0 -- a prefix, not an arbitrary window, because the
 * fallback splices a tail onto it. `size` is the total object size the range
 * path already learned from its HEAD.
 *
 * Keeps the LONGEST prefix seen. extract() runs more than one range path over
 * the same source, and the second must not shorten what the first banked.
 */
export function recordCarry(carry, url, bytes, size) {
  if (!carry || !bytes || !bytes.length) return;
  if (!Number.isFinite(size) || size <= 0) return;
  if (bytes.length > size) return;                 // not a prefix of this file
  if (carry.url === url && carry.bytes && carry.bytes.length >= bytes.length) return;
  carry.url = url;
  carry.bytes = bytes;
  carry.size = size;
}

/**
 * completeFromCarry(carry, url, fetchImpl) -> Uint8Array | null
 *
 * The whole file, assembled from the carried prefix plus one Range request for
 * the remainder. null means "no usable carry" and the caller should fetch
 * normally -- never a partial or stitched-from-mismatched-halves buffer.
 */
export async function completeFromCarry(carry, url, fetchImpl = globalThis.fetch) {
  if (!carry || !carry.bytes || carry.url !== url) return null;
  const have = carry.bytes.length;
  const { size } = carry;
  if (have >= size) return carry.bytes.subarray(0, size);   // whole file already read

  let tail;
  try {
    /* fetchRange demands a 206 and an exact length, which is precisely the
     * validation this splice needs; a server that ignores Range, or a file
     * whose length moved, throws here and we fall through to null. */
    tail = await fetchRange(url, have, size - have, fetchImpl);
  } catch (_) {
    return null;
  }

  const out = new Uint8Array(size);
  out.set(carry.bytes, 0);
  out.set(tail, have);
  return out;
}
