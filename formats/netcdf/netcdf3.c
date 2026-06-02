/*
 * netcdf3.c  --  NetCDF-3 (Classic + 64-bit offset) parser
 *
 * Spec reference:
 *   https://docs.unidata.ucar.edu/nug/current/file_format_specifications.html
 *
 * Format overview:
 *   header = magic numrecs dim_list gatt_list var_list
 *   data   = [non-record vars] [record vars interleaved]
 *
 * All multi-byte integers are big-endian.
 * All data values are big-endian.
 * All items are padded to 4-byte boundaries.
 */

#include "netcdf3.h"
#include <string.h>
#include <math.h>   /* NAN, INFINITY */
#include <stdio.h>

/* =========================================================================
 * Internal tag constants
 * ======================================================================= */

#define TAG_ZERO         0x00000000u
#define TAG_NC_DIMENSION 0x0000000Au
#define TAG_NC_VARIABLE  0x0000000Bu
#define TAG_NC_ATTRIBUTE 0x0000000Cu

/* =========================================================================
 * Read cursor helpers
 * ======================================================================= */

typedef struct {
    const uint8_t* data;
    uint64_t       len;
    uint64_t       pos;
    int            version;  /* 1 or 2 — affects offset width */
} nc3_cursor_t;

static int cur_ok(const nc3_cursor_t* c, uint64_t n) {
    return (c->pos + n <= c->len);
}

static uint8_t cur_u8(nc3_cursor_t* c) {
    return c->data[c->pos++];
}

static uint32_t cur_u32(nc3_cursor_t* c) {
    if (!cur_ok(c, 4)) return 0;
    uint32_t v = ((uint32_t)c->data[c->pos]   << 24) |
                 ((uint32_t)c->data[c->pos+1] << 16) |
                 ((uint32_t)c->data[c->pos+2] <<  8) |
                  (uint32_t)c->data[c->pos+3];
    c->pos += 4;
    return v;
}

static int32_t cur_i32(nc3_cursor_t* c) {
    return (int32_t)cur_u32(c);
}

static uint64_t cur_offset(nc3_cursor_t* c) {
    /* Version 2 uses 64-bit offsets; version 1 uses 32-bit */
    if (c->version == 2) {
        if (!cur_ok(c, 8)) return 0;
        uint64_t hi = cur_u32(c);
        uint64_t lo = cur_u32(c);
        return (hi << 32) | lo;
    }
    return (uint64_t)cur_u32(c);
}

/* Skip to next 4-byte boundary after 'count' bytes were consumed */
static void cur_align4(nc3_cursor_t* c, uint64_t count) {
    uint64_t pad = (4 - (count % 4)) % 4;
    c->pos += pad;
}

/* Read a NetCDF name: uint32 nchars + chars (padded to 4) */
static int cur_read_name(nc3_cursor_t* c, char* out, size_t out_size) {
    uint32_t n = cur_u32(c);
    if (n >= out_size) return -1;
    if (!cur_ok(c, n)) return -1;
    memcpy(out, c->data + c->pos, n);
    out[n] = '\0';
    c->pos += n;
    cur_align4(c, n);
    return 0;
}

/* =========================================================================
 * Type helpers
 * ======================================================================= */

uint32_t nc3_type_size(nc3_type_t type) {
    switch (type) {
        case NC3_BYTE:   return 1;
        case NC3_CHAR:   return 1;
        case NC3_SHORT:  return 2;
        case NC3_INT:    return 4;
        case NC3_FLOAT:  return 4;
        case NC3_DOUBLE: return 8;
        default:         return 0;
    }
}

/* =========================================================================
 * Read one attribute (att = name nc_type nelems values)
 * ======================================================================= */

static int parse_att(nc3_cursor_t* c, nc3_att_t* att) {
    if (cur_read_name(c, att->name, NC3_MAX_NAME) != 0) return -1;
    att->type   = (nc3_type_t)cur_u32(c);
    att->nelems = cur_u32(c);

    uint32_t elem_size = nc3_type_size(att->type);
    uint64_t nbytes    = (uint64_t)att->nelems * elem_size;

    if (!cur_ok(c, nbytes)) return -1;

    /* Copy up to 511 bytes into inline value buffer */
    uint64_t copy = nbytes < 511 ? nbytes : 511;
    memcpy(att->value, c->data + c->pos, (size_t)copy);
    att->value[copy] = '\0';

    c->pos += nbytes;
    cur_align4(c, nbytes);
    return 0;
}

/* =========================================================================
 * Read attribute list (att_list = ABSENT | NC_ATTRIBUTE nelems [att...])
 * ======================================================================= */

static int parse_att_list(nc3_cursor_t* c, nc3_att_t* atts,
                           uint32_t* nout, uint32_t max) {
    uint32_t tag = cur_u32(c);
    uint32_t n   = cur_u32(c);

    if (tag == TAG_ZERO) { *nout = 0; return 0; }
    if (tag != TAG_NC_ATTRIBUTE) return -1;
    if (n > max) n = max;  /* silently truncate */

    *nout = n;
    for (uint32_t i = 0; i < n; i++) {
        if (parse_att(c, &atts[i]) != 0) return -1;
    }
    return 0;
}

/* =========================================================================
 * nc3_parse_header
 * ======================================================================= */

int nc3_is_netcdf3(const uint8_t* data, uint64_t len) {
    if (len < 4) return 0;
    return (data[0] == 'C' && data[1] == 'D' && data[2] == 'F' &&
            (data[3] == 1 || data[3] == 2));
}

int nc3_parse_header(const uint8_t* data, uint64_t len, nc3_file_t* nc) {
    if (!data || !nc) return -1;
    if (!nc3_is_netcdf3(data, len)) return -1;

    memset(nc, 0, sizeof(*nc));

    nc3_cursor_t c;
    c.data    = data;
    c.len     = len;
    c.pos     = 0;
    c.version = data[3]; /* 1 or 2 */

    nc->version = (uint8_t)c.version;

    /* Skip magic (4 bytes) */
    c.pos = 4;

    /* numrecs */
    nc->numrecs = cur_u32(&c);

    /* --- dim_list --- */
    uint32_t tag = cur_u32(&c);
    uint32_t n   = cur_u32(&c);

    if (tag == TAG_NC_DIMENSION) {
        if (n > NC3_MAX_DIMS) n = NC3_MAX_DIMS;
        nc->ndims = n;
        for (uint32_t i = 0; i < n; i++) {
            if (cur_read_name(&c, nc->dims[i].name, NC3_MAX_NAME) != 0) return -1;
            uint32_t len_val = cur_u32(&c);
            nc->dims[i].length       = len_val;
            nc->dims[i].is_unlimited = (len_val == 0) ? 1 : 0;
            /* unlimited dim gets its size from numrecs */
            if (nc->dims[i].is_unlimited)
                nc->dims[i].length = nc->numrecs;
        }
    } else if (tag != TAG_ZERO) {
        return -1;  /* unexpected tag */
    }

    /* --- gatt_list (global attributes) --- */
    if (parse_att_list(&c, nc->gatts, &nc->ngatts, NC3_MAX_ATTS) != 0) return -1;

    /* --- var_list --- */
    tag = cur_u32(&c);
    n   = cur_u32(&c);

    if (tag == TAG_NC_VARIABLE) {
        if (n > NC3_MAX_VARS) n = NC3_MAX_VARS;
        nc->nvars = n;

        for (uint32_t i = 0; i < n; i++) {
            nc3_var_t* v = &nc->vars[i];

            if (cur_read_name(&c, v->name, NC3_MAX_NAME) != 0) return -1;

            /* dimids */
            uint32_t ndims = cur_u32(&c);
            if (ndims > NC3_MAX_DIMS) return -1;
            v->ndims = ndims;
            for (uint32_t d = 0; d < ndims; d++)
                v->dimids[d] = cur_u32(&c);

            /* variable attributes */
            if (parse_att_list(&c, v->atts, &v->natts, NC3_MAX_ATTS) != 0) return -1;

            /* type, vsize, begin */
            v->type  = (nc3_type_t)cur_u32(&c);
            v->vsize = cur_u32(&c);
            v->begin = cur_offset(&c);

            /* is_record: check if any dimid is the unlimited dim */
            v->is_record = 0;
            for (uint32_t d = 0; d < ndims; d++) {
                uint32_t did = v->dimids[d];
                if (did < nc->ndims && nc->dims[did].is_unlimited) {
                    v->is_record = 1;
                    break;
                }
            }
        }
    } else if (tag != TAG_ZERO) {
        return -1;
    }

    return 0;
}

/* =========================================================================
 * Lookup helpers
 * ======================================================================= */

int nc3_find_var(const nc3_file_t* nc, const char* name) {
    for (uint32_t i = 0; i < nc->nvars; i++)
        if (strcmp(nc->vars[i].name, name) == 0) return (int)i;
    return -1;
}

int nc3_find_dim(const nc3_file_t* nc, const char* name) {
    for (uint32_t i = 0; i < nc->ndims; i++)
        if (strcmp(nc->dims[i].name, name) == 0) return (int)i;
    return -1;
}

uint64_t nc3_var_npts(const nc3_file_t* nc, int var_idx) {
    if (var_idx < 0 || (uint32_t)var_idx >= nc->nvars) return 0;
    const nc3_var_t* v = &nc->vars[var_idx];
    if (v->ndims == 0) return 1;

    uint64_t total = 1;
    for (uint32_t d = 0; d < v->ndims; d++) {
        uint32_t did = v->dimids[d];
        if (did < nc->ndims)
            total *= nc->dims[did].length;
    }
    return total;
}

/* =========================================================================
 * Attribute accessors
 * ======================================================================= */

const char* nc3_get_att_string(const nc3_var_t* var, const char* attname) {
    for (uint32_t i = 0; i < var->natts; i++)
        if (strcmp(var->atts[i].name, attname) == 0)
            return var->atts[i].value;
    return NULL;
}

float nc3_get_att_float(const nc3_var_t* var, const char* attname, float defval) {
    for (uint32_t i = 0; i < var->natts; i++) {
        const nc3_att_t* a = &var->atts[i];
        if (strcmp(a->name, attname) != 0) continue;
        /* Parse first element from inline value buffer */
        const uint8_t* p = (const uint8_t*)a->value;
        switch (a->type) {
            case NC3_FLOAT: {
                uint32_t raw = ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|
                               ((uint32_t)p[2]<<8)|(uint32_t)p[3];
                float f; memcpy(&f, &raw, 4); return f;
            }
            case NC3_DOUBLE: {
                uint64_t hi = ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|
                              ((uint32_t)p[2]<<8)|(uint32_t)p[3];
                uint64_t lo = ((uint32_t)p[4]<<24)|((uint32_t)p[5]<<16)|
                              ((uint32_t)p[6]<<8)|(uint32_t)p[7];
                uint64_t raw = (hi<<32)|lo;
                double d; memcpy(&d, &raw, 8); return (float)d;
            }
            case NC3_SHORT: {
                int16_t s = (int16_t)(((uint16_t)p[0]<<8)|(uint16_t)p[1]);
                return (float)s;
            }
            case NC3_INT: {
                int32_t iv = (int32_t)(((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|
                                       ((uint32_t)p[2]<<8)|(uint32_t)p[3]);
                return (float)iv;
            }
            default: return defval;
        }
    }
    return defval;
}

/* =========================================================================
 * Internal: decode one big-endian element to float
 * ======================================================================= */

static float nc3_decode_one(nc3_type_t type, const uint8_t* p) {
    switch (type) {
        case NC3_FLOAT: {
            uint32_t raw = ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|
                           ((uint32_t)p[2]<<8)|(uint32_t)p[3];
            float f; memcpy(&f, &raw, 4); return f;
        }
        case NC3_DOUBLE: {
            uint64_t hi = ((uint64_t)p[0]<<24)|((uint64_t)p[1]<<16)|
                          ((uint64_t)p[2]<<8)|(uint64_t)p[3];
            uint64_t lo = ((uint64_t)p[4]<<24)|((uint64_t)p[5]<<16)|
                          ((uint64_t)p[6]<<8)|(uint64_t)p[7];
            uint64_t raw = (hi<<32)|lo;
            double d; memcpy(&d, &raw, 8); return (float)d;
        }
        case NC3_SHORT: {
            int16_t s = (int16_t)(((uint16_t)p[0]<<8)|(uint16_t)p[1]);
            return (float)s;
        }
        case NC3_INT: {
            int32_t iv = (int32_t)(((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|
                                   ((uint32_t)p[2]<<8)|(uint32_t)p[3]);
            return (float)iv;
        }
        case NC3_BYTE:
            return (float)(int8_t)p[0];
        case NC3_CHAR:
            return (float)(uint8_t)p[0];
        default:
            return NAN;
    }
}

/* =========================================================================
 * nc3_read_var_float — main decode function
 *
 * Handles both:
 *   Non-record variables: data stored contiguously at v->begin
 *   Record variables:     data interleaved by time step — each record
 *                         contains one time step of all record variables.
 *                         record_stride = sum of vsize for all record vars.
 * ======================================================================= */

int nc3_read_var_float(const nc3_file_t* nc, const uint8_t* data, uint64_t len,
                       int var_idx, float* out) {
    if (!nc || !data || !out) return -1;
    if (var_idx < 0 || (uint32_t)var_idx >= nc->nvars) return -1;

    const nc3_var_t* v = &nc->vars[var_idx];
    uint32_t         es = nc3_type_size(v->type);
    if (es == 0) return -1;

    /* CF conventions: scale_factor, add_offset, _FillValue */
    float scale  = nc3_get_att_float(v, "scale_factor", 1.0f);
    float offset = nc3_get_att_float(v, "add_offset",   0.0f);
    float fill   = nc3_get_att_float(v, "_FillValue",   NC3_FILL_FLOAT);
    float miss   = nc3_get_att_float(v, "missing_value", fill);

    if (v->is_record) {
        /* --- Record variable: interleaved storage ---
         * record_stride = total bytes per time step across ALL record vars */
        uint64_t record_stride = 0;
        for (uint32_t vi = 0; vi < nc->nvars; vi++) {
            if (nc->vars[vi].is_record)
                record_stride += nc->vars[vi].vsize;
        }
        if (record_stride == 0) record_stride = v->vsize;

        /* Points per record (one time step of this variable) */
        uint64_t pts_per_rec = (uint64_t)v->vsize / es;
        uint64_t nt          = (uint64_t)nc->numrecs;
        uint64_t out_idx     = 0;

        for (uint64_t rec = 0; rec < nt; rec++) {
            uint64_t rec_off = v->begin + rec * record_stride;
            if (rec_off + pts_per_rec * es > len) return -1;
            const uint8_t* rp = data + rec_off;

            for (uint64_t i = 0; i < pts_per_rec; i++, rp += es) {
                float val = nc3_decode_one(v->type, rp);
                if (val == fill || val == miss) { out[out_idx++] = NAN; continue; }
                out[out_idx++] = val * scale + offset;
            }
        }
    } else {
        /* --- Non-record variable: contiguous storage --- */
        uint64_t n = nc3_var_npts(nc, var_idx);
        if (v->begin + n * es > len) return -1;
        const uint8_t* p = data + v->begin;

        for (uint64_t i = 0; i < n; i++, p += es) {
            float val = nc3_decode_one(v->type, p);
            if (val == fill || val == miss) { out[i] = NAN; continue; }
            out[i] = val * scale + offset;
        }
    }

    return 0;
}
