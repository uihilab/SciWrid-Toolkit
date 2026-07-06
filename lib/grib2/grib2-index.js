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

export async function indexMessages(reader, { limit = Infinity } = {}) {
  const size = await reader.size();
  const messages = [];
  let pos = 0;
  while (pos + 16 <= size && messages.length < limit) {
    const hdr = await reader.read(pos, Math.min(HEADER_SPAN, size - pos));
    if (hdr.length < 16 ||
        hdr[0] !== 0x47 || hdr[1] !== 0x52 || hdr[2] !== 0x49 || hdr[3] !== 0x42) break;  // "GRIB"
    if (hdr[7] !== 2) break;                    // edition 2 only
    const total = be64(hdr, 8);
    if (total < 16) break;

    let p = 16, sec1 = -1, sec4 = -1, sec4len = 0;
    while (p + 5 <= hdr.length) {
      if (hdr[p] === 0x37 && hdr[p + 1] === 0x37 && hdr[p + 2] === 0x37 && hdr[p + 3] === 0x37) break; // "7777"
      const slen = be32(hdr, p), snum = hdr[p + 4];
      if (snum === 1) sec1 = p;
      if (snum === 4) { sec4 = p; sec4len = slen; }
      if (snum === 7 || slen <= 0) break;       // reached data or malformed
      p += slen;
    }
    let cat = -1, num = -1, time = 0;
    if (sec4 >= 0) { cat = hdr[sec4 + 9]; num = hdr[sec4 + 10]; }
    if (sec1 >= 0) time = sec1Reftime(hdr, sec1) + (sec4 >= 0 ? sec4Forecast(hdr, sec4, sec4len) : 0);

    messages.push({ offset: pos, length: total, cat, num, time });
    pos += total;
  }
  return { messages, bytesRead: reader.stats().bytes };
}
