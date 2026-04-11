#ifndef GRIB2_CONVERT_HELPERS_H
#define GRIB2_CONVERT_HELPERS_H

/*
 * grib2converthelpers.h -- GRIB2 parsing & decoding helpers
 *
 * Used by tools/normalize_refs.c (offline normalizer).
 * Never compiled to WASM.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* =========================================================================
 * Big-endian read helpers  (GRIB2 is always big-endian)
 * Defined as static inline so any translation unit that includes this
 * header gets its own copy without link-time conflicts.
 * ======================================================================= */

static inline uint16_t be16(const uint8_t* p) {
    return (uint16_t)((p[0] << 8) | p[1]);
}

static inline uint32_t be32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] <<  8) |  (uint32_t)p[3];
}

static inline uint64_t be64(const uint8_t* p) {
    return ((uint64_t)be32(p) << 32) | (uint64_t)be32(p + 4);
}

/*
 * GRIB2 signed integer encoding: bit 31/15 is the sign bit, the remaining
 * bits are the magnitude (NOT two's complement).
 */
static inline int32_t grib2_i32(const uint8_t* p) {
    uint32_t raw = be32(p);
    if (raw & 0x80000000u) return -(int32_t)(raw & 0x7FFFFFFFu);
    return (int32_t)raw;
}

static inline int16_t grib2_i16(const uint8_t* p) {
    uint16_t raw = be16(p);
    if (raw & 0x8000u) return -(int16_t)(raw & 0x7FFFu);
    return (int16_t)raw;
}

/* IEEE 754 float from 4 big-endian bytes */
static inline float be_float(const uint8_t* p) {
    uint32_t raw = be32(p);
    float    val;
    memcpy(&val, &raw, sizeof(val));
    return val;
}

/* =========================================================================
 * Structs
 * ======================================================================= */

/*
 * Offsets and key metadata for one GRIB2 message found in a file.
 */
typedef struct {
    uint64_t sec1_off, sec1_len;
    uint64_t sec3_off, sec3_len;
    uint64_t sec4_off, sec4_len;
    uint64_t sec5_off, sec5_len;
    uint64_t sec6_off;           /* 0 if absent */
    uint64_t sec7_off, sec7_len;
    uint16_t grid_template;
    uint16_t data_template;
    uint8_t  param_cat;
    uint8_t  param_num;
} grib2_msg_t;

/*
 * Regular lat/lon grid parameters (Section 3, template 0 or 40).
 */
typedef struct {
    uint32_t nx, ny;
    double   lat1, lon1;
    double   lat2, lon2;
    double   di,   dj;
    uint8_t  scanning_mode;
} grid_latlon_t;

/*
 * Packing parameters (Section 5, templates 0 and 3).
 */
typedef struct {
    uint32_t num_pts;
    float    ref_val;
    int16_t  binary_scale;
    int16_t  decimal_scale;
    uint8_t  bits_per_value;
    uint16_t tmpl;

    /* template 3 (complex packing + spatial differencing) only */
    uint32_t num_groups;
    uint8_t  ref_group_width;
    uint8_t  bits_group_width;
    uint32_t ref_group_len;
    uint8_t  len_increment;
    uint32_t last_group_len;
    uint8_t  bits_group_len;
    uint8_t  spatial_order;   /* 1 or 2 */
    uint8_t  extra_octets;
} packing_t;

/* =========================================================================
 * Function declarations
 * ======================================================================= */

/* MSB-first bit extraction from a byte buffer.
 * buf_len is the number of bytes available at buf.
 * bit_off is the bit offset from buf[0] (0 = MSB of buf[0]).
 * n_bits is the number of bits to extract (<= 32).
 */
uint32_t extract_bits(const uint8_t* buf, uint64_t buf_len,
                      uint64_t bit_off, uint8_t n_bits);

/* Section parsers */
int     parse_message(const uint8_t* data, uint64_t file_len,
                      uint64_t msg_start, uint64_t msg_end, grib2_msg_t* m);
int     index_messages(const uint8_t* data, uint64_t file_len,
                       grib2_msg_t** msgs_out);
int     parse_sec3_latlon(const uint8_t* sec, uint32_t sec_len,
                          grid_latlon_t* g);
int64_t parse_sec1_reftime(const uint8_t* sec, uint32_t sec_len);
int64_t parse_sec4_forecast_offset(const uint8_t* sec, uint32_t sec_len);
int     parse_sec5(const uint8_t* sec, uint32_t sec_len, packing_t* pk);

/* Data decoders */
int decode_simple (const uint8_t* payload, uint32_t payload_len,
                   const packing_t* pk, float* out);
int decode_complex(const uint8_t* payload, uint32_t payload_len,
                   const packing_t* pk, float* out);
int decode_sec7   (const uint8_t* sec7, uint32_t sec7_len,
                   const packing_t* pk, float* out_f32);

#endif /* GRIB2_CONVERT_HELPERS_H */
