/*
 * wasm_api.c  --  WASM-exported API for browser usage
 *
 * Pipelines:
 *   GRIB2:   wp_scan    → wp_scan_get_vars_json    → wp_normalize    → wp_query
 *   NetCDF3: wp_nc3_scan → wp_nc3_scan_get_vars_json → wp_nc3_normalize → wp_query
 *
 * No file I/O — everything works on in-memory buffers.
 *
 * Build: emcc (see wasm/Makefile)
 */

#include <emscripten.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include "../helper/grib2converthelpers.h"
#include "../formats/grib2/grib2_metadata.h"
#include "../formats/netcdf/netcdf3.h"
#include "../tools/query_refs.h"

/* =========================================================================
 * Scan result: list of unique variables found in a GRIB2 file
 * ======================================================================= */

typedef struct {
    uint8_t  cat;
    uint8_t  num;
    uint16_t grid_tmpl;
    uint16_t data_tmpl;
    uint32_t nx, ny;
    uint32_t count;  /* how many messages for this variable */
} wp_var_info_t;

typedef struct {
    wp_var_info_t* vars;
    int            n_vars;
    /* Keep raw data and message index alive for normalize step */
    uint8_t*       grb_data;
    uint32_t       grb_len;
    grib2_msg_t*   msgs;
    int            n_msgs;
} wp_scan_result_t;

/* =========================================================================
 * Step 1: Scan — index the GRIB2 file and list unique variables
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
wp_scan_result_t* wp_scan(const uint8_t* data, uint32_t data_len) {
    /* Copy data so it persists (JS may free the original) */
    uint8_t* grb_copy = (uint8_t*)malloc(data_len);
    if (!grb_copy) return NULL;
    memcpy(grb_copy, data, data_len);

    grib2_msg_t* msgs = NULL;
    int n_msgs = index_messages(grb_copy, data_len, &msgs);
    if (n_msgs <= 0) {
        free(grb_copy);
        return NULL;
    }

    /* Find unique (cat, num) pairs */
    wp_var_info_t* vars = (wp_var_info_t*)calloc(256, sizeof(wp_var_info_t));
    int n_vars = 0;

    for (int i = 0; i < n_msgs; i++) {
        uint8_t cat = msgs[i].param_cat;
        uint8_t num = msgs[i].param_num;

        /* Check if already seen */
        int found = -1;
        for (int v = 0; v < n_vars; v++) {
            if (vars[v].cat == cat && vars[v].num == num) {
                found = v; break;
            }
        }

        if (found >= 0) {
            vars[found].count++;
        } else if (n_vars < 256) {
            uint32_t nx = 0, ny = 0;
            if (msgs[i].sec3_len >= 38) {
                nx = be32(grb_copy + msgs[i].sec3_off + 30);
                ny = be32(grb_copy + msgs[i].sec3_off + 34);
            }
            vars[n_vars].cat = cat;
            vars[n_vars].num = num;
            vars[n_vars].grid_tmpl = be16(grb_copy + msgs[i].sec3_off + 12);
            vars[n_vars].data_tmpl = be16(grb_copy + msgs[i].sec5_off + 9);
            vars[n_vars].nx = nx;
            vars[n_vars].ny = ny;
            vars[n_vars].count = 1;
            n_vars++;
        }
    }

    wp_scan_result_t* result = (wp_scan_result_t*)calloc(1, sizeof(wp_scan_result_t));
    result->vars     = vars;
    result->n_vars   = n_vars;
    result->grb_data = grb_copy;
    result->grb_len  = data_len;
    result->msgs     = msgs;
    result->n_msgs   = n_msgs;

    return result;
}

/* Get number of variables found */
EMSCRIPTEN_KEEPALIVE
int wp_scan_num_vars(const wp_scan_result_t* s) {
    return s ? s->n_vars : 0;
}

/* Get variable info as JSON string */
EMSCRIPTEN_KEEPALIVE
char* wp_scan_get_vars_json(const wp_scan_result_t* s) {
    if (!s || s->n_vars == 0) return NULL;

    size_t cap = 4096;
    size_t len = 0;
    char* buf = (char*)malloc(cap);

    #define APPEND(...) do { \
        int _n; \
        while (1) { \
            _n = snprintf(buf + len, cap - len, __VA_ARGS__); \
            if (_n < 0) { free(buf); return NULL; } \
            if ((size_t)_n < cap - len) { len += (size_t)_n; break; } \
            cap *= 2; \
            char* _t = (char*)realloc(buf, cap); \
            if (!_t) { free(buf); return NULL; } \
            buf = _t; \
        } \
    } while (0)

    APPEND("[\n");
    for (int i = 0; i < s->n_vars; i++) {
        const wp_var_info_t* v = &s->vars[i];
        const char* name = grib2_get_variable_name(v->cat, v->num);
        APPEND("  {\"index\": %d, \"name\": \"%s\", \"cat\": %u, \"num\": %u, "
               "\"grid_template\": %u, \"data_template\": %u, "
               "\"nx\": %u, \"ny\": %u, \"messages\": %u, "
               "\"supported\": %s}%s\n",
               i, name, v->cat, v->num,
               v->grid_tmpl, v->data_tmpl,
               v->nx, v->ny, v->count,
               (v->grid_tmpl == 0 || v->grid_tmpl == 40 || v->grid_tmpl == 30) ? "true" : "false",
               (i + 1 < s->n_vars) ? "," : "");
    }
    APPEND("]\n");

    #undef APPEND
    return buf;
}

/* =========================================================================
 * Step 2: Normalize — decode one variable from the scanned GRIB2 data
 * Returns a refs_dataset_t* ready for querying
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_normalize(wp_scan_result_t* s, int var_index) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NULL;

    wp_var_info_t* vi = &s->vars[var_index];
    uint8_t target_cat = vi->cat;
    uint8_t target_num = vi->num;

    const uint8_t* data = s->grb_data;
    grib2_msg_t*   msgs = s->msgs;
    int            n_msgs = s->n_msgs;

    /* Support grid templates 0, 40 (regular lat/lon) and 30 (Lambert) */
    if (vi->grid_tmpl != 0 && vi->grid_tmpl != 40 && vi->grid_tmpl != 30)
        return NULL;

    /* Find first matching message */
    int first_idx = -1;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat == target_cat &&
            msgs[i].param_num == target_num) {
            first_idx = i; break;
        }
    }
    if (first_idx < 0) return NULL;

    /* Parse reference grid — branch on template */
    uint32_t nx, ny;
    int is_lambert = (vi->grid_tmpl == 30);

    grid_latlon_t  grid_ll;
    grid_lambert_t grid_lc;

    if (is_lambert) {
        if (parse_sec3_lambert(data + msgs[first_idx].sec3_off,
                               (uint32_t)msgs[first_idx].sec3_len, &grid_lc) != 0)
            return NULL;
        nx = grid_lc.nx;
        ny = grid_lc.ny;
    } else {
        if (parse_sec3_latlon(data + msgs[first_idx].sec3_off,
                              (uint32_t)msgs[first_idx].sec3_len, &grid_ll) != 0)
            return NULL;
        nx = grid_ll.nx;
        ny = grid_ll.ny;
    }

    /* Collect matching messages with same grid size */
    uint32_t ref_npts = nx * ny;
    int* sel = (int*)malloc((size_t)n_msgs * sizeof(int));
    int  sel_cnt = 0;

    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat != target_cat ||
            msgs[i].param_num != target_num)
            continue;
        uint32_t npts = (msgs[i].sec5_len >= 9)
                        ? be32(data + msgs[i].sec5_off + 5) : 0;
        if (npts == ref_npts)
            sel[sel_cnt++] = i;
    }

    if (sel_cnt == 0) { free(sel); return NULL; }

    uint32_t nt = (uint32_t)sel_cnt;
    uint32_t n_pts = nx * ny;

    /* Build coordinate arrays */
    float* lats = (float*)malloc(ny * sizeof(float));
    float* lons = (float*)malloc(nx * sizeof(float));
    int64_t* times = (int64_t*)malloc(nt * sizeof(int64_t));
    float* all_data = (float*)malloc((size_t)nt * n_pts * sizeof(float));
    float* chunk = (float*)malloc(n_pts * sizeof(float));

    if (!lats || !lons || !times || !all_data || !chunk) {
        free(sel); free(lats); free(lons); free(times);
        free(all_data); free(chunk);
        return NULL;
    }

    if (is_lambert) {
        /* Lambert: compute full 2D lat/lon grid, then extract 1D axes.
         * lat axis = first column (all rows, col 0)
         * lon axis = first row (row 0, all cols) */
        float* full_lats = (float*)malloc(n_pts * sizeof(float));
        float* full_lons = (float*)malloc(n_pts * sizeof(float));
        if (!full_lats || !full_lons) {
            free(full_lats); free(full_lons);
            free(sel); free(lats); free(lons); free(times);
            free(all_data); free(chunk);
            return NULL;
        }
        if (lambert_compute_latlon(&grid_lc, full_lats, full_lons) != 0) {
            free(full_lats); free(full_lons);
            free(sel); free(lats); free(lons); free(times);
            free(all_data); free(chunk);
            return NULL;
        }
        /* Extract lat from first column (index j*nx + 0) */
        for (uint32_t j = 0; j < ny; j++)
            lats[j] = full_lats[j * nx];
        /* Extract lon from first row (index 0*nx + i) */
        for (uint32_t i = 0; i < nx; i++)
            lons[i] = full_lons[i];
        free(full_lats);
        free(full_lons);
    } else {
        /* Regular lat/lon: build evenly-spaced arrays */
        for (uint32_t j = 0; j < ny; j++) {
            if (grid_ll.scanning_mode & 0x40)
                lats[j] = (float)(grid_ll.lat1 + j * grid_ll.dj);
            else
                lats[j] = (float)(grid_ll.lat1 - j * grid_ll.dj);
        }
        for (uint32_t i = 0; i < nx; i++) {
            lons[i] = (float)(grid_ll.lon1 + i * grid_ll.di);
        }
    }

    /* Parse timestamps and decode each time step */
    for (uint32_t t = 0; t < nt; t++) {
        grib2_msg_t* m = &msgs[sel[t]];
        int64_t ref = parse_sec1_reftime(data + m->sec1_off,
                                         (uint32_t)m->sec1_len);
        int64_t off = parse_sec4_forecast_offset(data + m->sec4_off,
                                                 (uint32_t)m->sec4_len);
        times[t] = ref + off;

        packing_t pk;
        memset(&pk, 0, sizeof(pk));
        if (parse_sec5(data + m->sec5_off, (uint32_t)m->sec5_len, &pk) != 0) {
            free(sel); free(lats); free(lons); free(times);
            free(all_data); free(chunk);
            return NULL;
        }

        if (pk.num_pts != n_pts) {
            free(sel); free(lats); free(lons); free(times);
            free(all_data); free(chunk);
            return NULL;
        }

        if (decode_sec7(data + m->sec7_off, (uint32_t)m->sec7_len,
                        &pk, chunk) != 0) {
            free(sel); free(lats); free(lons); free(times);
            free(all_data); free(chunk);
            return NULL;
        }

        memcpy(all_data + (size_t)t * n_pts, chunk, n_pts * sizeof(float));
    }
    free(chunk);
    free(sel);

    /* Create dataset directly using the open_from_arrays function */
    const char* var_name = grib2_get_variable_name(target_cat, target_num);
    refs_dataset_t* ds = refs_open_from_arrays(
        var_name, nx, ny, nt, lats, lons, times, all_data);

    /* lats, lons, times, all_data are now owned by ds */
    return ds;
}

/* =========================================================================
 * Step 3: Free scan result
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
void wp_scan_free(wp_scan_result_t* s) {
    if (!s) return;
    free(s->vars);
    free(s->grb_data);
    free(s->msgs);
    free(s);
}

/* =========================================================================
 * NetCDF3 pipeline
 * ======================================================================= */

/* Variable descriptor for the JS variable list */
typedef struct {
    char     name[NC3_MAX_NAME];
    char     units[NC3_MAX_NAME];
    char     long_name[NC3_MAX_NAME];
    uint32_t ndims;
    uint32_t shape[NC3_MAX_DIMS];
    char     dim_names[NC3_MAX_DIMS][64];
    int      supported;   /* 1 if we can decode it (has lat/lon dims) */
    int      var_idx;     /* index into nc3_file_t.vars[] */
} wp_nc3_var_info_t;

typedef struct {
    wp_nc3_var_info_t* vars;
    int                n_vars;
    uint8_t*           data;
    uint32_t           data_len;
    nc3_file_t         nc;
} wp_nc3_scan_result_t;

/* ------------------------------------------------------------------
 * Helpers: find coordinate variable names inside a variable's dims
 * ------------------------------------------------------------------ */

/* Returns 1 if the variable is a coordinate variable (name == a dim name) */
static int nc3_is_coord_var(const nc3_file_t* nc, int var_idx) {
    const char* vname = nc->vars[var_idx].name;
    for (uint32_t d = 0; d < nc->ndims; d++)
        if (strcmp(nc->dims[d].name, vname) == 0) return 1;
    return 0;
}

/* Find the lat/lon/time dim index within a variable's dim list.
 * Returns the position in v->dimids[] or -1 if not found.
 * Matches common CF names case-insensitively. */
static int nc3_find_spatial_dim(const nc3_file_t* nc, const nc3_var_t* v,
                                 const char** candidates, int ncands) {
    for (uint32_t d = 0; d < v->ndims; d++) {
        uint32_t did = v->dimids[d];
        if (did >= nc->ndims) continue;
        const char* dname = nc->dims[did].name;
        for (int c = 0; c < ncands; c++) {
            /* case-insensitive compare */
            const char* cand = candidates[c];
            size_t n = strlen(cand);
            if (strlen(dname) == n) {
                int match = 1;
                for (size_t i = 0; i < n; i++) {
                    char a = dname[i] >= 'A' && dname[i] <= 'Z'
                             ? dname[i]+32 : dname[i];
                    char b = cand[i]  >= 'A' && cand[i]  <= 'Z'
                             ? cand[i]+32  : cand[i];
                    if (a != b) { match = 0; break; }
                }
                if (match) return (int)d;
            }
        }
    }
    return -1;
}

/* ------------------------------------------------------------------
 * CF time parsing: "days/hours/seconds/minutes since YYYY-MM-DD [HH:MM:SS]"
 * Returns Unix epoch in SECONDS, or 0 on failure.
 * ------------------------------------------------------------------ */
static int64_t nc3_cf_epoch_s(const char* units) {
    if (!units) return 0;

    const char* since = strstr(units, "since");
    if (!since) return 0;
    since += 5;
    while (*since == ' ') since++;

    int yr = 1970, mo = 1, dy = 1, hr = 0, mn = 0, sc = 0;
    sscanf(since, "%d-%d-%d %d:%d:%d", &yr, &mo, &dy, &hr, &mn, &sc);

    /* Gregorian → Julian Day Number, then to Unix days */
    int a = (14 - mo) / 12;
    int y = yr + 4800 - a;
    int m = mo + 12 * a - 3;
    int64_t jdn = dy + (153*m+2)/5 + 365*(int64_t)y + y/4 - y/100 + y/400 - 32045;
    int64_t unix_day0 = 2440588LL; /* JDN of 1970-01-01 */
    int64_t days_since_epoch = jdn - unix_day0;
    return days_since_epoch * 86400LL + hr * 3600LL + mn * 60LL + sc;
}

/* Convert a CF time value to Unix seconds.
 * units is like "hours since 1900-01-01 00:00:00.0" */
static int64_t nc3_time_to_s(double val, const char* units) {
    if (!units) return 0;
    int64_t mult = 1;
    if      (strncmp(units, "seconds", 7) == 0) mult = 1LL;
    else if (strncmp(units, "minutes", 7) == 0) mult = 60LL;
    else if (strncmp(units, "hours",   5) == 0) mult = 3600LL;
    else if (strncmp(units, "days",    4) == 0) mult = 86400LL;
    return nc3_cf_epoch_s(units) + (int64_t)(val * (double)mult);
}

/* ------------------------------------------------------------------
 * wp_nc3_scan — parse header, list data variables
 * ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
wp_nc3_scan_result_t* wp_nc3_scan(const uint8_t* data, uint32_t data_len) {
    if (!nc3_is_netcdf3(data, data_len)) return NULL;

    /* Copy data so it persists */
    uint8_t* copy = (uint8_t*)malloc(data_len);
    if (!copy) return NULL;
    memcpy(copy, data, data_len);

    wp_nc3_scan_result_t* s = (wp_nc3_scan_result_t*)calloc(1, sizeof(*s));
    if (!s) { free(copy); return NULL; }
    s->data     = copy;
    s->data_len = data_len;

    if (nc3_parse_header(copy, data_len, &s->nc) != 0) {
        free(copy); free(s); return NULL;
    }

    /* Lat/lon candidate names */
    const char* lat_names[] = {"lat","latitude","y","rlat","grid_lat"};
    const char* lon_names[] = {"lon","longitude","x","rlon","grid_lon"};
    const char* tim_names[] = {"time","t","Times"};

    /* Allocate worst-case variable list */
    s->vars = (wp_nc3_var_info_t*)calloc(s->nc.nvars, sizeof(wp_nc3_var_info_t));
    if (!s->vars) { free(copy); free(s); return NULL; }
    s->n_vars = 0;

    for (uint32_t i = 0; i < s->nc.nvars; i++) {
        const nc3_var_t* v = &s->nc.vars[i];

        /* Skip coordinate variables */
        if (nc3_is_coord_var(&s->nc, (int)i)) continue;
        /* Skip char/byte variables (usually labels or flags) */
        if (v->type == NC3_CHAR || v->type == NC3_BYTE) continue;

        wp_nc3_var_info_t* vi = &s->vars[s->n_vars];
        strncpy(vi->name, v->name, NC3_MAX_NAME - 1);
        vi->var_idx = (int)i;
        vi->ndims   = v->ndims < NC3_MAX_DIMS ? v->ndims : NC3_MAX_DIMS;

        for (uint32_t d = 0; d < vi->ndims; d++) {
            uint32_t did = v->dimids[d];
            if (did < s->nc.ndims) {
                vi->shape[d] = s->nc.dims[did].length;
                strncpy(vi->dim_names[d], s->nc.dims[did].name, 63);
            }
        }

        /* Copy useful attributes */
        const char* u = nc3_get_att_string(v, "units");
        const char* l = nc3_get_att_string(v, "long_name");
        if (u) strncpy(vi->units,     u, NC3_MAX_NAME - 1);
        if (l) strncpy(vi->long_name, l, NC3_MAX_NAME - 1);

        /* supported = has lat + lon dims */
        int has_lat = nc3_find_spatial_dim(&s->nc, v, lat_names, 5) >= 0;
        int has_lon = nc3_find_spatial_dim(&s->nc, v, lon_names, 5) >= 0;
        vi->supported = (has_lat && has_lon) ? 1 : 0;

        s->n_vars++;
    }
    return s;
}

/* ------------------------------------------------------------------
 * wp_nc3_scan_get_vars_json
 * ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
char* wp_nc3_scan_get_vars_json(const wp_nc3_scan_result_t* s) {
    if (!s || s->n_vars == 0) return NULL;

    size_t cap = 4096, len = 0;
    char* buf = (char*)malloc(cap);
    if (!buf) return NULL;

    #define NC3APPEND(...) do { \
        int _n; \
        while (1) { \
            _n = snprintf(buf + len, cap - len, __VA_ARGS__); \
            if (_n < 0) { free(buf); return NULL; } \
            if ((size_t)_n < cap - len) { len += (size_t)_n; break; } \
            cap *= 2; \
            char* _t = (char*)realloc(buf, cap); \
            if (!_t) { free(buf); return NULL; } \
            buf = _t; \
        } \
    } while (0)

    NC3APPEND("[\n");
    for (int i = 0; i < s->n_vars; i++) {
        const wp_nc3_var_info_t* v = &s->vars[i];

        /* Build shape string e.g. "365x73x144" */
        char shape_str[128] = "";
        size_t slen = 0;
        for (uint32_t d = 0; d < v->ndims && slen < sizeof(shape_str)-16; d++) {
            if (d > 0) shape_str[slen++] = 'x';
            slen += (size_t)snprintf(shape_str + slen,
                                     sizeof(shape_str) - slen, "%u", v->shape[d]);
        }

        NC3APPEND("  {\"index\": %d, \"name\": \"%s\", "
                  "\"long_name\": \"%s\", \"units\": \"%s\", "
                  "\"shape\": \"%s\", \"ndims\": %u, "
                  "\"supported\": %s}%s\n",
                  i, v->name, v->long_name, v->units,
                  shape_str, v->ndims,
                  v->supported ? "true" : "false",
                  (i + 1 < s->n_vars) ? "," : "");
    }
    NC3APPEND("]\n");
    #undef NC3APPEND
    return buf;
}

/* ------------------------------------------------------------------
 * wp_nc3_normalize — decode one variable → refs_dataset_t
 * ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_nc3_normalize(wp_nc3_scan_result_t* s, int var_index) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NULL;

    const wp_nc3_var_info_t* vi = &s->vars[var_index];
    if (!vi->supported) return NULL;

    const nc3_file_t*  nc   = &s->nc;
    const uint8_t*     data = s->data;
    uint64_t           dlen = s->data_len;
    const nc3_var_t*   v    = &nc->vars[vi->var_idx];

    /* Candidate coordinate names */
    const char* lat_cands[] = {"lat","latitude","y","rlat","grid_lat"};
    const char* lon_cands[] = {"lon","longitude","x","rlon","grid_lon"};
    const char* tim_cands[] = {"time","t","Times"};

    /* Find which dim position is lat/lon/time */
    int lat_dpos = nc3_find_spatial_dim(nc, v, lat_cands, 5);
    int lon_dpos = nc3_find_spatial_dim(nc, v, lon_cands, 5);
    int tim_dpos = nc3_find_spatial_dim(nc, v, tim_cands, 3);

    if (lat_dpos < 0 || lon_dpos < 0) return NULL;

    uint32_t lat_did = v->dimids[lat_dpos];
    uint32_t lon_did = v->dimids[lon_dpos];
    uint32_t ny = nc->dims[lat_did].length;
    uint32_t nx = nc->dims[lon_did].length;
    uint32_t nt = 1;
    uint32_t tim_did = 0;

    if (tim_dpos >= 0) {
        tim_did = v->dimids[tim_dpos];
        nt = nc->dims[tim_did].length;
    }
    if (nt == 0) nt = 1;

    uint32_t n_pts = nx * ny;

    /* ---- Read lat coordinate variable ---- */
    int lat_var_idx = nc3_find_var(nc, nc->dims[lat_did].name);
    float* lats = (float*)malloc(ny * sizeof(float));
    if (!lats) return NULL;
    if (lat_var_idx >= 0) {
        nc3_read_var_float(nc, data, dlen, lat_var_idx, lats);
    } else {
        for (uint32_t j = 0; j < ny; j++) lats[j] = (float)j;
    }

    /* ---- Read lon coordinate variable ---- */
    int lon_var_idx = nc3_find_var(nc, nc->dims[lon_did].name);
    float* lons = (float*)malloc(nx * sizeof(float));
    if (!lons) { free(lats); return NULL; }
    if (lon_var_idx >= 0) {
        nc3_read_var_float(nc, data, dlen, lon_var_idx, lons);
    } else {
        for (uint32_t i = 0; i < nx; i++) lons[i] = (float)i;
    }

    /* ---- Read time coordinate variable ---- */
    int64_t* times = (int64_t*)malloc(nt * sizeof(int64_t));
    if (!times) { free(lats); free(lons); return NULL; }

    int tim_var_idx = (tim_dpos >= 0)
                    ? nc3_find_var(nc, nc->dims[tim_did].name) : -1;

    if (tim_var_idx >= 0) {
        float* raw_times = (float*)malloc(nt * sizeof(float));
        if (!raw_times) { free(lats); free(lons); free(times); return NULL; }
        nc3_read_var_float(nc, data, dlen, tim_var_idx, raw_times);

        const char* tunits = nc3_get_att_string(&nc->vars[tim_var_idx], "units");
        for (uint32_t t = 0; t < nt; t++)
            times[t] = nc3_time_to_s((double)raw_times[t], tunits ? tunits : "days since 1970-01-01");
        free(raw_times);
    } else {
        for (uint32_t t = 0; t < nt; t++) times[t] = (int64_t)t * 86400000LL;
    }

    /* ---- Read and decode the data variable ---- */
    uint64_t total_pts = (uint64_t)nt * n_pts;
    float* all_data = (float*)malloc(total_pts * sizeof(float));
    if (!all_data) { free(lats); free(lons); free(times); return NULL; }

    if (nc3_read_var_float(nc, data, dlen, vi->var_idx, all_data) != 0) {
        free(lats); free(lons); free(times); free(all_data);
        return NULL;
    }

    /* ---- Build dataset ---- */
    refs_dataset_t* ds = refs_open_from_arrays(
        vi->name, nx, ny, nt, lats, lons, times, all_data);

    return ds;
}

/* ------------------------------------------------------------------
 * wp_nc3_scan_free
 * ------------------------------------------------------------------ */

EMSCRIPTEN_KEEPALIVE
void wp_nc3_scan_free(wp_nc3_scan_result_t* s) {
    if (!s) return;
    free(s->vars);
    free(s->data);
    free(s);
}

/* =========================================================================
 * Query (unchanged from before)
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
void wp_close(refs_dataset_t* ds) {
    refs_close(ds);
}

EMSCRIPTEN_KEEPALIVE
const char* wp_variable_name(const refs_dataset_t* ds) {
    return refs_variable_name(ds);
}

EMSCRIPTEN_KEEPALIVE
uint32_t wp_nx(const refs_dataset_t* ds) { return refs_nx(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_ny(const refs_dataset_t* ds) { return refs_ny(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_nt(const refs_dataset_t* ds) { return refs_nt(ds); }

EMSCRIPTEN_KEEPALIVE
int wp_is_timeseries(const refs_dataset_t* ds) { return refs_is_timeseries(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_find_nearest_lat(const refs_dataset_t* ds, double lat) {
    return refs_find_nearest_lat(ds, lat);
}

EMSCRIPTEN_KEEPALIVE
uint32_t wp_find_nearest_lon(const refs_dataset_t* ds, double lon) {
    return refs_find_nearest_lon(ds, lon);
}

EMSCRIPTEN_KEEPALIVE
char* wp_query(refs_dataset_t* ds,
               uint32_t t1, uint32_t t2,
               int32_t lat_idx, int32_t lon_idx) {
    if (t1 >= refs_nt(ds)) t1 = refs_nt(ds) - 1;
    if (t2 >= refs_nt(ds)) t2 = refs_nt(ds) - 1;
    if (t2 < t1) t2 = t1;

    uint32_t count = t2 - t1 + 1;
    uint32_t* indices = (uint32_t*)malloc(count * sizeof(uint32_t));
    for (uint32_t i = 0; i < count; i++)
        indices[i] = t1 + i;

    char* result = refs_query_to_string(ds, indices, count, lat_idx, lon_idx);
    free(indices);
    return result;
}

/* =========================================================================
 * wp_open_from_float_arrays — create a query-ready dataset from pre-decoded
 * arrays.  Used by the NetCDF4 pipeline: h5wasm decodes HDF5 in JavaScript,
 * then calls this to hand the arrays over to the C query engine.
 *
 * var_name : null-terminated variable name
 * nx, ny   : longitude / latitude grid size
 * nt       : number of time steps (pass 1 for static data)
 * lats     : float[ny]  — latitude values (degrees)
 * lons     : float[nx]  — longitude values (degrees)
 * times_s  : double[nt] — Unix timestamps in seconds (avoids int64 transfer)
 * data     : float[nt*ny*nx] — values in [time, lat, lon] order, NaN for missing
 *
 * Returns refs_dataset_t* that must be freed with wp_close().
 * NULL on allocation failure.
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_open_from_float_arrays(
        const char*   var_name,
        uint32_t nx, uint32_t ny, uint32_t nt,
        const float*  lats,
        const float*  lons,
        const double* times_s,
        const float*  data) {

    if (!var_name || !lats || !lons || !times_s || !data) return NULL;
    if (nx == 0 || ny == 0 || nt == 0) return NULL;

    size_t n_pts = (size_t)nt * ny * nx;

    float*   lats_c  = (float*)  malloc(ny    * sizeof(float));
    float*   lons_c  = (float*)  malloc(nx    * sizeof(float));
    int64_t* times_c = (int64_t*)malloc(nt    * sizeof(int64_t));
    float*   data_c  = (float*)  malloc(n_pts * sizeof(float));

    if (!lats_c || !lons_c || !times_c || !data_c) {
        free(lats_c); free(lons_c); free(times_c); free(data_c);
        return NULL;
    }

    memcpy(lats_c, lats, ny    * sizeof(float));
    memcpy(lons_c, lons, nx    * sizeof(float));
    memcpy(data_c, data, n_pts * sizeof(float));

    for (uint32_t t = 0; t < nt; t++)
        times_c[t] = (int64_t)times_s[t];   /* double → int64 seconds */

    /* refs_open_from_arrays takes ownership of all four arrays */
    return refs_open_from_arrays(var_name, nx, ny, nt,
                                 lats_c, lons_c, times_c, data_c);
}

/* =========================================================================
 * Memory helpers for JS
 * ======================================================================= */

EMSCRIPTEN_KEEPALIVE
void wp_free(void* ptr) {
    free(ptr);
}

EMSCRIPTEN_KEEPALIVE
void* wp_malloc(uint32_t size) {
    return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void wp_memcpy(uint8_t* dst, const uint8_t* src, uint32_t len) {
    memcpy(dst, src, len);
}
