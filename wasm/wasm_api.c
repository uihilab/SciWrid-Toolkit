/*
 * wasm_api.c  --  WASM-exported API for browser usage
 *
 * Full pipeline: scan GRIB2 → list variables → normalize one → query it
 * No file I/O — everything works on in-memory buffers.
 *
 * Build: emcc (see wasm/Makefile)
 */

#include <emscripten.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>

#include "../helper/grib2converthelpers.h"
#include "../formats/grib2/grib2_metadata.h"
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
