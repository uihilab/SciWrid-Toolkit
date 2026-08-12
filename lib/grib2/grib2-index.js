/*
 * lib/grib2/grib2-index.js
 * Header-scan GRIB2 message index. Walks the file reading only each message's
 * header span (Section 0 length + Sections 1/4 for time + variable id), hopping
 * by the Section-0 total length. No .idx sidecar. Message sizes vary, so this is
 * inherently O(N) sequential reads; `limit` supports early-stop.
 */
const HEADER_SPAN = 1024;   // covers Sections 0..4 for the grids we handle

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
function be64(b, o) {                          // total message length (< 2^53 in practice)
  let v = 0; for (let i = 0; i < 8; i++) v = v * 256 + b[o + i]; return v;
}

function sec1Reftime(b, off) {                 // matches C parse_sec1_reftime
  const year = be16(b, off + 12);
  return Math.floor(Date.UTC(year, b[off + 14] - 1, b[off + 15],
                             b[off + 16], b[off + 17], b[off + 18]) / 1000);
}
function sec4Forecast(b, off, len) {           // matches C parse_sec4_forecast_offset
  if (len < 22) return 0;
  const unit = b[off + 17], ft = be32(b, off + 18);
  const mult = unit === 0 ? 60 : unit === 1 ? 3600 : unit === 2 ? 86400 : unit === 13 ? 1 : 3600;
  return ft * mult;
}
/* matches C parse_sec4_interval_end -- template 4.8 only, same field offsets
 * and same validation, so the range path and the whole-file path agree. If
 * these two drift apart the same file reports two different timestamps
 * depending on how it was read. */
function sec4IntervalEnd(b, off, len) {
  if (len < 41) return null;
  if (be16(b, off + 7) !== 8) return null;     // not template 4.8
  const year = be16(b, off + 34);
  const month = b[off + 36], day = b[off + 37];
  const hour = b[off + 38], min = b[off + 39], sec = b[off + 40];
  if (year < 1970 || year > 3000)          return null;
  if (month < 1 || month > 12)             return null;
  if (day < 1 || day > 31)                 return null;
  if (hour > 23 || min > 59 || sec > 60)   return null;
  return Math.floor(Date.UTC(year, month - 1, day, hour, min, sec) / 1000);
}

/* Parse ONE message header span -> its fields, or null if this is not a GRIB2
 * edition-2 message (which ends the walk).
 *
 * Split out so the async walk below and the synchronous whole-buffer walk after
 * it share one parser rather than two copies. sec4IntervalEnd already carries a
 * comment about exactly this hazard: when the range path and the whole-file
 * path parse headers separately they drift, and one file reports two different
 * answers depending on how it was opened. */
function parseMessageHeader(hdr, pos) {
  if (hdr.length < 16 ||
      hdr[0] !== 0x47 || hdr[1] !== 0x52 || hdr[2] !== 0x49 || hdr[3] !== 0x42) return null;  // "GRIB"
  if (hdr[7] !== 2) return null;                // edition 2 only
  const total = be64(hdr, 8);
  if (total < 16) return null;

  let p = 16, sec1 = -1, sec4 = -1, sec4len = 0;
  while (p + 5 <= hdr.length) {
    if (hdr[p] === 0x37 && hdr[p + 1] === 0x37 && hdr[p + 2] === 0x37 && hdr[p + 3] === 0x37) break; // "7777"
    const slen = be32(hdr, p), snum = hdr[p + 4];
    if (snum === 1) sec1 = p;
    if (snum === 4) { sec4 = p; sec4len = slen; }
    if (snum === 7 || slen <= 0) break;         // reached data or malformed
    p += slen;
  }
  let cat = -1, num = -1, time = 0;
  if (sec4 >= 0) { cat = hdr[sec4 + 9]; num = hdr[sec4 + 10]; }
  /* Discipline (Section 0, octet 7) and originating centre (Section 1, octets
   * 6-7) are what turn (cat, num) into a name and a unit: WMO Code Table 4.2 is
   * keyed on discipline too, and numbers 192-254 are reserved for the centre,
   * so the same pair means different things in different files. Both sit in
   * bytes this walk has already read. */
  const discipline = hdr[6];
  const centre = sec1 >= 0 ? be16(hdr, sec1 + 5) : -1;
  const intervalEnd = sec4 >= 0 ? sec4IntervalEnd(hdr, sec4, sec4len) : null;
  if (intervalEnd !== null) time = intervalEnd;
  else if (sec1 >= 0) time = sec1Reftime(hdr, sec1) + (sec4 >= 0 ? sec4Forecast(hdr, sec4, sec4len) : 0);

  return { offset: pos, length: total, discipline, centre, cat, num, time };
}

export async function indexMessages(reader, { limit = Infinity } = {}) {
  const size = await reader.size();
  const messages = [];
  let pos = 0;
  while (pos + 16 <= size && messages.length < limit) {
    const hdr = await reader.read(pos, Math.min(HEADER_SPAN, size - pos));
    const m = parseMessageHeader(hdr, pos);
    if (!m) break;
    messages.push(m);
    pos += m.length;
  }
  return { messages, bytesRead: reader.stats().bytes };
}

/* Adapt an in-memory buffer to the reader interface indexMessages expects.
 *
 * Not used by the library itself -- the whole-file path calls the synchronous
 * walk below. It exists so the two walks can be run over identical bytes and
 * compared, which is how .testkit/test-grib2-params.js proves they have not
 * drifted apart. */
export function bufferReader(bytes) {
  return {
    async size() { return bytes.length; },
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
    stats() { return { requests: 0, bytes: 0 }; },
  };
}

/* Same walk, over bytes already in hand.
 *
 * The whole-file scan path is synchronous and cannot await, but it needs the
 * very fields the range path reads. Rather than give it a second parser, this
 * drives the shared one directly. */
export function indexMessagesSync(bytes, { limit = Infinity } = {}) {
  const messages = [];
  let pos = 0;
  while (pos + 16 <= bytes.length && messages.length < limit) {
    const hdr = bytes.subarray(pos, Math.min(pos + HEADER_SPAN, bytes.length));
    const m = parseMessageHeader(hdr, pos);
    if (!m) break;
    messages.push(m);
    pos += m.length;
  }
  return messages;
}
