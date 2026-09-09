/*
 * lib/encode/grib2.js — write a Dataset as a single-message GRIB2 file.
 *
 * Grids only. A station time series is not a raster, so the registry marks
 * grib2 series:false and encodeSeries never reaches this file.
 *
 * Sections written, in order:
 *   0  indicator            'GRIB', discipline, edition 2, total length
 *   1  identification       reference time, centre, production status
 *   3  grid definition      template 3.0, regular lat/lon
 *   4  product definition   template 4.0, horizontal layer at one time
 *   5  data representation  template 5.0, simple packing
 *   6  bit map              only when the grid has missing values
 *   7  data                 the packed values
 *   8  end                  '7777'
 *
 * PARAMETERS. GRIB2 has no free-text variable name: a field is identified by
 * the triple (discipline, category, number) against the WMO code tables. The
 * Dataset carries a name, which cannot be translated without a reverse table,
 * so the caller supplies the triple:
 *
 *     encodeGrid(grid, 'grib2', { grib2: { discipline: 0, category: 1, number: 8 } })
 *
 * Without it the parameter is written as MISSING (category 255, number 255)
 * rather than mislabelled as some other quantity. The values, the grid and
 * the time are still exact; only the parameter identity is absent.
 *
 * SCANNING MODE is 0: west→east, north→south, which is the same order the
 * common grid model uses (row 0 at maxLat), so no row flip is needed. La1 is
 * the centre of the first cell, matching the Dataset's cell-centre
 * coordinates.
 *
 * Field offsets follow the production reader in helper/grib2converthelpers.c
 * (Ni at +30, La1 at +46, Di at +63, scanning mode at +71 of section 3;
 * section 5's R/E/D/bits at +11/+15/+17/+19). Note that the offsets in
 * formats/grib2/grib2.c differ — that file is the vestigial native-harness
 * decoder, not the path this library reads with.
 */
import { UnsupportedExportError } from './errors.js';

const BITS = 24;                 /* enough that packing error stays far below
                                    the 1e-5 relative tolerance we test at */
const MISSING_U8  = 0xFF;
const MISSING_U32 = 0xFFFFFFFF;

/* Pack unsigned integers of `bits` width, MSB-first, exactly as the decoder's
 * extract_bits reads them. */
function packBits(values, bits) {
  const out = new Uint8Array(Math.ceil((values.length * bits) / 8));
  let bitPos = 0;
  for (const v of values) {
    for (let b = bits - 1; b >= 0; b--) {
      if ((v >>> b) & 1) out[bitPos >> 3] |= 0x80 >> (bitPos & 7);
      bitPos++;
    }
  }
  return out;
}

/* µdegrees, the unit every lat/lon field in template 3.0 uses. */
const micro = (deg) => Math.round(deg * 1e6);

/* GRIB2 signed integers are SIGN-MAGNITUDE, not two's complement: the high
 * bit is the sign and the rest is the magnitude (see grib2_i16/grib2_i32 in
 * helper/grib2converthelpers.h). Writing two's complement here decodes as a
 * huge negative scale factor and collapses every value to the reference. */
function setSignMag16(dv, off, v) {
  const m = Math.abs(v) & 0x7FFF;
  dv.setUint16(off, v < 0 ? (0x8000 | m) : m, false);
}
function setSignMag32(dv, off, v) {
  const m = Math.abs(v) >>> 0 & 0x7FFFFFFF;
  dv.setUint32(off, (v < 0 ? (0x80000000 | m) : m) >>> 0, false);
}

export function encodeDatasetGRIB2(dataset, opts = {}) {
  if (dataset.kind !== 'grid')
    throw new UnsupportedExportError(
      'GRIB2 can only represent a grid. Use netcdf3, netcdf4, zarr, json or csv for a series.');
  if (dataset.vars.length !== 1)
    throw new UnsupportedExportError(
      `GRIB2 writes one field per message; this dataset has ${dataset.vars.length} variables.`);

  const p = opts.grib2 ?? {};
  const discipline = p.discipline ?? 0;
  const category   = p.category ?? MISSING_U8;
  const number     = p.number ?? MISSING_U8;

  const { lat, lon } = dataset.coords;
  const ny = dataset.dims.lat, nx = dataset.dims.lon;
  const data = dataset.vars[0].data;
  const nPts = nx * ny;

  /* increments are positive magnitudes; direction lives in the scanning mode */
  const di = nx > 1 ? Math.abs(lon[1] - lon[0]) : 0;
  const dj = ny > 1 ? Math.abs(lat[0] - lat[1]) : 0;
  /* GRIB2 longitudes run 0..360 */
  const lon360 = (d) => ((d % 360) + 360) % 360;

  /* ---- packing ---------------------------------------------------------- */
  const present = [];
  for (let i = 0; i < nPts; i++) if (Number.isFinite(data[i])) present.push(data[i]);
  const hasMissing = present.length !== nPts;

  let ref = 0, binScale = 0, raws = [];
  if (present.length) {
    let min = Infinity, max = -Infinity;
    for (const v of present) { if (v < min) min = v; if (v > max) max = v; }
    /* R is stored as an IEEE float32, so round it to one before deriving the
     * integers — otherwise the decoder subtracts a slightly different R. */
    ref = Math.fround(min);
    const span = max - ref;
    const levels = Math.pow(2, BITS) - 1;
    binScale = span > 0 ? Math.ceil(Math.log2(span / levels)) : 0;
    const step = Math.pow(2, binScale);
    raws = present.map((v) => {
      const raw = Math.round((v - ref) / step);
      return raw < 0 ? 0 : (raw > levels ? levels : raw);
    });
  }
  const packed = raws.length ? packBits(raws, BITS) : new Uint8Array(0);

  /* ---- sections --------------------------------------------------------- */
  const secs = [];
  const push = (buf) => secs.push(buf);

  /* section 1 — identification */
  const s1 = new Uint8Array(21);
  const d1 = new DataView(s1.buffer);
  d1.setUint32(0, 21, false); s1[4] = 1;
  d1.setUint16(5, 0, false);            /* centre 0 (WMO "reserved") */
  d1.setUint16(7, 0, false);            /* subcentre */
  s1[9]  = 2;                           /* GRIB master tables version */
  s1[10] = 0;                           /* local tables version */
  s1[11] = 1;                           /* significance of reference time: start of forecast */
  const t = dataset.attrs.time_coverage_start
    ? new Date(dataset.attrs.time_coverage_start)
    : new Date(0);
  const when = Number.isFinite(t.getTime()) ? t : new Date(0);
  d1.setUint16(12, when.getUTCFullYear(), false);
  s1[14] = when.getUTCMonth() + 1;
  s1[15] = when.getUTCDate();
  s1[16] = when.getUTCHours();
  s1[17] = when.getUTCMinutes();
  s1[18] = when.getUTCSeconds();
  s1[19] = 2;                           /* production status: research */
  s1[20] = 0;                           /* type of data: analysis */
  push(s1);

  /* section 3 — grid definition, template 3.0 */
  const s3 = new Uint8Array(72);
  const d3 = new DataView(s3.buffer);
  d3.setUint32(0, 72, false); s3[4] = 3;
  s3[5] = 0;                            /* grid defined by template */
  d3.setUint32(6, nPts, false);
  s3[10] = 0; s3[11] = 0;               /* no optional point list */
  d3.setUint16(12, 0, false);           /* template 3.0 */
  s3[14] = 6;                           /* spherical earth, radius 6 371 229 m */
  s3[15] = 0; d3.setUint32(16, 0, false);
  s3[20] = MISSING_U8; d3.setUint32(21, MISSING_U32, false);
  s3[25] = MISSING_U8; d3.setUint32(26, MISSING_U32, false);
  d3.setUint32(30, nx, false);
  d3.setUint32(34, ny, false);
  d3.setUint32(38, 0, false);           /* basic angle: 0 → degrees x 1e6 */
  d3.setUint32(42, MISSING_U32, false); /* subdivisions: missing */
  setSignMag32(d3, 46, micro(lat[0]));              /* La1 — first row centre */
  d3.setUint32(50, micro(lon360(lon[0])), false);   /* Lo1 */
  s3[54] = 0x30;                        /* i and j increments are given */
  setSignMag32(d3, 55, micro(lat[ny - 1]));         /* La2 */
  d3.setUint32(59, micro(lon360(lon[nx - 1])), false); /* Lo2 */
  d3.setUint32(63, micro(di), false);
  setSignMag32(d3, 67, micro(dj));                  /* read with grib2_i32 */
  s3[71] = 0x00;                        /* +i west→east, -j north→south */
  push(s3);

  /* section 4 — product definition, template 4.0 */
  const s4 = new Uint8Array(34);
  const d4 = new DataView(s4.buffer);
  d4.setUint32(0, 34, false); s4[4] = 4;
  d4.setUint16(5, 0, false);            /* no coordinate values */
  d4.setUint16(7, 0, false);            /* template 4.0 */
  s4[9]  = category;
  s4[10] = number;
  s4[11] = 0;                           /* generating process: analysis */
  s4[12] = 0; s4[13] = 0;
  d4.setUint16(14, 0, false); s4[16] = 0;
  s4[17] = 1;                           /* time range unit: hour */
  d4.setUint32(18, 0, false);           /* forecast time 0 */
  s4[22] = 1;                           /* first fixed surface: ground */
  s4[23] = 0; d4.setUint32(24, 0, false);
  s4[28] = MISSING_U8;                  /* no second surface */
  s4[29] = MISSING_U8; d4.setUint32(30, MISSING_U32, false);
  push(s4);

  /* section 5 — data representation, template 5.0 (simple packing) */
  const s5 = new Uint8Array(21);
  const d5 = new DataView(s5.buffer);
  d5.setUint32(0, 21, false); s5[4] = 5;
  d5.setUint32(5, raws.length, false);  /* values actually in section 7 */
  d5.setUint16(9, 0, false);            /* template 5.0 */
  d5.setFloat32(11, ref, false);
  setSignMag16(d5, 15, binScale);
  setSignMag16(d5, 17, 0);              /* decimal scale D = 0 */
  s5[19] = raws.length ? BITS : 0;
  s5[20] = 0;                           /* original values were floats */
  push(s5);

  /* section 6 — bit map, only when something is missing */
  if (hasMissing) {
    const nbytes = Math.ceil(nPts / 8);
    const s6 = new Uint8Array(6 + nbytes);
    new DataView(s6.buffer).setUint32(0, s6.length, false);
    s6[4] = 6;
    s6[5] = 0;                          /* a bit map follows */
    for (let i = 0; i < nPts; i++)
      if (Number.isFinite(data[i])) s6[6 + (i >> 3)] |= 0x80 >> (i & 7);
    push(s6);
  } else {
    const s6 = new Uint8Array(6);
    new DataView(s6.buffer).setUint32(0, 6, false);
    s6[4] = 6;
    s6[5] = MISSING_U8;                 /* no bit map */
    push(s6);
  }

  /* section 7 — data */
  const s7 = new Uint8Array(5 + packed.length);
  new DataView(s7.buffer).setUint32(0, s7.length, false);
  s7[4] = 7;
  s7.set(packed, 5);
  push(s7);

  /* ---- assemble --------------------------------------------------------- */
  const body = secs.reduce((n, s) => n + s.length, 0);
  const total = 16 + body + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x47; out[1] = 0x52; out[2] = 0x49; out[3] = 0x42;   /* 'GRIB' */
  out[4] = 0; out[5] = 0;
  out[6] = discipline;
  out[7] = 2;                                                   /* edition 2 */
  dv.setBigUint64(8, BigInt(total), false);
  let at = 16;
  for (const s of secs) { out.set(s, at); at += s.length; }
  out[at] = 0x37; out[at + 1] = 0x37; out[at + 2] = 0x37; out[at + 3] = 0x37;  /* '7777' */
  return out;
}
