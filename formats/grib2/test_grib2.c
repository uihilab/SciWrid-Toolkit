/*
 * test_grib2.c - GRIB2 Format Probe
 *
 * Purpose: Inspect and print the full section-level structure of a GRIB2 file.
 * This is a diagnostic tool for understanding file layout before attempting
 * data extraction. It does NOT use the engine or query API.
 *
 * Usage:
 *   test_grib2.exe <file.grib2>
 *
 * Output: Structured metadata for every message/field found.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "grib2.h"
#include "grib2_metadata.h"
#include "../../core/errors.h"

/* ---- Helpers ---- */

static uint16_t be16(const uint8_t* p) {
    return (uint16_t)((p[0] << 8) | p[1]);
}

static uint32_t be24(const uint8_t* p) {
    return (uint32_t)((p[0] << 16) | (p[1] << 8) | p[2]);
}

static uint32_t be32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  |  (uint32_t)p[3];
}

static uint64_t be64(const uint8_t* p) {
    return ((uint64_t)be32(p) << 32) | (uint64_t)be32(p + 4);
}

/* Decode a potentially signed 2-byte big-endian integer (used for scale factors) */
static int16_t be16_signed(const uint8_t* p) {
    uint16_t raw = be16(p);
    /* GRIB2 sign bit: MSB of first byte */
    if (raw & 0x8000) return -(int16_t)(raw & 0x7FFF);
    return (int16_t)raw;
}

static uint8_t* read_file(const char* path, uint32_t* out_len) {
    FILE* f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "Error: cannot open '%s'\n", path); return NULL; }

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (sz <= 0 || sz > (long)0x7FFFFFFF) {
        fprintf(stderr, "Error: invalid file size\n");
        fclose(f); return NULL;
    }

    uint8_t* buf = (uint8_t*)malloc((size_t)sz);
    if (!buf) { fprintf(stderr, "Error: out of memory\n"); fclose(f); return NULL; }

    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "Error: incomplete read\n");
        free(buf); fclose(f); return NULL;
    }

    fclose(f);
    *out_len = (uint32_t)sz;
    return buf;
}

/* ---- Grid template names ---- */

static const char* grid_template_name(uint16_t t) {
    switch (t) {
        case 0:  return "Lat/Lon (equidistant cylindrical)";
        case 1:  return "Rotated Lat/Lon";
        case 10: return "Mercator";
        case 20: return "Polar Stereographic";
        case 30: return "Lambert Conformal";
        case 40: return "Gaussian Lat/Lon";
        case 90: return "Space View / Orthographic";
        case 101: return "General Unstructured Grid (ICON/icosahedral)";
        case 140: return "Lambert Azimuthal Equal Area";
        default: return "Unknown/Other";
    }
}

/* ---- Product template names ---- */

static const char* product_template_name(uint16_t t) {
    switch (t) {
        case 0:  return "Analysis or forecast at horizontal level (instantaneous)";
        case 1:  return "Individual ensemble member";
        case 2:  return "Ensemble mean";
        case 8:  return "Statistically processed (time range)";
        case 11: return "Ensemble member, time range";
        default: return "Other/Unknown";
    }
}

/* ---- Data rep template names ---- */

static const char* data_rep_name(uint16_t t) {
    switch (t) {
        case 0:  return "Simple packing";
        case 2:  return "Complex packing";
        case 3:  return "Complex packing with spatial differencing";
        case 40: return "JPEG 2000";
        case 41: return "PNG";
        default: return "Other/Unknown";
    }
}

/* ---- Section parsers (read-only, offset-based) ---- */

static void probe_section0(const uint8_t* d, uint32_t len) {
    if (len < 16) { printf("  [Section 0] Too short\n"); return; }
    uint8_t discipline = d[6];
    uint8_t edition    = d[7];
    uint64_t total_len = be64(d + 8);

    printf("  Discipline  : %u", discipline);
    switch (discipline) {
        case 0: puts(" (Meteorological)"); break;
        case 1: puts(" (Hydrological)"); break;
        case 2: puts(" (Land surface)"); break;
        case 10: puts(" (Oceanographic)"); break;
        default: puts(" (Other)"); break;
    }
    printf("  Edition     : %u\n", edition);
    printf("  Total length: %llu bytes\n", (unsigned long long)total_len);
}

static void probe_section1(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 21) { printf("  [Section 1] Too short (%u bytes)\n", sec_len); return; }
    /* Skip 4-byte section length + 1-byte section number = offset 5 */
    const uint8_t* b = sec + 5;

    uint16_t centre    = be16(b + 0);
    uint16_t subcentre = be16(b + 2);
    uint8_t  tables    = b[4];
    uint8_t  local_ver = b[5];
    uint8_t  sig_rtime = b[6];
    uint16_t year      = be16(b + 7);
    uint8_t  month     = b[9];
    uint8_t  day       = b[10];
    uint8_t  hour      = b[11];
    uint8_t  minute    = b[12];
    uint8_t  second    = b[13];
    uint8_t  prod_stat = b[14];
    uint8_t  data_type = b[15];

    printf("  Centre      : %u", centre);
    /* Common centre codes */
    if (centre == 78)  printf(" (DWD - Germany)");
    if (centre == 7)   printf(" (NCEP/NWS - USA)");
    if (centre == 98)  printf(" (ECMWF)");
    if (centre == 161) printf(" (MRI/JMA - Japan)");
    printf("\n");
    printf("  Sub-centre  : %u\n", subcentre);
    printf("  Tables ver  : %u\n", tables);
    printf("  Local ver   : %u\n", local_ver);

    const char* sig_str = "Unknown";
    if (sig_rtime == 0) sig_str = "Analysis";
    else if (sig_rtime == 1) sig_str = "Start of forecast";
    else if (sig_rtime == 2) sig_str = "Verifying time of forecast";
    else if (sig_rtime == 3) sig_str = "Observation time";
    printf("  Ref time    : %04u-%02u-%02u %02u:%02u:%02u UTC (%s)\n",
           year, month, day, hour, minute, second, sig_str);

    const char* dt_str = "Unknown";
    if (data_type == 0) dt_str = "Analysis";
    else if (data_type == 1) dt_str = "Forecast";
    else if (data_type == 2) dt_str = "Analysis & forecast";
    printf("  Data type   : %u (%s)\n", data_type, dt_str);
    printf("  Prod status : %u\n", prod_stat);

    (void)sec_len;
}

static void probe_section3(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 14) { printf("  [Section 3] Too short\n"); return; }
    const uint8_t* b = sec + 5;

    uint8_t  src_of_def  = b[0];
    uint32_t num_pts     = be32(b + 1);
    uint8_t  opt_list_len = b[5];
    uint8_t  interp_list = b[6];
    uint16_t grid_tmpl   = be16(b + 7);

    printf("  Src of def  : %u (%s)\n", src_of_def,
           src_of_def == 0 ? "Specified in this section" : "Predefined");
    printf("  Num points  : %u\n", num_pts);
    printf("  Opt list len: %u  interp_list=%u\n", opt_list_len, interp_list);
    printf("  Grid template: %u - %s\n", grid_tmpl, grid_template_name(grid_tmpl));

    /* Template-specific params */
    if (sec_len < 14 + 9) return;
    const uint8_t* tp = b + 9; /* template-specific data starts here */

    if (grid_tmpl == 0 || grid_tmpl == 40) {
        /* Lat/Lon or Gaussian */
        if (sec_len < 14 + 9 + 64) return;
        uint32_t shape  = be32(tp + 0);
        uint32_t nx     = be32(tp + 8);
        uint32_t ny     = be32(tp + 12);
        int32_t  lat1   = (int32_t)be32(tp + 20);
        int32_t  lon1   = (int32_t)be32(tp + 24);
        int32_t  lat2   = (int32_t)be32(tp + 30);
        int32_t  lon2   = (int32_t)be32(tp + 34);
        int32_t  di     = (int32_t)be32(tp + 38);
        int32_t  dj     = (int32_t)be32(tp + 42);

        printf("  Earth shape : %u\n", shape);
        printf("  Grid size   : %u x %u = %u pts\n", nx, ny, nx * ny);
        printf("  Lat1/Lon1   : %.6f / %.6f\n", lat1 / 1e6, lon1 / 1e6);
        printf("  Lat2/Lon2   : %.6f / %.6f\n", lat2 / 1e6, lon2 / 1e6);
        printf("  Di/Dj (deg) : %.6f / %.6f\n", di / 1e6, dj / 1e6);

    } else if (grid_tmpl == 101) {
        /* ICON unstructured / icosahedral (Template 3.101) */
        if (sec_len < 14 + 9 + 12) return;
        uint32_t n2   = be32(tp + 0);
        uint32_t ni   = be32(tp + 4);
        uint32_t nd   = be32(tp + 8);

        printf("  N2 (# cells): %u\n", n2);
        printf("  Ni          : %u\n", ni);
        printf("  Nd          : %u\n", nd);
        printf("  NOTE: ICON grid — no per-point lat/lon in Section 3.\n");
        printf("  Geometry is defined by an external grid description file (GGDF).\n");
    } else {
        printf("  (Template-specific params not decoded for this template)\n");
    }
}

static void probe_section4(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 11) { printf("  [Section 4] Too short\n"); return; }
    const uint8_t* b = sec + 5;

    uint16_t num_coord_vals = be16(b + 0);
    uint16_t prod_tmpl      = be16(b + 2);
    uint8_t  param_cat      = b[4];
    uint8_t  param_num      = b[5];

    printf("  Coord vals  : %u\n", num_coord_vals);
    printf("  Prod template: %u - %s\n", prod_tmpl, product_template_name(prod_tmpl));
    printf("  Parameter   : category=%u, number=%u  (%s)\n",
           param_cat, param_num, grib2_get_variable_name(param_cat, param_num));

    /* Template 0 or 1 — type of generating process, level info */
    if ((prod_tmpl == 0 || prod_tmpl == 1) && sec_len >= 5 + 34) {
        uint8_t gen_proc     = b[6];
        uint8_t bgnd_proc    = b[7];
        uint8_t hrs_after_hi = b[8];
        uint8_t hrs_after_lo = b[9];
        uint16_t hrs_after   = (uint16_t)((hrs_after_hi << 8) | hrs_after_lo);
        uint8_t mins_after   = b[10];
        uint8_t unit         = b[11];
        int32_t fcast_time   = (int32_t)be32(b + 12);
        uint8_t fixed_sfc1   = b[16];
        uint8_t scale_fac1   = b[17];
        int32_t scale_val1   = (int32_t)be32(b + 18);

        const char* unit_str = "?";
        if (unit == 0) unit_str = "minutes";
        else if (unit == 1) unit_str = "hours";
        else if (unit == 2) unit_str = "days";
        else if (unit == 13) unit_str = "seconds";

        printf("  Gen process : %u\n", gen_proc);
        printf("  Bgnd process: %u\n", bgnd_proc);
        printf("  Hours after : %u h %u min\n", hrs_after, mins_after);
        printf("  Forecast time: %d %s\n", fcast_time, unit_str);
        printf("  Fixed sfc1  : %u  scale=%u val=%d\n",
               fixed_sfc1, scale_fac1, scale_val1);
    }
}

static void probe_section5(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 11) { printf("  [Section 5] Too short\n"); return; }
    const uint8_t* b = sec + 5;

    uint32_t num_pts    = be32(b + 0);
    uint16_t data_tmpl  = be16(b + 4);

    printf("  Num data pts: %u\n", num_pts);
    printf("  Data template: %u - %s\n", data_tmpl, data_rep_name(data_tmpl));

    /* Template 0 — simple packing */
    if ((data_tmpl == 0 || data_tmpl == 2 || data_tmpl == 3) && sec_len >= 5 + 20) {
        /* Reference value: 32-bit IEEE 754 big-endian */
        uint32_t ref_raw  = be32(b + 6);
        float    ref_val;
        memcpy(&ref_val, &ref_raw, 4);

        int16_t bin_scale = be16_signed(b + 10);
        int16_t dec_scale = be16_signed(b + 12);
        uint8_t bits_per  = b[14];
        uint8_t orig_type = b[15];

        /* Reconstruct bitmask from bin/dec scale */
        const char* type_str = "floating point";
        if (orig_type == 1) type_str = "integer";
        else if (orig_type == 2) type_str = "complex";

        printf("  Ref value   : %g\n", ref_val);
        printf("  Binary scale: %d  Decimal scale: %d\n", bin_scale, dec_scale);
        printf("  Bits/value  : %u\n", bits_per);
        printf("  Orig type   : %u (%s)\n", orig_type, type_str);
    }
}

static void probe_section6(const uint8_t* sec, uint32_t sec_len) {
    if (sec_len < 6) return;
    uint8_t bmap_ind = sec[5];
    printf("  Bitmap ind  : %u (%s)\n", bmap_ind,
           bmap_ind == 255 ? "No bitmap (all data present)"
         : bmap_ind == 0   ? "Bitmap follows in this section"
         :                   "Pre-defined bitmap");
}

static void probe_section7(const uint8_t* sec, uint32_t sec_len) {
    printf("  Data section size: %u bytes (payload only: %u bytes)\n",
           sec_len, sec_len > 5 ? sec_len - 5 : 0);
}

/* ---- Main probe loop ---- */

static void probe_message(const uint8_t* d, uint64_t msg_start, uint64_t msg_end, int msg_idx) {
    printf("\n=== MESSAGE %d  [offset %llu .. %llu, %llu bytes] ===\n",
           msg_idx,
           (unsigned long long)msg_start,
           (unsigned long long)msg_end,
           (unsigned long long)(msg_end - msg_start));

    /* Walk each section */
    uint64_t pos = msg_start + 16; /* skip section 0 (fixed 16 bytes) */

    probe_section0(d + msg_start, (uint32_t)(msg_end - msg_start));

    int sec_count = 0;
    while (pos + 5 <= msg_end) {

        /* Check for end-of-message "7777" */
        if (d[pos]=='7' && d[pos+1]=='7' && d[pos+2]=='7' && d[pos+3]=='7') {
            printf("\n  [End-of-message: 7777 at offset %llu]\n", (unsigned long long)pos);
            break;
        }

        uint32_t sec_len = be32(d + pos);
        uint8_t  sec_num = d[pos + 4];

        if (sec_len < 5 || pos + sec_len > msg_end) {
            printf("\n  [Bad section length %u at offset %llu — stopping]\n",
                   sec_len, (unsigned long long)pos);
            break;
        }

        printf("\n  --- Section %u  [offset %llu, length %u] ---\n",
               sec_num, (unsigned long long)pos, sec_len);

        switch (sec_num) {
            case 1: probe_section1(d + pos, sec_len); break;
            case 2: printf("  (Local use section — skipped)\n"); break;
            case 3: probe_section3(d + pos, sec_len); break;
            case 4: probe_section4(d + pos, sec_len); break;
            case 5: probe_section5(d + pos, sec_len); break;
            case 6: probe_section6(d + pos, sec_len); break;
            case 7: probe_section7(d + pos, sec_len); break;
            default:
                printf("  (Unrecognised section number %u)\n", sec_num);
                break;
        }

        pos += sec_len;
        sec_count++;

        if (sec_count > 100) {
            printf("  [Section parse limit reached — aborting message]\n");
            break;
        }
    }
}

/* ---- Entry point ---- */

int main(int argc, char** argv) {
    if (argc < 2) {
        printf("Usage: %s <file.grib2>\n\n", argv[0]);
        printf("Prints the section-level structure of a GRIB2 file.\n");
        printf("Used to understand the format before attempting data extraction.\n");
        return 1;
    }

    const char* path = argv[1];
    uint32_t file_len = 0;
    uint8_t* data = read_file(path, &file_len);
    if (!data) return 1;

    printf("=================================================\n");
    printf(" GRIB2 FORMAT PROBE\n");
    printf(" File : %s\n", path);
    printf(" Size : %u bytes (%.2f MB)\n", file_len, file_len / 1048576.0);
    printf("=================================================\n");

    /* Validate magic */
    if (file_len < 16 || memcmp(data, "GRIB", 4) != 0) {
        fprintf(stderr, "Error: not a GRIB file (bad magic bytes)\n");
        free(data);
        return 1;
    }

    /* Walk all messages (GRIB2 files can concatenate multiple messages) */
    uint64_t pos = 0;
    int msg_idx = 0;

    while (pos + 16 <= file_len) {
        /* Locate next "GRIB" marker */
        if (memcmp(data + pos, "GRIB", 4) != 0) {
            /* Scan forward */
            pos++;
            continue;
        }

        uint8_t edition = data[pos + 7];
        if (edition != 2) {
            printf("\n[Skipping non-GRIB2 message at offset %llu (edition=%u)]\n",
                   (unsigned long long)pos, edition);
            pos += 4;
            continue;
        }

        uint64_t msg_len = be64(data + pos + 8);
        uint64_t msg_end = pos + msg_len;

        if (msg_end > file_len) {
            printf("\n[Message at offset %llu claims length %llu which extends past file — clamping]\n",
                   (unsigned long long)pos, (unsigned long long)msg_len);
            msg_end = file_len;
        }

        msg_idx++;
        probe_message(data, pos, msg_end, msg_idx);

        pos = msg_end;
    }

    printf("\n=================================================\n");
    printf(" Total messages found: %d\n", msg_idx);
    printf("=================================================\n");

    free(data);
    return 0;
}
