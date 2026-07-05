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
 * Lambert conformal grid parameters (Section 3, template 30).
 */
typedef struct {
    uint32_t nx, ny;
    double   lat1, lon1;     /* lat/lon of first grid point (degrees) */
    double   lad;            /* latitude where Dx/Dy are specified */
    double   lov;            /* orientation longitude (parallel to y-axis) */
    double   dx, dy;         /* grid spacing in meters */
    double   latin1, latin2; /* secant cone latitudes */
    uint8_t  proj_flag;      /* projection center flag */
    uint8_t  scanning_mode;
} grid_lambert_t;

/*
 * Polar stereographic grid parameters (Section 3, template 20).
 */
typedef struct {
    uint32_t nx, ny;
    double   lat1, lon1;     /* first grid point (degrees) */
    double   lad;            /* standard/true-scale latitude (degrees) */
    double   lov;            /* orientation longitude (degrees) */
    double   dx, dy;         /* grid spacing at LaD (meters) */
    uint8_t  proj_flag;      /* projection-centre flag: bit 0x80 set = south pole */
    uint8_t  scanning_mode;
    double   earth_radius;   /* meters (WMO 6371229 default) */
} grid_polar_t;

/*
 * Unstructured (general) grid parameters (Section 3, template 101).
 * Used by ICON (DWD) and other unstructured-mesh models.  The cell
 * coordinates are NOT stored in the GRIB2 message — they live in an
 * external grid file identified by uuid[16].
 */
typedef struct {
    uint32_t num_points;            /* total number of cells/points */
    uint8_t  grid_point_position;   /* codetable 3.13: 0=cell center */
    uint8_t  numbering_order;       /* codetable 3.16 */
    uint32_t number_of_grid_used;
    uint32_t number_of_grid_in_ref;
    uint8_t  uuid[16];              /* identifies the external grid file */
} grid_unstructured_t;

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

/*
 * Section 6 bit-map.
 *   indicator: 0   = bit map included here (bits/nbytes valid)
 *              255 = no bit map (all grid points present)
 *              1-254 = pre-defined / previously-defined (unsupported)
 * Bits are MSB-first, one per grid point, 1 = value present.
 */
typedef struct {
    uint8_t        indicator;
    const uint8_t* bits;    /* NULL unless indicator == 0 */
    uint32_t       nbytes;  /* number of bitmap bytes available */
} bitmap_t;

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
int     parse_sec3_lambert(const uint8_t* sec, uint32_t sec_len,
                           grid_lambert_t* g);
int     parse_sec3_unstructured(const uint8_t* sec, uint32_t sec_len,
                                grid_unstructured_t* g);
int     parse_sec3_polar(const uint8_t* sec, uint32_t sec_len,
                         grid_polar_t* g);
int64_t parse_sec1_reftime(const uint8_t* sec, uint32_t sec_len);
int64_t parse_sec4_forecast_offset(const uint8_t* sec, uint32_t sec_len);
int     parse_sec5(const uint8_t* sec, uint32_t sec_len, packing_t* pk);

/* Section 6 bit-map. Returns 0 on success (bm populated), -1 on malformed input. */
int      parse_sec6(const uint8_t* sec, uint32_t sec_len, bitmap_t* bm);
/* Test grid point i in a bit map (MSB-first). Returns 1 if present, else 0. */
int      bitmap_get(const bitmap_t* bm, uint32_t i);
/* Count present points over the first n grid points of a bit map. */
uint32_t bitmap_popcount(const bitmap_t* bm, uint32_t n);

/* Lambert conformal projection: compute lat/lon arrays for all grid points.
 * Caller must allocate lats[ny*nx] and lons[ny*nx]. */
int lambert_compute_latlon(const grid_lambert_t* g,
                           float* lats, float* lons);

/* Polar stereographic projection: compute lat/lon arrays for all grid points.
 * Caller must allocate lats[ny*nx] and lons[ny*nx]. */
int polar_stereo_compute_latlon(const grid_polar_t* g,
                                float* lats, float* lons);

/* Inverse polar stereographic: (lat,lon in degrees) → fractional grid (i,j).
 * Round to nearest int for the covering cell; caller checks 0<=i<nx, 0<=j<ny. */
int polar_stereo_inverse(const grid_polar_t* g, double lat, double lon,
                         double* fi, double* fj);

/* Data decoders */
int decode_simple (const uint8_t* payload, uint32_t payload_len,
                   const packing_t* pk, float* out);
int decode_complex(const uint8_t* payload, uint32_t payload_len,
                   const packing_t* pk, float* out);
int decode_sec7   (const uint8_t* sec7, uint32_t sec7_len,
                   const packing_t* pk, float* out_f32);

#endif /* GRIB2_CONVERT_HELPERS_H */
