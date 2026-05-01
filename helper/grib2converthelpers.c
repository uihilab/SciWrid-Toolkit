/*
 * grib2converthelpers.c -- GRIB2 parsing & decoding helpers
 *
 * Implements section parsers and data decoders used by the offline
 * normalize_refs tool and the WASM browser pipeline.
 *
 * Data template support:
 *   Template 0  -- simple packing
 *   Template 3  -- complex packing with spatial differencing (order 1 or 2)
 *
 * Grid template support:
 *   Template 0 / 40  -- regular lat/lon (equidistant cylindrical)
 *   Template 30      -- Lambert conformal conic
 *   Template 101     -- general unstructured grid (ICON / DWD)
 */

#include "grib2converthelpers.h"
#include <math.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* =========================================================================
 * Bit extraction  (MSB-first, used by both template 0 and 3)
 *
 * New signature includes buffer length to avoid out-of-bounds reads.
 * buf_len is the number of bytes available at buf.
 * bit_off is the bit offset from buf[0] (0 = MSB of buf[0]).
 * n_bits is the number of bits to extract (<= 32).
 * ======================================================================= */

uint32_t extract_bits(const uint8_t* buf, uint64_t buf_len,
                      uint64_t bit_off, uint8_t n_bits) {
    if (n_bits == 0) return 0;
    if (n_bits > 32) return 0; /* guard: caller should not request >32 bits */

    uint32_t val = 0;
    /* ensure we won't read past the buffer */
    uint64_t last_bit = bit_off + (uint64_t)n_bits - 1;
    uint64_t last_byte = last_bit / 8;
    if (buf_len == 0 || last_byte >= buf_len) {
        /* out-of-bounds request */
        return 0;
    }

    for (uint8_t i = 0; i < n_bits; i++) {
        uint64_t bit_index = bit_off + i;
        uint64_t byte_idx = bit_index / 8;
        int bit_in_byte = 7 - (int)(bit_index % 8);
        if ((buf[byte_idx] >> bit_in_byte) & 1u)
            val |= (1u << (n_bits - 1u - i));
    }
    return val;
}

/* =========================================================================
 * Section 1 – Identification (reference time)
 *
 * 0-indexed offsets from section start:
 *   [12..13] year   [14] month  [15] day
 *   [16]     hour   [17] minute [18] second
 * ======================================================================= */

int64_t parse_sec1_reftime(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 19) return -1;  /* need up to sec[18] (second) */

    int year  = (int)be16(sec + 12);
    int month = sec[14];
    int day   = sec[15];
    int hour  = sec[16];
    int min   = sec[17];
    int secs  = sec[18];

    static const int dpm[] = {31,28,31,30,31,30,31,31,30,31,30,31};

    int64_t days = 0;
    for (int y = 1970; y < year; y++) {
        int leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
        days += 365 + leap;
    }
    int leap_year = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    for (int m = 1; m < month; m++) {
        days += dpm[m - 1];
        if (m == 2) days += leap_year;
    }
    days += day - 1;

    return days * 86400LL + hour * 3600LL + min * 60LL + secs;
}

/* =========================================================================
 * Section 4 – Product Definition (forecast time offset)
 *
 * Template 4.0 body (0-indexed from section start):
 *   [17] indicator of unit of time range
 *   [18..21] forecast time in that unit
 * ======================================================================= */

int64_t parse_sec4_forecast_offset(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 22) return 0;

    uint8_t  unit = sec[17];
    uint32_t ft   = be32(sec + 18);

    int64_t mult;
    switch (unit) {
        case 0:  mult = 60LL;    break; /* minutes */
        case 1:  mult = 3600LL;  break; /* hours   */
        case 2:  mult = 86400LL; break; /* days    */
        case 13: mult = 1LL;     break; /* seconds */
        default: mult = 3600LL;  break; /* assume hours */
    }
    return (int64_t)ft * mult;
}

/* =========================================================================
 * Section 3 – Grid Definition  (template 0 / 40 — regular lat/lon)
 *
 * Template 3.0 body starts at section offset 14:
 *   [30..33] Ni   [34..37] Nj
 *   [46..49] La1  [50..53] Lo1  [54] flags
 *   [55..58] La2  [59..62] Lo2
 *   [63..66] Di   [67..70] Dj   [71] scanning mode
 * ======================================================================= */

int parse_sec3_latlon(const uint8_t* sec, uint32_t sec_len,
                      grid_latlon_t* g) {
    if (sec_len < 72) {
        fprintf(stderr,
                "  Error: Section 3 too short (%u bytes, need 72)\n", sec_len);
        return -1;
    }

    uint16_t tmpl = be16(sec + 12);
    if (tmpl != 0 && tmpl != 40) {
        fprintf(stderr,
                "  Error: grid template %u is not regular lat/lon (0 or 40)\n",
                tmpl);
        return -1;
    }

    g->nx            = be32(sec + 30);
    g->ny            = be32(sec + 34);
    g->lat1          = grib2_i32(sec + 46) / 1e6;
    g->lon1          = (double)be32(sec + 50) / 1e6;
    g->lat2          = grib2_i32(sec + 55) / 1e6;
    g->lon2          = (double)be32(sec + 59) / 1e6;
    g->di            = (double)be32(sec + 63) / 1e6;
    g->dj            = grib2_i32(sec + 67) / 1e6;
    g->scanning_mode = sec[71];

    if (g->nx == 0 || g->ny == 0 || g->nx > 100000 || g->ny > 100000) {
        fprintf(stderr,
                "  Error: implausible grid size %ux%u\n", g->nx, g->ny);
        return -1;
    }
    return 0;
}

/* =========================================================================
 * Section 3, Template 30 – Lambert Conformal Conic
 * ======================================================================= */

int parse_sec3_lambert(const uint8_t* sec, uint32_t sec_len,
                       grid_lambert_t* g) {
    if (sec_len < 81) {
        fprintf(stderr,
                "  Error: Section 3 too short for Lambert (%u bytes, need 81)\n",
                sec_len);
        return -1;
    }

    uint16_t tmpl = be16(sec + 12);
    if (tmpl != 30) {
        fprintf(stderr,
                "  Error: grid template %u is not Lambert conformal (30)\n",
                tmpl);
        return -1;
    }

    g->nx            = be32(sec + 30);
    g->ny            = be32(sec + 34);
    g->lat1          = grib2_i32(sec + 38) / 1e6;
    g->lon1          = grib2_i32(sec + 42) / 1e6;
    /* octet 47 = resolution flags */
    g->lad           = grib2_i32(sec + 47) / 1e6;
    g->lov           = grib2_i32(sec + 51) / 1e6;
    g->dx            = (double)be32(sec + 55) / 1e3;  /* mm to meters */
    g->dy            = (double)be32(sec + 59) / 1e3;
    g->proj_flag     = sec[63];
    g->scanning_mode = sec[64];
    g->latin1        = grib2_i32(sec + 65) / 1e6;
    g->latin2        = grib2_i32(sec + 69) / 1e6;

    if (g->nx == 0 || g->ny == 0 || g->nx > 100000 || g->ny > 100000) {
        fprintf(stderr,
                "  Error: implausible Lambert grid size %ux%u\n", g->nx, g->ny);
        return -1;
    }
    return 0;
}

/* =========================================================================
 * Section 3, Template 101 – General Unstructured Grid (ICON / DWD)
 *
 * Length-driven parse: the Section 3 *length* field is the single source of
 * truth.  Real-world encoders (DWD's 35-byte form, ECMWF's 63-byte form, ...)
 * each ship a different subset of the optional template-body fields, so we
 * read each field only if it actually fits in the section, otherwise leave
 * it at a default of 0 / missing.
 *
 * `numberOfDataPoints` lives in the universal Section 3 header (octets 7-10),
 * present in EVERY grid template — that's our authoritative source for the
 * cell count, with the template-body duplicate at offset 30 as a fallback.
 *
 * Cell lat/lon coordinates are NOT in the GRIB2 message — they live in an
 * external ICON grid file identified by the UUID, which decoders can resolve
 * separately if needed.
 * ======================================================================= */

static inline uint8_t sec_u8 (const uint8_t* sec, uint32_t sec_len,
                              uint32_t off, uint8_t  def) {
    return (off + 1 <= sec_len) ? sec[off] : def;
}
static inline uint32_t sec_u32(const uint8_t* sec, uint32_t sec_len,
                               uint32_t off, uint32_t def) {
    return (off + 4 <= sec_len) ? be32(sec + off) : def;
}

int parse_sec3_unstructured(const uint8_t* sec, uint32_t sec_len,
                            grid_unstructured_t* g) {
    /* Only the universal Section 3 header is required (14 bytes through
     * the template number).  Everything beyond is optional. */
    if (sec_len < 14) {
        fprintf(stderr,
                "  Error: Section 3 truncated (%u bytes, need >=14)\n", sec_len);
        return -1;
    }

    uint16_t tmpl = be16(sec + 12);
    if (tmpl != 101) {
        fprintf(stderr,
                "  Error: grid template %u is not unstructured (101)\n", tmpl);
        return -1;
    }

    memset(g, 0, sizeof(*g));

    /* Prefer the canonical numberOfDataPoints in Section 3 header (octets 7-10).
     * Fall back to the duplicate at template-body offset 30 if missing/zero. */
    g->num_points = sec_u32(sec, sec_len, 6, 0);
    if (g->num_points == 0 || g->num_points == 0xFFFFFFFFu)
        g->num_points = sec_u32(sec, sec_len, 30, 0);

    /* Optional template-body fields — fetched defensively */
    g->grid_point_position   = sec_u8 (sec, sec_len, 37, 0);
    g->numbering_order       = sec_u8 (sec, sec_len, 38, 0);
    g->number_of_grid_used   = sec_u32(sec, sec_len, 39, 0);
    g->number_of_grid_in_ref = sec_u32(sec, sec_len, 43, 0);
    if (sec_len >= 63) memcpy(g->uuid, sec + 47, 16);

    if (g->num_points == 0 || g->num_points == 0xFFFFFFFFu ||
        g->num_points > 1000000000u) {
        fprintf(stderr,
                "  Error: implausible unstructured grid size %u\n", g->num_points);
        return -1;
    }
    return 0;
}

/* =========================================================================
 * Lambert Conformal Conic projection: (i,j) grid index → (lat,lon)
 *
 * Uses the standard WMO/GRIB2 formulas for Lambert conformal conic.
 * Reference: WMO Manual on Codes, Part B, Section 3.30
 *            NCEP wgrib2 source (gctpc library)
 *
 * lats and lons must be pre-allocated to nx*ny floats.
 * Output order: lats[j*nx+i], lons[j*nx+i] for row j, col i.
 * ======================================================================= */

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

int lambert_compute_latlon(const grid_lambert_t* g,
                           float* lats, float* lons) {
    const double DEG2RAD = M_PI / 180.0;
    const double RAD2DEG = 180.0 / M_PI;
    const double R_EARTH = 6371229.0;  /* WMO standard Earth radius (meters) */

    double latin1_r = g->latin1 * DEG2RAD;
    double latin2_r = g->latin2 * DEG2RAD;
    double lov_r    = g->lov * DEG2RAD;

    /* Compute cone constant n */
    double n;
    if (fabs(g->latin1 - g->latin2) < 1e-6) {
        n = sin(latin1_r);
    } else {
        n = log(cos(latin1_r) / cos(latin2_r)) /
            log(tan(M_PI / 4.0 + latin2_r / 2.0) /
                tan(M_PI / 4.0 + latin1_r / 2.0));
    }

    /* Compute F */
    double F = cos(latin1_r) * pow(tan(M_PI / 4.0 + latin1_r / 2.0), n) / n;

    /* Compute rho0 (at reference point lat1, lon1) */
    double lat1_r = g->lat1 * DEG2RAD;
    double lon1_r = g->lon1 * DEG2RAD;
    double rho0   = R_EARTH * F / pow(tan(M_PI / 4.0 + lat1_r / 2.0), n);

    /* Compute (x0, y0) for the first grid point */
    double theta0 = n * (lon1_r - lov_r);
    double x0 = rho0 * sin(theta0);
    double y0 = rho0 * cos(theta0);

    /* Grid spacing — adjust sign based on scanning mode */
    double dx = g->dx;
    double dy = g->dy;

    /* Scanning mode bit 7 (0x80): i direction
     * Scanning mode bit 6 (0x40): j direction
     * Default (0x00): i increases, j decreases */
    if (g->scanning_mode & 0x80) dx = -dx;
    /* bit 6 set = j increases (south to north) */
    if (!(g->scanning_mode & 0x40)) dy = -dy;

    /* For each grid point, compute projected coords then invert to lat/lon */
    for (uint32_t j = 0; j < g->ny; j++) {
        for (uint32_t i = 0; i < g->nx; i++) {
            double x = x0 + (double)i * dx;
            double y = y0 - (double)j * dy;

            double rho = (n > 0) ? sqrt(x * x + y * y) : -sqrt(x * x + y * y);
            double theta = atan2(x, y);

            double lat, lon;
            if (fabs(rho) < 1e-10) {
                lat = (n > 0) ? 90.0 : -90.0;
                lon = g->lov;
            } else {
                lat = (2.0 * atan(pow(R_EARTH * F / rho, 1.0 / n))
                       - M_PI / 2.0) * RAD2DEG;
                lon = (lov_r + theta / n) * RAD2DEG;
            }

            /* Normalize longitude to [-180, 360) */
            while (lon > 360.0) lon -= 360.0;
            while (lon < -180.0) lon += 360.0;

            lats[j * g->nx + i] = (float)lat;
            lons[j * g->nx + i] = (float)lon;
        }
    }

    return 0;
}

/* =========================================================================
 * Section 5 – Data Representation (packing parameters)
 *
 * Common header (templates 0 and 3), 0-indexed from section start:
 *   [5..8]   num_pts   [9..10]  template#
 *   [11..14] R (f32)   [15..16] binary_scale  [17..18] decimal_scale
 *   [19]     bits_per_value
 *
 * Template 3 extra fields starting at [21]:
 *   [31..34] num_groups    [35] ref_group_width  [36] bits_group_width
 *   [37..40] ref_group_len [41] len_increment
 *   [42..45] last_group_len [46] bits_group_len
 *   [47] spatial_order     [48] extra_octets
 * ======================================================================= */

int parse_sec5(const uint8_t* sec, uint32_t sec_len, packing_t* pk) {
    if (sec_len < 21) {
        fprintf(stderr, "  Error: Section 5 too short (%u bytes)\n", sec_len);
        return -1;
    }

    pk->tmpl           = be16(sec + 9);
    pk->num_pts        = be32(sec + 5);
    pk->ref_val        = be_float(sec + 11);
    pk->binary_scale   = grib2_i16(sec + 15);
    pk->decimal_scale  = grib2_i16(sec + 17);
    pk->bits_per_value = sec[19];

    if (pk->tmpl == 0) {
        /* bits_per_value == 0 is valid: it means a constant field where
         * every cell takes the reference value (after scaling).  Reject
         * only out-of-range widths. */
        if (pk->bits_per_value > 32) {
            fprintf(stderr, "  Error: bits_per_value=%u out of range\n",
                    pk->bits_per_value);
            return -1;
        }
        return 0;
    }

    if (pk->tmpl == 3) {
        if (sec_len < 49) {
            fprintf(stderr,
                    "  Error: Section 5 too short for template 3 (%u bytes)\n",
                    sec_len);
            return -1;
        }
        pk->num_groups       = be32(sec + 31);
        pk->ref_group_width  = sec[35];
        pk->bits_group_width = sec[36];
        pk->ref_group_len    = be32(sec + 37);
        pk->len_increment    = sec[41];
        pk->last_group_len   = be32(sec + 42);
        pk->bits_group_len   = sec[46];
        pk->spatial_order    = sec[47];
        pk->extra_octets     = sec[48];

        /* basic sanity checks */
        if (pk->num_groups == 0 || pk->num_pts == 0) {
            fprintf(stderr, "  Error: invalid num_groups or num_pts in template 3\n");
            return -1;
        }
        if (pk->bits_group_len > 32 || pk->bits_group_width > 32) {
            fprintf(stderr, "  Error: unreasonable group bit widths\n");
            return -1;
        }
        return 0;
    }

    fprintf(stderr,
            "  Error: data template %u not supported (need 0 or 3)\n",
            pk->tmpl);
    return -1;
}

/* =========================================================================
 * parse_message – collect section offsets for one GRIB2 message.
 * msg_start..msg_end is the byte range of this message in `data`.
 * ======================================================================= */

int parse_message(const uint8_t* data, uint64_t file_len,
                  uint64_t msg_start, uint64_t msg_end,
                  grib2_msg_t* m) {
    (void)file_len;
    memset(m, 0, sizeof(*m));
    uint64_t pos = msg_start + 16; /* skip Section 0 (fixed 16 bytes) */

    while (pos + 5 <= msg_end) {
        if (pos + 4 <= msg_end &&
            data[pos]=='7' && data[pos+1]=='7' &&
            data[pos+2]=='7' && data[pos+3]=='7') {
            break; /* end-of-message sentinel */
        }

        uint32_t sec_len = be32(data + pos);
        uint8_t  sec_num = data[pos + 4];

        if (sec_len < 5 || pos + sec_len > msg_end) {
            fprintf(stderr, "  Error: bad section length %u at offset %llu\n",
                    sec_len, (unsigned long long)pos);
            return -1;
        }

        switch (sec_num) {
            case 1:
                m->sec1_off = pos; m->sec1_len = sec_len;
                break;
            case 3:
                m->sec3_off = pos; m->sec3_len = sec_len;
                if (sec_len >= 15)
                    m->grid_template = be16(data + pos + 12);
                break;
            case 4:
                m->sec4_off = pos; m->sec4_len = sec_len;
                if (sec_len >= 11) {
                    m->data_template = be16(data + pos + 7);
                    m->param_cat     = data[pos + 9];
                    m->param_num     = data[pos + 10];
                }
                break;
            case 5:
                m->sec5_off = pos; m->sec5_len = sec_len;
                if (sec_len >= 11)
                    m->data_template = be16(data + pos + 9);
                break;
            case 6:
                m->sec6_off = pos;
                break;
            case 7:
                m->sec7_off = pos; m->sec7_len = sec_len;
                break;
            default:
                break;
        }
        pos += sec_len;
    }

    return (m->sec1_off && m->sec3_off && m->sec4_off &&
            m->sec5_off && m->sec7_off) ? 0 : -1;
}

/* =========================================================================
 * index_messages – find and parse every GRIB2 message in a file.
 * Caller must free(*msgs_out).
 * Returns message count (0 on failure).
 * ======================================================================= */

int index_messages(const uint8_t* data, uint64_t file_len,
                   grib2_msg_t** msgs_out) {
    /* First pass: count */
    int      count = 0;
    uint64_t pos   = 0;
    while (pos + 16 <= file_len) {
        if (memcmp(data + pos, "GRIB", 4) != 0) { pos++; continue; }
        if (data[pos + 7] != 2)                  { pos += 4; continue; }
        uint64_t msg_len = be64(data + pos + 8);
        if (msg_len < 16) { pos += 4; continue; }
        count++;
        pos += msg_len;
    }

    if (count == 0) {
        fprintf(stderr, "Error: no GRIB2 messages found\n");
        return 0;
    }

    grib2_msg_t* msgs = (grib2_msg_t*)calloc((size_t)count, sizeof(grib2_msg_t));
    if (!msgs) { fprintf(stderr, "Error: out of memory\n"); return 0; }

    /* Second pass: parse */
    int idx = 0;
    pos = 0;
    while (pos + 16 <= file_len && idx < count) {
        if (memcmp(data + pos, "GRIB", 4) != 0) { pos++; continue; }
        if (data[pos + 7] != 2)                  { pos += 4; continue; }
        uint64_t msg_len = be64(data + pos + 8);
        uint64_t msg_end = pos + msg_len;
        if (msg_end > file_len) msg_end = file_len;

        if (parse_message(data, file_len, pos, msg_end, &msgs[idx]) == 0)
            idx++;

        pos += msg_len;
    }

    *msgs_out = msgs;
    return idx;
}

/* =========================================================================
 * decode_simple – template 0 (simple packing)
 *
 *   Y[i] = (R + X[i] * 2^E) / 10^D
 * ======================================================================= */

int decode_simple(const uint8_t* payload, uint32_t payload_len,
                  const packing_t* pk, float* out) {
    uint64_t total_bits = (uint64_t)pk->num_pts * pk->bits_per_value;
    if (total_bits > (uint64_t)payload_len * 8) {
        fprintf(stderr, "  Error: simple packing bits exceed payload\n");
        return -1;
    }

    double s10 = pow(10.0, (double)pk->decimal_scale);

    /* bits_per_value == 0: constant field, every cell = ref_val / 10^D */
    if (pk->bits_per_value == 0) {
        float v = (float)((double)pk->ref_val / s10);
        for (uint32_t i = 0; i < pk->num_pts; i++) out[i] = v;
        return 0;
    }

    double   s2 = pow(2.0, (double)pk->binary_scale);
    uint64_t bit_off = 0;

    for (uint32_t i = 0; i < pk->num_pts; i++) {
        uint32_t raw = extract_bits(payload, payload_len, bit_off, pk->bits_per_value);
        out[i] = (float)(((double)pk->ref_val + raw * s2) / s10);
        bit_off += pk->bits_per_value;
    }
    return 0;
}

/* =========================================================================
 * decode_complex – template 3 (complex packing + spatial differencing)
 *
 * Section 7 payload layout:
 *   [0 .. seed_bytes-1]    spatial differencing seed values
 *   [seed_bytes ..]        bit-packed group metadata then values:
 *     1. NG × bits_per_value bits  -- group reference values
 *     2. NG × bits_group_width bits -- group widths (+ ref_group_width bias)
 *     3. NG × bits_group_len bits   -- group lengths (+ ref_group_len×inc)
 *        (last group uses last_group_len directly)
 *     4. For each group g: group_len[g] × group_width[g] bits -- values
 *
 * After unpacking X2[], undo spatial differencing to recover the
 * physically meaningful values, then apply global scale and decimal scale.
 * ======================================================================= */

int decode_complex(const uint8_t* payload, uint32_t payload_len,
                   const packing_t* pk, float* out) {
    uint32_t NG = pk->num_groups;
    uint32_t N  = pk->num_pts;

    if (NG == 0 || N == 0) {
        fprintf(stderr, "  Error: zero groups or points in template 3\n");
        return -1;
    }

    /* ---- Step 1: read spatial differencing seed values ---- */
    /*
     * WMO Template 7.3 stores (ord + 1) seed values, each extra_octets
     * bytes long, at the start of the payload:
     *   - First 'ord' values are the initial grid-point values (g0, g1, ...)
     *   - Last value is the overall minimum of the spatial differences
     * All are GRIB2-signed (MSB = sign bit, rest = magnitude).
     */
    uint8_t  eo  = pk->extra_octets;
    uint8_t  ord = pk->spatial_order;

    if (eo == 0 || ord == 0 || ord > 2) {
        fprintf(stderr,
                "  Error: unsupported spatial order=%u extra_octets=%u\n",
                ord, eo);
        return -1;
    }

    uint32_t n_seeds    = (uint32_t)ord + 1;  /* ord values + 1 overall min */
    uint32_t seed_bytes = n_seeds * (uint32_t)eo;
    if (seed_bytes > payload_len) {
        fprintf(stderr, "  Error: payload too short for spatial diff seeds\n");
        return -1;
    }

    /* Read each seed as a GRIB2-signed integer (MSB = sign, rest = magnitude) */
    int64_t seeds[3] = {0, 0, 0};  /* [0..ord-1] = grid values, [ord] = min */
    for (uint32_t s = 0; s < n_seeds; s++) {
        uint64_t v = 0;
        for (uint8_t b = 0; b < eo; b++)
            v = (v << 8) | payload[s * (uint32_t)eo + b];
        uint64_t sign_mask = (uint64_t)1 << (eo * 8 - 1);
        if (v & sign_mask)
            seeds[s] = -(int64_t)(v & (sign_mask - 1));
        else
            seeds[s] = (int64_t)v;
    }
    int64_t gmin = seeds[ord]; /* overall minimum of spatial differences */

#define OCTET_ALIGN(b) (((b) + 7u) & ~(uint64_t)7u)

    /* Debug output removed — decoder verified working */

    /*
     * All group metadata and packed values come after the seed bytes.
     * Per WMO GRIB2 spec, each section (refs / widths / lengths / values)
     * starts on an OCTET BOUNDARY after the previous section ends.
     *
     * Layout (bit-packed, MSB-first, octet-aligned between sections):
     *   1. NG × bits_per_value   -- group references   (starts at bit 0)
     *   2. NG × bits_group_width -- group widths        (octet-aligned start)
     *   3. NG × bits_group_len   -- group lengths       (octet-aligned start)
     *   4. values (per group, group_width bits each)    (octet-aligned start)
     */
    const uint8_t* p = payload + seed_bytes;
    const uint64_t p_len = (payload_len > seed_bytes) ? (payload_len - seed_bytes) : 0;

    /* ---- Step 2: group references (start at bit 0) ---- */
    uint32_t* grefs = (uint32_t*)malloc((size_t)NG * sizeof(uint32_t));
    if (!grefs) { fprintf(stderr, "  Error: OOM\n"); return -1; }

    uint64_t bit_off = 0;
    for (uint32_t g = 0; g < NG; g++) {
        grefs[g] = (pk->bits_per_value > 0)
                   ? extract_bits(p, p_len, bit_off, pk->bits_per_value) : 0;
        bit_off += pk->bits_per_value;
    }
    bit_off = OCTET_ALIGN(bit_off);   /* align before widths */

    /* ---- Step 3: group widths ---- */
    uint8_t* gw = (uint8_t*)malloc((size_t)NG);
    if (!gw) { free(grefs); fprintf(stderr, "  Error: OOM\n"); return -1; }

    for (uint32_t g = 0; g < NG; g++) {
        uint32_t add = (pk->bits_group_width > 0)
                       ? extract_bits(p, p_len, bit_off, pk->bits_group_width) : 0;
        gw[g] = (uint8_t)(pk->ref_group_width + add);
        bit_off += pk->bits_group_width;
    }
    bit_off = OCTET_ALIGN(bit_off);   /* align before lengths */

    /* ---- Step 4: group lengths ---- */
    uint32_t* gl = (uint32_t*)malloc((size_t)NG * sizeof(uint32_t));
    if (!gl) {
        free(grefs); free(gw);
        fprintf(stderr, "  Error: OOM\n");
        return -1;
    }

    /*
     * Only NG-1 group lengths are stored in the bitstream.
     * The last group's length comes from Section 5 (last_group_len).
     */
    uint32_t total_check = 0;
    for (uint32_t g = 0; g < NG - 1; g++) {
        uint32_t raw = (pk->bits_group_len > 0)
                       ? extract_bits(p, p_len, bit_off, pk->bits_group_len) : 0;
        gl[g] = pk->ref_group_len + raw * pk->len_increment;
        bit_off += pk->bits_group_len;
        total_check += gl[g];
    }
    gl[NG - 1] = pk->last_group_len;
    total_check += pk->last_group_len;
    bit_off = OCTET_ALIGN(bit_off);   /* align before values */

    if (total_check != N) {
        fprintf(stderr,
                "  Error: group lengths sum %u != num_pts %u\n",
                total_check, N);
        free(grefs); free(gw); free(gl);
        return -1;
    }

    /* ---- Step 5: unpack values per group ---- */
    int64_t* X2 = (int64_t*)malloc((size_t)N * sizeof(int64_t));
    if (!X2) {
        free(grefs); free(gw); free(gl);
        fprintf(stderr, "  Error: OOM\n");
        return -1;
    }

    uint32_t idx = 0;
    for (uint32_t g = 0; g < NG; g++) {
        for (uint32_t v = 0; v < gl[g]; v++) {
            uint32_t raw = (gw[g] > 0)
                           ? extract_bits(p, p_len, bit_off, gw[g]) : 0;
            bit_off += gw[g];
            /* Each unpacked value = group_ref + raw_bits + gmin */
            X2[idx++] = (int64_t)grefs[g] + (int64_t)raw + gmin;
        }
    }
    free(grefs); free(gw); free(gl);

    /* ---- Step 6: undo spatial differencing ---- */
    double s2  = pow(2.0,  (double)pk->binary_scale);
    double s10 = pow(10.0, (double)pk->decimal_scale);

    if (ord == 1) {
        /* First-order: X2[i] is delta from previous */
        out[0] = (float)(((double)pk->ref_val + (double)seeds[0] * s2) / s10);
        int64_t prev = seeds[0];
        for (uint32_t i = 1; i < N; i++) {
            prev  += X2[i];
            out[i] = (float)(((double)pk->ref_val + (double)prev * s2) / s10);
        }
    } else {
        /* Second-order: X2[i] is delta-of-delta */
        out[0] = (float)(((double)pk->ref_val + (double)seeds[0] * s2) / s10);
        out[1] = (float)(((double)pk->ref_val + (double)seeds[1] * s2) / s10);
        int64_t prev_delta = seeds[1] - seeds[0];
        int64_t prev_val   = seeds[1];
        for (uint32_t i = 2; i < N; i++) {
            prev_delta += X2[i];
            prev_val   += prev_delta;
            out[i] = (float)(((double)pk->ref_val + (double)prev_val * s2) / s10);
        }
    }

    free(X2);
    return 0;
}

/* =========================================================================
 * decode_sec7 – dispatcher: simple or complex packing
 * ======================================================================= */

int decode_sec7(const uint8_t* sec7, uint32_t sec7_len,
                const packing_t* pk, float* out_f32) {
    if (sec7_len < 5) {
        fprintf(stderr, "  Error: Section 7 too short\n");
        return -1;
    }
    const uint8_t* payload     = sec7 + 5;
    uint32_t       payload_len = sec7_len - 5;

    if (pk->tmpl == 0)
        return decode_simple(payload, payload_len, pk, out_f32);
    if (pk->tmpl == 3)
        return decode_complex(payload, payload_len, pk, out_f32);

    fprintf(stderr, "  Error: unsupported data template %u\n", pk->tmpl);
    return -1;
}
