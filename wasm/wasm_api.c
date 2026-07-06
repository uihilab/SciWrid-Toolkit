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
#include "../core/util/base64.h"

/* Portable strnlen (not in C99). */
static size_t wp_strnlen(const char* s, size_t maxlen) {
    size_t i = 0;
    while (i < maxlen && s[i] != '\0') i++;
    return i;
}

/* JSON-escape helper used by the *_layout exports below.
 * Writes a quoted, escaped form of `src` (nelems bytes, NOT null-terminated)
 * into out. Returns the number of chars written (excluding null). */
static size_t json_escape(const char* src, size_t n, char* out, size_t out_cap) {
    size_t o = 0;
    if (o < out_cap) out[o++] = '"';
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == 0) break;                       /* stop at first NUL */
        if (o + 8 >= out_cap) break;             /* leave room for closing + esc */
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c == '\n')        { out[o++] = '\\'; out[o++] = 'n';     }
        else if (c == '\r')        { out[o++] = '\\'; out[o++] = 'r';     }
        else if (c == '\t')        { out[o++] = '\\'; out[o++] = 't';     }
        else if (c < 0x20) {
            int w = snprintf(out + o, out_cap - o, "\\u%04x", c);
            if (w > 0) o += (size_t)w;
        } else {
            out[o++] = (char)c;
        }
    }
    if (o < out_cap) out[o++] = '"';
    if (o < out_cap) out[o] = '\0';
    return o;
}

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
            uint16_t gtmpl = be16(grb_copy + msgs[i].sec3_off + 12);
            if (gtmpl == 101) {
                /* Unstructured grid: store cell count in nx, ny=1 */
                if (msgs[i].sec3_len >= 34)
                    nx = be32(grb_copy + msgs[i].sec3_off + 30);
                /* Fall back to octets 7-10 (numberOfDataPoints in sec3 header) */
                if (nx == 0 && msgs[i].sec3_len >= 10)
                    nx = be32(grb_copy + msgs[i].sec3_off + 6);
                ny = 1;
            } else if (msgs[i].sec3_len >= 38) {
                nx = be32(grb_copy + msgs[i].sec3_off + 30);
                ny = be32(grb_copy + msgs[i].sec3_off + 34);
            }
            vars[n_vars].cat = cat;
            vars[n_vars].num = num;
            vars[n_vars].grid_tmpl = gtmpl;
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
               (v->grid_tmpl == 0 || v->grid_tmpl == 40 || v->grid_tmpl == 30 || v->grid_tmpl == 101 || v->grid_tmpl == 20) ? "true" : "false",
               (i + 1 < s->n_vars) ? "," : "");
    }
    APPEND("]\n");

    #undef APPEND
    return buf;
}

/* =========================================================================
 * Trim helper: per-message byte-range layout for the JS trim pipeline.
 *
 * Returns a JSON array describing every GRIB2 message in the source. Each
 * entry carries the message's byte span in the original buffer, the
 * (cat, num) and human-readable variable name, the reference time (Unix
 * seconds), and the forecast offset (seconds). JS trim filters this array
 * by variable + time and concatenates the kept byte spans verbatim — no
 * decode involved.
 *
 * Returned string is malloc'd; caller frees with wp_free.
 * ======================================================================= */
EMSCRIPTEN_KEEPALIVE
char* wp_scan_messages_layout(const wp_scan_result_t* s) {
    if (!s || s->n_msgs == 0) return NULL;

    size_t cap = 8192, len = 0;
    char* buf = (char*)malloc(cap);
    if (!buf) return NULL;

    #define MAPPEND(...) do { \
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

    MAPPEND("[\n");
    for (int i = 0; i < s->n_msgs; i++) {
        const grib2_msg_t* m = &s->msgs[i];

        /* Section 0 is always 16 bytes immediately before Section 1 in the
         * GRIB2 wire format. The total message length is encoded as a
         * big-endian uint64 in Section 0 bytes 8..15. */
        uint64_t msg_start = m->sec1_off - 16;
        uint64_t msg_len   = 0;
        if (msg_start + 16 <= s->grb_len)
            msg_len = be64(s->grb_data + msg_start + 8);

        uint16_t gtmpl = (m->sec3_len >= 14)
                         ? be16(s->grb_data + m->sec3_off + 12) : 0;

        int64_t ref_time = parse_sec1_reftime(s->grb_data + m->sec1_off,
                                              (uint32_t)m->sec1_len);
        int64_t fc_off   = parse_sec4_forecast_offset(s->grb_data + m->sec4_off,
                                                      (uint32_t)m->sec4_len);

        const char* name = grib2_get_variable_name(m->param_cat, m->param_num);
        char name_esc[128];
        json_escape(name ? name : "", name ? strlen(name) : 0,
                    name_esc, sizeof(name_esc));

        int supported = (gtmpl == 0 || gtmpl == 30 ||
                         gtmpl == 40 || gtmpl == 101 || gtmpl == 20);

        MAPPEND("  {\"index\": %d, \"start\": %llu, \"len\": %llu, "
                "\"cat\": %u, \"num\": %u, \"name\": %s, "
                "\"grid_template\": %u, \"data_template\": %u, "
                "\"ref_time\": %lld, \"forecast_offset\": %lld, "
                "\"valid_time\": %lld, \"supported\": %s}%s\n",
                i, (unsigned long long)msg_start, (unsigned long long)msg_len,
                m->param_cat, m->param_num, name_esc,
                gtmpl, m->data_template,
                (long long)ref_time, (long long)fc_off,
                (long long)(ref_time + fc_off),
                supported ? "true" : "false",
                (i + 1 < s->n_msgs) ? "," : "");
    }
    MAPPEND("]\n");
    #undef MAPPEND
    return buf;
}

/* =========================================================================
 * Step 2: Normalize — decode one variable from the scanned GRIB2 data
 * Returns a refs_dataset_t* ready for querying
 * ======================================================================= */

/* ── Shared GRIB2 decode helpers (used by wp_grid_coords + wp_normalize_range) ── */
typedef struct {
    int kind;                 /* 0 latlon, 1 lambert, 2 unstructured, 3 polar */
    uint32_t nx, ny;
    grid_latlon_t       ll;
    grid_lambert_t      lc;
    grid_unstructured_t un;
    grid_polar_t        ps;
} grib2_grid_t;

static int grib2_parse_grid(const wp_var_info_t* vi, const uint8_t* sec3,
                            uint32_t sec3_len, grib2_grid_t* g) {
    if (vi->grid_tmpl != 0 && vi->grid_tmpl != 40 && vi->grid_tmpl != 30 &&
        vi->grid_tmpl != 101 && vi->grid_tmpl != 20)
        return -1;
    if (vi->grid_tmpl == 20) {
        if (parse_sec3_polar(sec3, sec3_len, &g->ps) != 0) return -1;
        g->kind = 3; g->nx = g->ps.nx; g->ny = g->ps.ny;
    } else if (vi->grid_tmpl == 101) {
        if (parse_sec3_unstructured(sec3, sec3_len, &g->un) != 0) return -1;
        g->kind = 2; g->nx = g->un.num_points; g->ny = 1;
    } else if (vi->grid_tmpl == 30) {
        if (parse_sec3_lambert(sec3, sec3_len, &g->lc) != 0) return -1;
        g->kind = 1; g->nx = g->lc.nx; g->ny = g->lc.ny;
    } else {
        if (parse_sec3_latlon(sec3, sec3_len, &g->ll) != 0) return -1;
        g->kind = 0; g->nx = g->ll.nx; g->ny = g->ll.ny;
    }
    if (g->nx == 0 || g->ny == 0) return -1;
    return 0;
}

static int grib2_build_coords(const grib2_grid_t* g, float** lats, float** lons,
                              float** lat2d, float** lon2d, int* is_curv) {
    uint32_t nx = g->nx, ny = g->ny, n_pts = nx * ny;
    *lats = *lons = *lat2d = *lon2d = NULL; *is_curv = 0;
    if (g->kind == 3) {                       /* polar: full 2D */
        *lat2d = (float*)malloc((size_t)n_pts * sizeof(float));
        *lon2d = (float*)malloc((size_t)n_pts * sizeof(float));
        if (!*lat2d || !*lon2d) { free(*lat2d); free(*lon2d); return -1; }
        if (polar_stereo_compute_latlon(&g->ps, *lat2d, *lon2d) != 0) {
            free(*lat2d); free(*lon2d); *lat2d = *lon2d = NULL; return -1;
        }
        *is_curv = 1;
        return 0;
    }
    *lats = (float*)malloc(ny * sizeof(float));
    *lons = (float*)malloc(nx * sizeof(float));
    if (!*lats || !*lons) { free(*lats); free(*lons); return -1; }
    if (g->kind == 2) {                       /* unstructured: cell index axis */
        (*lats)[0] = 0.0f;
        for (uint32_t i = 0; i < nx; i++) (*lons)[i] = (float)i;
    } else if (g->kind == 1) {                /* lambert: reduce 2D -> 1D axes */
        float* fl = (float*)malloc((size_t)n_pts * sizeof(float));
        float* fo = (float*)malloc((size_t)n_pts * sizeof(float));
        if (!fl || !fo || lambert_compute_latlon(&g->lc, fl, fo) != 0) {
            free(fl); free(fo); free(*lats); free(*lons);
            *lats = *lons = NULL; return -1;
        }
        for (uint32_t j = 0; j < ny; j++) (*lats)[j] = fl[j * nx];
        for (uint32_t i = 0; i < nx; i++) (*lons)[i] = fo[i];
        free(fl); free(fo);
    } else {                                  /* regular lat/lon */
        for (uint32_t j = 0; j < ny; j++)
            (*lats)[j] = (g->ll.scanning_mode & 0x40)
                ? (float)(g->ll.lat1 + j * g->ll.dj)
                : (float)(g->ll.lat1 - j * g->ll.dj);
        for (uint32_t i = 0; i < nx; i++)
            (*lons)[i] = (float)(g->ll.lon1 + i * g->ll.di);
    }
    return 0;
}

static int grib2_decode_one_field(const uint8_t* data, const grib2_msg_t* m,
                                  uint32_t n_pts, float* chunk) {
    packing_t pk; memset(&pk, 0, sizeof(pk));
    if (parse_sec5(data + m->sec5_off, (uint32_t)m->sec5_len, &pk) != 0) return -1;
    bitmap_t bm; bm.indicator = 255; bm.bits = NULL; bm.nbytes = 0;
    if (m->sec6_off != 0) {
        uint32_t sec6_len = be32(data + m->sec6_off);
        parse_sec6(data + m->sec6_off, sec6_len, &bm);
    }
    if (bm.indicator == 255) {
        if (pk.num_pts != n_pts) return -1;
        if (decode_sec7(data + m->sec7_off, (uint32_t)m->sec7_len, &pk, chunk) != 0)
            return -1;
    } else if (bm.indicator == 0) {
        uint32_t present = bitmap_popcount(&bm, n_pts);
        if (pk.num_pts != present) return -1;
        if (present == 0) {
            for (uint32_t i = 0; i < n_pts; i++) chunk[i] = NAN;
        } else {
            float* pv = (float*)malloc((size_t)present * sizeof(float));
            if (!pv) return -1;
            if (decode_sec7(data + m->sec7_off, (uint32_t)m->sec7_len, &pk, pv) != 0) {
                free(pv); return -1;
            }
            uint32_t next = 0;
            for (uint32_t i = 0; i < n_pts; i++)
                chunk[i] = bitmap_get(&bm, i) ? pv[next++] : NAN;
            free(pv);
        }
    } else {
        return -1;   /* pre-defined bitmap: unsupported */
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_grid_coords(wp_scan_result_t* s, int var_index) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NULL;
    wp_var_info_t* vi = &s->vars[var_index];
    const uint8_t* data = s->grb_data; grib2_msg_t* msgs = s->msgs; int n_msgs = s->n_msgs;

    int first_idx = -1;
    for (int i = 0; i < n_msgs; i++)
        if (msgs[i].param_cat == vi->cat && msgs[i].param_num == vi->num) { first_idx = i; break; }
    if (first_idx < 0) return NULL;

    grib2_grid_t g;
    if (grib2_parse_grid(vi, data + msgs[first_idx].sec3_off,
                         (uint32_t)msgs[first_idx].sec3_len, &g) != 0) return NULL;
    uint32_t nx = g.nx, ny = g.ny, ref_npts = nx * ny;

    int* sel = (int*)malloc((size_t)n_msgs * sizeof(int));
    if (!sel) return NULL;
    int sel_cnt = 0;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat != vi->cat || msgs[i].param_num != vi->num) continue;
        uint32_t npts = (msgs[i].sec5_len >= 9) ? be32(data + msgs[i].sec5_off + 5) : 0;
        if (npts == ref_npts || msgs[i].sec6_off != 0) sel[sel_cnt++] = i;
    }
    if (sel_cnt == 0) { free(sel); return NULL; }
    uint32_t nt = (uint32_t)sel_cnt;

    float *lats, *lons, *lat2d, *lon2d; int is_curv;
    if (grib2_build_coords(&g, &lats, &lons, &lat2d, &lon2d, &is_curv) != 0) { free(sel); return NULL; }
    int64_t* times = (int64_t*)malloc(nt * sizeof(int64_t));
    if (!times) { free(sel); free(lats); free(lons); free(lat2d); free(lon2d); return NULL; }
    for (uint32_t t = 0; t < nt; t++) {
        grib2_msg_t* m = &msgs[sel[t]];
        times[t] = parse_sec1_reftime(data + m->sec1_off, (uint32_t)m->sec1_len)
                 + parse_sec4_forecast_offset(data + m->sec4_off, (uint32_t)m->sec4_len);
    }
    free(sel);
    const char* var_name = grib2_get_variable_name(vi->cat, vi->num);
    if (is_curv)
        return refs_open_from_arrays_2d(var_name, nx, ny, nt, lat2d, lon2d, times, NULL);
    return refs_open_from_arrays(var_name, nx, ny, nt, lats, lons, times, NULL);
}

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_normalize_range(wp_scan_result_t* s, int var_index,
                                   int32_t t1, int32_t t2, int32_t iy, int32_t ix) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NULL;
    wp_var_info_t* vi = &s->vars[var_index];
    const uint8_t* data = s->grb_data; grib2_msg_t* msgs = s->msgs; int n_msgs = s->n_msgs;

    int first_idx = -1;
    for (int i = 0; i < n_msgs; i++)
        if (msgs[i].param_cat == vi->cat && msgs[i].param_num == vi->num) { first_idx = i; break; }
    if (first_idx < 0) return NULL;

    grib2_grid_t g;
    if (grib2_parse_grid(vi, data + msgs[first_idx].sec3_off,
                         (uint32_t)msgs[first_idx].sec3_len, &g) != 0) return NULL;
    uint32_t nx = g.nx, ny = g.ny, n_pts = nx * ny, ref_npts = n_pts;

    int* sel = (int*)malloc((size_t)n_msgs * sizeof(int));
    if (!sel) return NULL;
    int sel_cnt = 0;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat != vi->cat || msgs[i].param_num != vi->num) continue;
        uint32_t npts = (msgs[i].sec5_len >= 9) ? be32(data + msgs[i].sec5_off + 5) : 0;
        if (npts == ref_npts || msgs[i].sec6_off != 0) sel[sel_cnt++] = i;
    }
    if (sel_cnt == 0) { free(sel); return NULL; }
    uint32_t nt_total = (uint32_t)sel_cnt;

    /* clamp the window */
    if (t1 < 0) t1 = 0;
    if (t2 < 0 || t2 > (int32_t)nt_total - 1) t2 = (int32_t)nt_total - 1;
    if (t1 > t2) t1 = t2;
    uint32_t w0 = (uint32_t)t1, nt = (uint32_t)(t2 - t1 + 1);

    int point_reduce = (iy >= 0 && ix >= 0 && (uint32_t)iy < ny && (uint32_t)ix < nx);

    float *lats, *lons, *lat2d, *lon2d; int is_curv;
    if (grib2_build_coords(&g, &lats, &lons, &lat2d, &lon2d, &is_curv) != 0) { free(sel); return NULL; }

    int64_t* times = (int64_t*)malloc(nt * sizeof(int64_t));
    float* chunk = (float*)malloc(n_pts * sizeof(float));
    if (!times || !chunk) {
        free(sel); free(lats); free(lons); free(lat2d); free(lon2d); free(times); free(chunk);
        return NULL;
    }

    if (point_reduce) {
        float* out = (float*)malloc(nt * sizeof(float));
        if (!out) { free(sel); free(lats); free(lons); free(lat2d); free(lon2d);
                    free(times); free(chunk); return NULL; }
        for (uint32_t t = 0; t < nt; t++) {
            grib2_msg_t* m = &msgs[sel[w0 + t]];
            times[t] = parse_sec1_reftime(data + m->sec1_off, (uint32_t)m->sec1_len)
                     + parse_sec4_forecast_offset(data + m->sec4_off, (uint32_t)m->sec4_len);
            if (grib2_decode_one_field(data, m, n_pts, chunk) != 0) {
                free(out); free(sel); free(lats); free(lons); free(lat2d); free(lon2d);
                free(times); free(chunk); return NULL;
            }
            out[t] = chunk[(size_t)iy * nx + ix];
        }
        float clat = is_curv ? lat2d[(size_t)iy * nx + ix] : lats[iy];
        float clon = is_curv ? lon2d[(size_t)iy * nx + ix] : lons[ix];
        free(lats); free(lons); free(lat2d); free(lon2d); free(chunk); free(sel);
        float* c_lat = (float*)malloc(sizeof(float)); float* c_lon = (float*)malloc(sizeof(float));
        if (!c_lat || !c_lon) { free(c_lat); free(c_lon); free(times); free(out); return NULL; }
        c_lat[0] = clat; c_lon[0] = clon;
        const char* var_name = grib2_get_variable_name(vi->cat, vi->num);
        return refs_open_from_arrays(var_name, 1, 1, nt, c_lat, c_lon, times, out);
    }

    /* windowed full decode */
    float* all_data = (float*)malloc((size_t)nt * n_pts * sizeof(float));
    if (!all_data) { free(sel); free(lats); free(lons); free(lat2d); free(lon2d);
                     free(times); free(chunk); return NULL; }
    for (uint32_t t = 0; t < nt; t++) {
        grib2_msg_t* m = &msgs[sel[w0 + t]];
        times[t] = parse_sec1_reftime(data + m->sec1_off, (uint32_t)m->sec1_len)
                 + parse_sec4_forecast_offset(data + m->sec4_off, (uint32_t)m->sec4_len);
        if (grib2_decode_one_field(data, m, n_pts, chunk) != 0) {
            free(all_data); free(sel); free(lats); free(lons); free(lat2d); free(lon2d);
            free(times); free(chunk); return NULL;
        }
        memcpy(all_data + (size_t)t * n_pts, chunk, n_pts * sizeof(float));
    }
    free(chunk); free(sel);
    const char* var_name = grib2_get_variable_name(vi->cat, vi->num);
    if (is_curv)
        return refs_open_from_arrays_2d(var_name, nx, ny, nt, lat2d, lon2d, times, all_data);
    return refs_open_from_arrays(var_name, nx, ny, nt, lats, lons, times, all_data);
}

EMSCRIPTEN_KEEPALIVE
refs_dataset_t* wp_normalize(wp_scan_result_t* s, int var_index) {
    return wp_normalize_range(s, var_index, 0, INT32_MAX, -1, -1);
}

/* Curvilinear (polar) grid window export: decode timestep tt and resample onto
 * a width×height bbox grid via the exact inverse projection (O(1) per pixel).
 * Returns a malloc'd width*height Float32 buffer (NaN outside the grid); caller
 * frees via wp_free. NULL if the variable is not a polar grid. */
EMSCRIPTEN_KEEPALIVE
float* wp_grid_resample_polar(wp_scan_result_t* s, int var_index, int32_t tt,
                              double minLon, double minLat, double maxLon, double maxLat,
                              int32_t width, int32_t height) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NULL;
    if (width <= 0 || height <= 0) return NULL;
    wp_var_info_t* vi = &s->vars[var_index];
    const uint8_t* data = s->grb_data; grib2_msg_t* msgs = s->msgs; int n_msgs = s->n_msgs;

    int first_idx = -1;
    for (int i = 0; i < n_msgs; i++)
        if (msgs[i].param_cat == vi->cat && msgs[i].param_num == vi->num) { first_idx = i; break; }
    if (first_idx < 0) return NULL;

    grib2_grid_t g;
    if (grib2_parse_grid(vi, data + msgs[first_idx].sec3_off,
                         (uint32_t)msgs[first_idx].sec3_len, &g) != 0) return NULL;
    if (g.kind != 3) return NULL;             /* polar only */
    uint32_t nx = g.nx, ny = g.ny, n_pts = nx * ny, ref_npts = n_pts;

    int* sel = (int*)malloc((size_t)n_msgs * sizeof(int));
    if (!sel) return NULL;
    int sel_cnt = 0;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat != vi->cat || msgs[i].param_num != vi->num) continue;
        uint32_t npts = (msgs[i].sec5_len >= 9) ? be32(data + msgs[i].sec5_off + 5) : 0;
        if (npts == ref_npts || msgs[i].sec6_off != 0) sel[sel_cnt++] = i;
    }
    if (sel_cnt == 0) { free(sel); return NULL; }
    if (tt < 0) tt = 0;
    if (tt > sel_cnt - 1) tt = sel_cnt - 1;

    float* field = (float*)malloc((size_t)n_pts * sizeof(float));
    if (!field) { free(sel); return NULL; }
    if (grib2_decode_one_field(data, &msgs[sel[tt]], n_pts, field) != 0) {
        free(field); free(sel); return NULL;
    }
    free(sel);

    float* out = (float*)malloc((size_t)width * height * sizeof(float));
    if (!out) { free(field); return NULL; }
    double dx = (maxLon - minLon) / width, dy = (maxLat - minLat) / height;
    for (int y = 0; y < height; y++) {
        double lat = maxLat - (y + 0.5) * dy;
        for (int x = 0; x < width; x++) {
            double lon = minLon + (x + 0.5) * dx;
            double fi, fj;
            polar_stereo_inverse(&g.ps, lat, lon, &fi, &fj);
            long ii = (long)floor(fi + 0.5), jj = (long)floor(fj + 0.5);
            out[(size_t)y * width + x] =
                (ii >= 0 && ii < (long)nx && jj >= 0 && jj < (long)ny)
                ? field[(size_t)jj * nx + ii] : NAN;
        }
    }
    free(field);
    return out;
}

/* Decode ONE message's field and return the value at grid cell (iy,ix), with no
 * coordinate build, dataset, or JSON. Used by the range-native streaming loop,
 * where the cell is already known — avoids re-projecting the whole grid and
 * re-marshalling per message. Returns NaN on any error / fill (caller → null). */
EMSCRIPTEN_KEEPALIVE
double wp_scan_decode_cell(wp_scan_result_t* s, int var_index, int32_t iy, int32_t ix) {
    if (!s || var_index < 0 || var_index >= s->n_vars) return NAN;
    wp_var_info_t* vi = &s->vars[var_index];
    const uint8_t* data = s->grb_data; grib2_msg_t* msgs = s->msgs; int n_msgs = s->n_msgs;
    int first = -1;
    for (int i = 0; i < n_msgs; i++)
        if (msgs[i].param_cat == vi->cat && msgs[i].param_num == vi->num) { first = i; break; }
    if (first < 0) return NAN;
    grib2_grid_t g;
    if (grib2_parse_grid(vi, data + msgs[first].sec3_off,
                         (uint32_t)msgs[first].sec3_len, &g) != 0) return NAN;
    uint32_t nx = g.nx, ny = g.ny, n_pts = nx * ny;
    if (iy < 0 || ix < 0 || (uint32_t)iy >= ny || (uint32_t)ix >= nx) return NAN;
    float* chunk = (float*)malloc((size_t)n_pts * sizeof(float));
    if (!chunk) return NAN;
    if (grib2_decode_one_field(data, &msgs[first], n_pts, chunk) != 0) { free(chunk); return NAN; }
    float v = chunk[(size_t)iy * nx + ix];
    free(chunk);
    return (double)v;
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
 * Trim helper: full header layout for the JS trim pipeline.
 *
 * Returns a JSON dump of the parsed nc3_file_t — version, numrecs, dims,
 * global attrs, and per-variable definitions including the byte offset
 * (`begin`) and size (`vsize`) JS needs to copy data spans verbatim.
 *
 * Attribute values are base64-encoded so binary attrs (e.g. _FillValue
 * as IEEE bytes) round-trip exactly. Truncated atts (parser stores at
 * most 512 bytes inline) are emitted as-is; nelems still reflects the
 * original count so JS can detect truncation by comparing
 * nelems * type_size to the decoded length.
 *
 * Returned string is malloc'd; caller frees with wp_free.
 * ------------------------------------------------------------------ */

/* Emit one nc3_att_t as `{"name":..., "type":n, "nelems":n, "value_b64":"..."}` */
static int wp_nc3_emit_att(const nc3_att_t* a, char** buf, size_t* len, size_t* cap) {
    uint32_t tsz   = nc3_type_size(a->type);
    size_t   nbyte = (size_t)a->nelems * (size_t)tsz;
    if (nbyte > sizeof(a->value)) nbyte = sizeof(a->value);  /* truncated */

    size_t b64cap = base64_encode_len(nbyte);
    char*  b64    = (char*)malloc(b64cap);
    if (!b64) return -1;
    if (nbyte > 0)
        base64_encode((const uint8_t*)a->value, nbyte, b64);
    else
        b64[0] = '\0';

    char name_esc[NC3_MAX_NAME + 8];
    json_escape(a->name, wp_strnlen(a->name, NC3_MAX_NAME),
                name_esc, sizeof(name_esc));

    /* Grow buf if needed and append */
    size_t need = strlen(name_esc) + b64cap + 96;
    while (*cap - *len < need) {
        *cap *= 2;
        char* t = (char*)realloc(*buf, *cap);
        if (!t) { free(b64); return -1; }
        *buf = t;
    }
    int n = snprintf(*buf + *len, *cap - *len,
        "{\"name\":%s,\"type\":%d,\"nelems\":%u,\"value_b64\":\"%s\"}",
        name_esc, (int)a->type, a->nelems, b64);
    if (n < 0) { free(b64); return -1; }
    *len += (size_t)n;
    free(b64);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
char* wp_nc3_full_layout(const wp_nc3_scan_result_t* s) {
    if (!s) return NULL;
    const nc3_file_t* nc = &s->nc;

    size_t cap = 16384, len = 0;
    char*  buf = (char*)malloc(cap);
    if (!buf) return NULL;

    #define NCLAY(...) do { \
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

    NCLAY("{\n");
    NCLAY("  \"version\": %u,\n", nc->version);
    NCLAY("  \"numrecs\": %u,\n", nc->numrecs);
    NCLAY("  \"data_len\": %u,\n", s->data_len);

    /* Dimensions */
    NCLAY("  \"dims\": [");
    for (uint32_t d = 0; d < nc->ndims; d++) {
        const nc3_dim_t* di = &nc->dims[d];
        char dn[NC3_MAX_NAME + 8];
        json_escape(di->name, wp_strnlen(di->name, NC3_MAX_NAME), dn, sizeof(dn));
        NCLAY("%s{\"index\":%u,\"name\":%s,\"length\":%u,\"is_unlimited\":%s}",
              (d == 0 ? "" : ","), d, dn, di->length,
              di->is_unlimited ? "true" : "false");
    }
    NCLAY("],\n");

    /* Global attributes */
    NCLAY("  \"gatts\": [");
    for (uint32_t a = 0; a < nc->ngatts; a++) {
        if (a > 0) NCLAY(",");
        if (wp_nc3_emit_att(&nc->gatts[a], &buf, &len, &cap) != 0) {
            free(buf); return NULL;
        }
    }
    NCLAY("],\n");

    /* Variables */
    NCLAY("  \"vars\": [");
    for (uint32_t v = 0; v < nc->nvars; v++) {
        const nc3_var_t* var = &nc->vars[v];
        if (v > 0) NCLAY(",");

        char vn[NC3_MAX_NAME + 8];
        json_escape(var->name, wp_strnlen(var->name, NC3_MAX_NAME), vn, sizeof(vn));

        NCLAY("{\"index\":%u,\"name\":%s,\"type\":%d,\"type_size\":%u,"
              "\"ndims\":%u,\"dim_indices\":[",
              v, vn, (int)var->type, nc3_type_size(var->type), var->ndims);
        for (uint32_t d = 0; d < var->ndims; d++) {
            NCLAY("%s%u", (d == 0 ? "" : ","), var->dimids[d]);
        }
        NCLAY("],\"shape\":[");
        for (uint32_t d = 0; d < var->ndims; d++) {
            uint32_t did   = var->dimids[d];
            uint32_t dlen  = (did < nc->ndims) ? nc->dims[did].length : 0;
            int     unlim  = (did < nc->ndims) ? nc->dims[did].is_unlimited : 0;
            /* For the unlimited dim, project shape using numrecs */
            uint32_t shp = unlim ? nc->numrecs : dlen;
            NCLAY("%s%u", (d == 0 ? "" : ","), shp);
        }
        NCLAY("],\"is_record\":%s,\"begin\":%llu,\"vsize\":%u,\"natts\":%u,\"atts\":[",
              var->is_record ? "true" : "false",
              (unsigned long long)var->begin, var->vsize, var->natts);
        for (uint32_t a = 0; a < var->natts; a++) {
            if (a > 0) NCLAY(",");
            if (wp_nc3_emit_att(&var->atts[a], &buf, &len, &cap) != 0) {
                free(buf); return NULL;
            }
        }
        NCLAY("]}");
    }
    NCLAY("]\n");
    NCLAY("}\n");

    #undef NCLAY
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
uint32_t wp_nx(const refs_dataset_t* ds) { return refs_nx(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_ny(const refs_dataset_t* ds) { return refs_ny(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_nt(const refs_dataset_t* ds) { return refs_nt(ds); }

EMSCRIPTEN_KEEPALIVE
int wp_is_curvilinear(const refs_dataset_t* ds) { return refs_is_curvilinear(ds); }

EMSCRIPTEN_KEEPALIVE
uint32_t wp_find_nearest_cell(const refs_dataset_t* ds, double lat, double lon) {
    return refs_find_nearest_cell(ds, lat, lon);
}

EMSCRIPTEN_KEEPALIVE
float wp_cell_lat(const refs_dataset_t* ds, uint32_t iy, uint32_t ix) {
    return refs_cell_lat(ds, iy, ix);
}

EMSCRIPTEN_KEEPALIVE
float wp_cell_lon(const refs_dataset_t* ds, uint32_t iy, uint32_t ix) {
    return refs_cell_lon(ds, iy, ix);
}

/* ---- Pointer accessors for parallel bbox grid extraction (extractGrid) ----
 *
 * Each accessor returns a pointer into the WASM heap so JS can wrap the array
 * via `new Float32Array(wasm.HEAPF32.buffer, ptr >> 2, n).slice()` and detach
 * an owned copy that survives wp_close(). Workers can then receive the typed
 * array via postMessage without re-parsing the source file.
 *
 * Layout:
 *   wp_ds_lats_ptr  -> float[ny]
 *   wp_ds_lons_ptr  -> float[nx]
 *   wp_ds_data_ptr  -> float[nt*ny*nx], row-major [t, y, x]
 */
EMSCRIPTEN_KEEPALIVE
const float* wp_ds_lats_ptr(const refs_dataset_t* ds) { return refs_lats(ds); }

EMSCRIPTEN_KEEPALIVE
const float* wp_ds_lons_ptr(const refs_dataset_t* ds) { return refs_lons(ds); }

EMSCRIPTEN_KEEPALIVE
const float* wp_ds_data_ptr(const refs_dataset_t* ds) { return refs_data(ds); }

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
