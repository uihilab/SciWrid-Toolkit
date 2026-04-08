#include "grib2.h"
#include "grib2_metadata.h"
#include "../../core/grid/grid.h"
#include "../../core/cursor/cursor.h"
#include "../../core/util/endian.h"
#include "../../core/math/geo.h"
#include "../../core/errors.h"
#include "../../core/memory/allocator.h"

#include <string.h>
#include <math.h>
#include <stdio.h>

/* GRIB2 Section numbers */
#define GRIB2_SECTION_INDICATOR   0
#define GRIB2_SECTION_IDENT       1
#define GRIB2_SECTION_LOCAL       2
#define GRIB2_SECTION_GRID        3
#define GRIB2_SECTION_PRODUCT     4
#define GRIB2_SECTION_DATA_REP    5
#define GRIB2_SECTION_BITMAP      6
#define GRIB2_SECTION_DATA        7
#define GRIB2_SECTION_END         8

/* GRIB2 magic: "GRIB" */
#define GRIB2_MAGIC_0 0x47
#define GRIB2_MAGIC_1 0x52
#define GRIB2_MAGIC_2 0x49
#define GRIB2_MAGIC_3 0x42

/* Grid templates */
#define GRIB2_GRID_LATLON        0
#define GRIB2_GRID_ICOSAHEDRAL   20

static uint32_t read_be24(const uint8_t* p) {
    return (p[0] << 16) | (p[1] << 8) | p[2];
}

static uint32_t read_be32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) |
           ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  |
           ((uint32_t)p[3]);
}

/* Current metadata */
static grib2_metadata_t* grib2_current_metadata = NULL;

/* --- Helpers --- */
/* Read section header: length (3 bytes) + section number (1 byte) */
static int grib2_read_section_header(
    const uint8_t* data,
    uint32_t len,
    uint64_t pos,
    uint32_t* out_len,
    uint8_t* out_num
) {
    if (!data || !out_len || !out_num)
        return DP_ERR_NULL;

    if (pos + 5 > len) {
        fprintf(stderr, "DEBUG read_header: pos=%llu + 5 > len=%u\n", 
                (unsigned long long)pos, len);
        return DP_ERR_FORMAT;
    }

    fprintf(stderr, "DEBUG read_header: bytes at pos %llu: %02x %02x %02x %02x %02x\n",
            (unsigned long long)pos,
            data[pos], data[pos+1], data[pos+2], data[pos+3], data[pos+4]);

    uint32_t L = read_be32(data + pos);
    uint8_t num = data[pos + 4];

    fprintf(stderr, "DEBUG read_header: pos=%llu, L=%u, num=%u\n", 
            (unsigned long long)pos, L, num);

    if (L < 5) {
        fprintf(stderr, "DEBUG read_header: L=%u < 5\n", L);
        return DP_ERR_FORMAT;
    }

    if (pos + L > len) {
        fprintf(stderr, "DEBUG read_header: pos=%llu + L=%u > len=%u\n", 
                (unsigned long long)pos, L, len);
        return DP_ERR_FORMAT;
    }

    *out_len = L;
    *out_num = num;
    return DP_OK;
}

/* --- Section 0: Indicator --- */
static int grib2_parse_indicator(dp_cursor_t* c, uint32_t* message_len) {
    uint8_t magic[4];
    if (dp_read_bytes(c, magic, 4) != DP_OK) return DP_ERR_EOF;

    if (magic[0] != GRIB2_MAGIC_0 || magic[1] != GRIB2_MAGIC_1 ||
        magic[2] != GRIB2_MAGIC_2 || magic[3] != GRIB2_MAGIC_3)
        return DP_ERR_FORMAT;

    uint16_t reserved;
    if (dp_read_u16(c, &reserved) != DP_OK) return DP_ERR_EOF;

    uint8_t discipline;
    if (dp_read_u8(c, &discipline) != DP_OK) return DP_ERR_EOF;

    uint8_t edition;
    if (dp_read_u8(c, &edition) != DP_OK) return DP_ERR_EOF;
    if (edition != 2) return DP_ERR_FORMAT;

    uint64_t total_len;
    if (dp_read_u64(c, &total_len) != DP_OK) return DP_ERR_EOF;

    *message_len = (uint32_t)total_len;

    fprintf(stderr, "DEBUG: GRIB2 message length=%u\n", *message_len);
    return DP_OK;
}

/* --- Section 3: Grid definitions --- */
static int grib2_parse_grid(dp_cursor_t* c, uint32_t section_len, dp_grid_t* g) {
    uint16_t grid_template;
    if (dp_read_u16(c, &grid_template) != DP_OK)
        return DP_ERR_EOF;

    uint16_t template_num = grid_template & 0x7FFF;

    if (template_num == GRIB2_GRID_LATLON) {
        uint32_t nx, ny, lat1, lon1, lat2, lon2, di, dj;

        if (dp_read_u32(c, &nx) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &ny) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &lat1) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &lon1) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &lat2) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &lon2) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &di) != DP_OK) return DP_ERR_EOF;
        if (dp_read_u32(c, &dj) != DP_OK) return DP_ERR_EOF;

        g->type = DP_GRID_TYPE_REGULAR;
        g->u.regular.nx = nx;
        g->u.regular.ny = ny;
        g->u.regular.lat0 = lat1 / 1e6;
        g->u.regular.lon0 = geo_normalize_lon(lon1 / 1e6);
        g->u.regular.dlon = di / 1e6;
        g->u.regular.dlat = dj / 1e6;

        g->u.regular.data = (float*)dp_alloc(nx * ny * sizeof(float));
        if (!g->u.regular.data)
            return DP_ERR_MEM;

    } else if (template_num == GRIB2_GRID_ICOSAHEDRAL) {
        uint32_t num_points;
        if (dp_read_u32(c, &num_points) != DP_OK)
            return DP_ERR_EOF;

        g->type = DP_GRID_TYPE_POINTS;
        g->u.points.num_points = num_points;

        dp_grid_point_t* pts =
            (dp_grid_point_t*)dp_alloc(num_points * sizeof(dp_grid_point_t));

        if (!pts)
            return DP_ERR_MEM;

        for (uint32_t i = 0; i < num_points; i++) {
            uint32_t lat_u, lon_u;
            if (dp_read_u32(c, &lat_u) != DP_OK) return DP_ERR_EOF;
            if (dp_read_u32(c, &lon_u) != DP_OK) return DP_ERR_EOF;

            pts[i].lat = lat_u / 1e6;
            pts[i].lon = geo_normalize_lon(lon_u / 1e6);
            pts[i].value = 0.0f;
        }

        g->u.points.points = pts;

    } else {
        return DP_ERR_UNSUPPORTED;
    }

    return DP_OK;
}

/* --- Section 7: Simple float unpacking --- */
static int grib2_parse_data_section(
    dp_cursor_t* c,
    uint32_t num_points,
    dp_grid_t* g,
    float reference,
    int binary_scale,
    int decimal_scale,
    uint8_t bits_per_value
) {
    if (g->type == DP_GRID_TYPE_REGULAR) {
        for (uint32_t i = 0; i < num_points; i++) {
            uint32_t raw;
            if (dp_read_bits(c, bits_per_value, &raw) != DP_OK)
                return DP_ERR_EOF;

            double val = reference + raw * pow(2.0, binary_scale);
            val /= pow(10.0, decimal_scale);
            g->u.regular.data[i] = (float)val;
        }

    } else if (g->type == DP_GRID_TYPE_POINTS) {
        for (uint32_t i = 0; i < num_points; i++) {
            uint32_t raw;
            if (dp_read_bits(c, bits_per_value, &raw) != DP_OK)
                return DP_ERR_EOF;

            double val = reference + raw * pow(2.0, binary_scale);
            val /= pow(10.0, decimal_scale);
            g->u.points.points[i].value = (float)val;
        }
    }

    return DP_OK;
}

/* --- Main GRIB2 decoder --- */
int dp_decode_grib2(const uint8_t* data, uint32_t len, dp_grid_t* g) {
    if (!data || !g)
        return DP_ERR_NULL;

    dp_cursor_t c;
    dp_cursor_init(&c, data, len);

    uint32_t message_len;
    int err = grib2_parse_indicator(&c, &message_len);
    if (err != DP_OK)
        return err;

    if (message_len > len)
        return DP_ERR_FORMAT;

    grib2_current_metadata =
        (grib2_metadata_t*)dp_alloc(sizeof(grib2_metadata_t));

    if (!grib2_current_metadata)
        return DP_ERR_MEM;

    memset(grib2_current_metadata, 0, sizeof(*grib2_current_metadata));

    uint32_t num_points = 0;
    float reference = 0.0f;
    int binary_scale = 0;
    int decimal_scale = 0;
    uint8_t bits_per_value = 32;

    while (c.pos < message_len) {
        uint32_t section_start = c.pos;
        uint8_t section_num;
        uint32_t section_len;

        err = grib2_read_section_header(
            c.buf, message_len, c.pos, &section_len, &section_num);

        if (err != DP_OK) {
            fprintf(stderr,
                    "DEBUG: Failed reading section header at pos=%u\n",
                    section_start);
            return err;
        }

        uint32_t section_end = section_start + section_len;
        if (section_end > message_len)
            return DP_ERR_FORMAT;

        fprintf(stderr,
                "DEBUG: Processing section %u, start=%u, end=%u, cursor=%u\n",
                section_num, section_start, section_end, c.pos);

        /* Advance cursor past header */
        c.pos += 5;
        c.bitpos = c.pos << 3;

        switch (section_num) {
            case GRIB2_SECTION_GRID:
                fprintf(stderr,
                        "DEBUG: Parsing grid section, cursor=%u len=%u\n",
                        c.pos, section_len);
                err = grib2_parse_grid(&c, section_len, g);
                if (err != DP_OK) {
                    fprintf(stderr,
                            "DEBUG: Grid parsing failed: %d\n", err);
                    return err;
                }

                num_points = (g->type == DP_GRID_TYPE_REGULAR)
                    ? g->u.regular.nx * g->u.regular.ny
                    : g->u.points.num_points;

                fprintf(stderr,
                        "DEBUG: Grid parsed type=%d, num_points=%u\n",
                        g->type, num_points);
                break;

            case GRIB2_SECTION_DATA_REP:
                if (dp_read_u32(&c, (uint32_t*)&reference) != DP_OK)
                    return DP_ERR_EOF;
                if (dp_read_u16(&c, (uint16_t*)&binary_scale) != DP_OK)
                    return DP_ERR_EOF;
                if (dp_read_u16(&c, (uint16_t*)&decimal_scale) != DP_OK)
                    return DP_ERR_EOF;
                bits_per_value = 32;
                break;

            case GRIB2_SECTION_DATA:
                err = grib2_parse_data_section(
                    &c, num_points, g,
                    reference, binary_scale,
                    decimal_scale, bits_per_value);

                if (err != DP_OK)
                    return err;
                break;

            case GRIB2_SECTION_END:
                return DP_OK;

            default:
                break;
        }

        c.pos = section_end;
        c.bitpos = c.pos << 3;
    }

    return DP_OK;
}

/* --- Get metadata --- */
grib2_metadata_t* grib2_get_metadata(void) {
    return grib2_current_metadata;
}

/* --- Indexing API --- */
int grib2_index(
    const uint8_t* data,
    uint32_t len,
    grib2_field_descriptor_t* out,
    uint32_t max_fields,
    uint32_t* found_fields
) {
    *found_fields = 0;

    if (!data || len < 16)
        return DP_ERR_NULL;

    if (memcmp(data, "GRIB", 4) != 0) {
        fprintf(stderr, "DEBUG grib2_index: Not a GRIB file\n");
        return DP_ERR_FORMAT;
    }

    if (data[7] != 2) {
        fprintf(stderr, "DEBUG grib2_index: Not GRIB2 (edition=%d)\n", data[7]);
        return DP_ERR_FORMAT;
    }

    fprintf(stderr, "DEBUG grib2_index: First 32 bytes: ");
    for (int i = 0; i < 32 && i < len; i++) {
        fprintf(stderr, "%02x ", data[i]);
        if ((i + 1) % 16 == 0) fprintf(stderr, "\n");
    }
    fprintf(stderr, "\n");

    uint64_t total_length =
        ((uint64_t)read_be32(data + 8) << 32) |
        (uint64_t)read_be32(data + 12);

    fprintf(stderr, "DEBUG grib2_index: total_length=%llu (from bytes 8-15: %08x %08x), buffer_len=%u\n", 
            (unsigned long long)total_length, read_be32(data + 8), read_be32(data + 12), len);

    if (total_length > len)
        total_length = len;

    /* Check if section 1 starts immediately after section 0 or if there's padding */
    uint64_t pos = 16;
    
    /* Try to find the first valid section header */
    for (uint64_t try_pos = 16; try_pos < 32 && try_pos + 5 <= len; try_pos++) {
        uint32_t test_len = read_be32(data + try_pos);
        uint8_t test_num = data[try_pos + 4];
        if (test_len >= 5 && test_len < 1000000 && test_num >= 1 && test_num <= 7) {
            fprintf(stderr, "DEBUG grib2_index: Found valid section header at pos=%llu: len=%u, num=%u\n",
                    (unsigned long long)try_pos, test_len, test_num);
            pos = try_pos;
            break;
        }
    }
    
    uint32_t field_count = 0;

    while (pos + 4 < total_length) {
        if (field_count >= max_fields)
            break;

        grib2_field_descriptor_t d;
        memset(&d, 0, sizeof(d));
        d.message_start = pos;

        int have1=0, have3=0, have4=0, have5=0, have7=0;

        while (1) {
            uint32_t sec_len = 0;
            uint8_t sec_no = 0;

            if (pos + 4 <= len &&
                data[pos] == '7' && data[pos+1] == '7' &&
                data[pos+2] == '7' && data[pos+3] == '7') {
                fprintf(stderr, "DEBUG grib2_index: Found 7777 end section at pos=%llu\n", 
                        (unsigned long long)pos);
                pos += 4;
                break;
            }

            fprintf(stderr, "DEBUG grib2_index: Reading section header at pos=%llu\n", 
                    (unsigned long long)pos);

            int err = grib2_read_section_header(
                data, len, pos, &sec_len, &sec_no);

            if (err != DP_OK) {
                fprintf(stderr, "DEBUG grib2_index: Failed reading section header at pos=%llu, err=%d\n", 
                        (unsigned long long)pos, err);
                return err;
            }

            fprintf(stderr, "DEBUG grib2_index: Section %u, len=%u\n", sec_no, sec_len);
            
            /* Validate section number */
            if (sec_no < 1 || sec_no > 7) {
                fprintf(stderr, "DEBUG grib2_index: Invalid section number %u at pos=%llu, stopping\n",
                        sec_no, (unsigned long long)pos);
                /* Try to find next valid section by scanning forward */
                uint64_t scan_pos = pos + 1;
                int found_next = 0;
                for (; scan_pos < pos + 100 && scan_pos + 5 <= len; scan_pos++) {
                    uint32_t test_len = read_be32(data + scan_pos);
                    uint8_t test_num = data[scan_pos + 4];
                    if (test_len >= 5 && test_len < 10000000 && test_num >= 1 && test_num <= 7) {
                        fprintf(stderr, "DEBUG grib2_index: Found next valid section at pos=%llu: len=%u, num=%u\n",
                                (unsigned long long)scan_pos, test_len, test_num);
                        pos = scan_pos;
                        found_next = 1;
                        break;
                    }
                }
                if (!found_next) {
                    fprintf(stderr, "DEBUG grib2_index: Could not find next valid section, breaking\n");
                    pos = total_length; /* Force exit outer loop to prevent infinite recursion */
                    break;
                }
                continue;
            }

            uint64_t sec_start = pos;
            uint64_t sec_end = pos + sec_len;

            switch (sec_no) {
                case 1:
                    d.sec1_offset = sec_start;
                    have1 = 1;
                    break;

                case 3:
                    d.sec3_offset = sec_start;
                    have3 = 1;

                    if (sec_len < 14)
                        return DP_ERR_FORMAT;

                    /* Read grid template (skip 5-byte section header + 7 bytes) */
                    d.grid_template =
                        (data[sec_start + 12] << 8) |
                         data[sec_start + 13];
                    
                    uint16_t template_num = d.grid_template & 0x7FFF;
                    
                    /* For lat/lon grids, read nx/ny */
                    if (template_num == GRIB2_GRID_LATLON) {
                        if (sec_len < 72)
                            return DP_ERR_FORMAT;
                        
                        d.nx = (data[sec_start + 30] << 8) |
                                data[sec_start + 31];
                        
                        d.ny = (data[sec_start + 34] << 8) |
                                data[sec_start + 35];
                        
                        if (!d.nx || !d.ny ||
                            d.nx > 50000 || d.ny > 50000)
                            return DP_ERR_FORMAT;
                    } else if (template_num == GRIB2_GRID_ICOSAHEDRAL) {
                        /* For icosahedral grids, read num_points instead */
                        if (sec_len < 20)
                            return DP_ERR_FORMAT;
                        
                        uint32_t num_points = read_be32(data + sec_start + 14);
                        /* Store num_points in nx field for compatibility */
                        d.nx = (num_points > UINT16_MAX) ? 0 : (uint32_t)num_points;
                        d.ny = 1; /* Placeholder for icosahedral */
                    } else {
                        /* Other grid types - set placeholder values */
                        d.nx = 0;
                        d.ny = 0;
                    }
                    break;

                case 4:
                    d.sec4_offset = sec_start;
                    have4 = 1;

                    if (sec_len < 34)
                        return DP_ERR_FORMAT;

                    d.param_category = data[sec_start + 9];
                    d.param_number  = data[sec_start + 10];

                    d.data_template =
                        (data[sec_start + 7] << 8) |
                         data[sec_start + 8];
                    break;

                case 5:
                    d.sec5_offset = sec_start;
                    have5 = 1;
                    break;

                case 6:
                    d.sec6_offset = sec_start;
                    break;

                case 7:
                    d.sec7_offset = sec_start;
                    have7 = 1;
                    d.message_end = sec_end;
                    break;

                default:
                    break;
            }

            pos = sec_end;

            if (have1 && have3 && have4 && have5 && have7)
                break;

            if (sec_no == 7)
                break;
        }

        if (have1 && have3 && have4 && have5 && have7)
            out[field_count++] = d;
    }

    *found_fields = field_count;
    return (field_count > 0) ? DP_OK : DP_ERR_NOTFOUND;
}

/* --- Metadata-only parser (for file loading) --- */
/* This function only reads metadata/headers, does not allocate data arrays */
int dp_decode_grib2_metadata(const uint8_t* data, uint32_t len, dp_grid_t* g) {
    if (!data || !g)
        return DP_ERR_NULL;

    /* Use grib2_index to read metadata only */
    grib2_field_descriptor_t field_desc;
    uint32_t found_fields = 0;
    
    int err = grib2_index(data, len, &field_desc, 1, &found_fields);
    if (err != DP_OK || found_fields == 0)
        return err;

    /* Set up minimal grid structure with metadata only (no data allocation) */
    memset(g, 0, sizeof(dp_grid_t));
    
    /* Determine grid type from template */
    uint16_t template_num = field_desc.grid_template & 0x7FFF;
    
    if (template_num == GRIB2_GRID_LATLON) {
        /* Read grid coordinates from section 3 without allocating data */
        if (field_desc.sec3_offset == 0 || field_desc.sec3_offset + 72 > len)
            return DP_ERR_FORMAT;
        
        const uint8_t* sec3 = data + field_desc.sec3_offset;
        uint32_t sec3_len = read_be32(sec3);
        
        if (sec3_len < 72)
            return DP_ERR_FORMAT;
        
        /* Read grid definition (skip section header: 5 bytes + 7 bytes before template) */
        const uint8_t* grid_data = sec3 + 12;
        uint16_t grid_template = (grid_data[0] << 8) | grid_data[1];
        uint16_t template_num_check = grid_template & 0x7FFF;
        
        if (template_num_check != GRIB2_GRID_LATLON)
            return DP_ERR_FORMAT;
        
        /* Read lat/lon grid parameters (template is 2 bytes, then template-specific data) */
        uint32_t nx = read_be32(grid_data + 2);
        uint32_t ny = read_be32(grid_data + 6);
        uint32_t lat1 = read_be32(grid_data + 10);
        uint32_t lon1 = read_be32(grid_data + 14);
        /* lat2 and lon2 not needed for metadata-only parsing */
        uint32_t di = read_be32(grid_data + 26);
        uint32_t dj = read_be32(grid_data + 30);
        
        g->type = DP_GRID_TYPE_REGULAR;
        g->u.regular.nx = nx;
        g->u.regular.ny = ny;
        g->u.regular.lat0 = lat1 / 1e6;
        g->u.regular.lon0 = geo_normalize_lon(lon1 / 1e6);
        g->u.regular.dlon = di / 1e6;
        g->u.regular.dlat = dj / 1e6;
        /* Metadata only - data pointer remains NULL */
        g->u.regular.data = NULL;
        
    } else if (template_num == GRIB2_GRID_ICOSAHEDRAL) {
        /* Read icosahedral grid metadata from section 3 */
        if (field_desc.sec3_offset == 0 || field_desc.sec3_offset + 20 > len)
            return DP_ERR_FORMAT;
        
        const uint8_t* sec3 = data + field_desc.sec3_offset;
        /* Skip section header (5 bytes) + 7 bytes before template */
        const uint8_t* grid_data = sec3 + 12;
        uint16_t grid_template = (grid_data[0] << 8) | grid_data[1];
        uint16_t template_num_check = grid_template & 0x7FFF;
        
        if (template_num_check != GRIB2_GRID_ICOSAHEDRAL)
            return DP_ERR_FORMAT;
        
        /* num_points is right after the 2-byte template */
        uint32_t num_points = read_be32(grid_data + 2);
        
        g->type = DP_GRID_TYPE_POINTS;
        g->u.points.num_points = num_points;
        /* Metadata only - points array remains NULL */
        g->u.points.points = NULL;
    } else {
        return DP_ERR_UNSUPPORTED;
    }

    return DP_OK;
}
