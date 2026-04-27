#ifndef NETCDF3_H
#define NETCDF3_H

/*
 * netcdf3.h  --  NetCDF-3 (Classic + 64-bit offset) parser
 *
 * Supports:
 *   - Version 1: Classic (32-bit offsets)
 *   - Version 2: 64-bit offset
 *
 * Does NOT support NetCDF-4 (HDF5-based). Check magic bytes first.
 *
 * Magic:
 *   NetCDF3 Classic:   0x43 0x44 0x46 0x01  ('CDF\x01')
 *   NetCDF3 64-bit:    0x43 0x44 0x46 0x02  ('CDF\x02')
 *   NetCDF4 (HDF5):    0x89 0x48 0x44 0x46  (not handled here)
 */

#include <stdint.h>
#include <stddef.h>

/* =========================================================================
 * Limits
 * ======================================================================= */

#define NC3_MAX_NAME  256
#define NC3_MAX_DIMS   64
#define NC3_MAX_VARS  512
#define NC3_MAX_ATTS  128

/* =========================================================================
 * NetCDF3 data types
 * ======================================================================= */

typedef enum {
    NC3_BYTE   = 1,   /* int8   */
    NC3_CHAR   = 2,   /* char   */
    NC3_SHORT  = 3,   /* int16  */
    NC3_INT    = 4,   /* int32  */
    NC3_FLOAT  = 5,   /* float  */
    NC3_DOUBLE = 6    /* double */
} nc3_type_t;

/* Default fill values (IEEE) */
#define NC3_FILL_FLOAT  9.9692099683868690e+36f
#define NC3_FILL_DOUBLE 9.9692099683868690e+36
#define NC3_FILL_SHORT  ((int16_t)(-32767))
#define NC3_FILL_INT    ((int32_t)(-2147483647))
#define NC3_FILL_BYTE   ((int8_t)(-127))

/* =========================================================================
 * Attribute
 * ======================================================================= */

typedef struct {
    char       name[NC3_MAX_NAME];
    nc3_type_t type;
    uint32_t   nelems;
    /* Inline storage for small attributes (covers most real-world cases).
     * For large attributes (e.g. long char strings) only the first
     * NC3_ATT_INLINE_BYTES bytes are stored; truncated with '\0'. */
    char       value[512];
} nc3_att_t;

/* =========================================================================
 * Dimension
 * ======================================================================= */

typedef struct {
    char     name[NC3_MAX_NAME];
    uint32_t length;       /* 0 means unlimited (record dimension) */
    int      is_unlimited;
} nc3_dim_t;

/* =========================================================================
 * Variable
 * ======================================================================= */

typedef struct {
    char       name[NC3_MAX_NAME];
    nc3_type_t type;
    uint32_t   ndims;
    uint32_t   dimids[NC3_MAX_DIMS];  /* indices into nc3_file_t.dims[] */
    uint32_t   natts;
    nc3_att_t  atts[NC3_MAX_ATTS];
    uint32_t   vsize;     /* bytes per record (or total for non-record vars) */
    uint64_t   begin;     /* byte offset in file where data starts */
    int        is_record; /* 1 if one of its dims is unlimited */
} nc3_var_t;

/* =========================================================================
 * File header (holds all metadata after parsing)
 * ======================================================================= */

typedef struct {
    uint8_t   version;    /* 1 = classic, 2 = 64-bit offset */
    uint32_t  numrecs;    /* number of records (unlimited dim size) */

    uint32_t  ndims;
    nc3_dim_t dims[NC3_MAX_DIMS];

    uint32_t  ngatts;
    nc3_att_t gatts[NC3_MAX_ATTS];

    uint32_t  nvars;
    nc3_var_t vars[NC3_MAX_VARS];
} nc3_file_t;

/* =========================================================================
 * Function declarations
 * ======================================================================= */

/*
 * nc3_is_netcdf3 — quick magic-byte check.
 * Returns 1 if data looks like NetCDF3, 0 otherwise.
 */
int nc3_is_netcdf3(const uint8_t* data, uint64_t len);

/*
 * nc3_parse_header — parse the full NetCDF3 header into nc.
 * Returns 0 on success, -1 on error.
 */
int nc3_parse_header(const uint8_t* data, uint64_t len, nc3_file_t* nc);

/*
 * nc3_find_var — find variable index by name.
 * Returns index into nc->vars[], or -1 if not found.
 */
int nc3_find_var(const nc3_file_t* nc, const char* name);

/*
 * nc3_find_dim — find dimension index by name.
 * Returns index into nc->dims[], or -1 if not found.
 */
int nc3_find_dim(const nc3_file_t* nc, const char* name);

/*
 * nc3_var_npts — total number of data points in a variable.
 * For record variables, counts across all records.
 */
uint64_t nc3_var_npts(const nc3_file_t* nc, int var_idx);

/*
 * nc3_read_var_float — decode a variable's data to a float array.
 *
 * Applies CF conventions automatically:
 *   - scale_factor and add_offset attributes
 *   - _FillValue / missing_value → NaN
 *
 * out must be pre-allocated to hold nc3_var_npts(nc, var_idx) floats.
 * Returns 0 on success, -1 on error.
 */
int nc3_read_var_float(const nc3_file_t* nc, const uint8_t* data, uint64_t len,
                       int var_idx, float* out);

/*
 * nc3_get_att_string — get a string attribute value from a variable.
 * Returns pointer into att.value[], or NULL if not found.
 */
const char* nc3_get_att_string(const nc3_var_t* var, const char* attname);

/*
 * nc3_get_att_float — get a scalar numeric attribute from a variable.
 * Returns defval if not found.
 */
float nc3_get_att_float(const nc3_var_t* var, const char* attname, float defval);

/*
 * nc3_type_size — byte size of a NetCDF3 type.
 */
uint32_t nc3_type_size(nc3_type_t type);

#endif /* NETCDF3_H */
