/*
 * query_refs.c  --  Query engine for normalized refs data
 *
 * Loads a .refs.json + .bin pair produced by normalize_refs, and
 * provides an API to query by time / lat / lon.  Used by main.c.
 */

#include "query_refs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "../core/util/base64.h"

/* =========================================================================
 * Internal dataset structure
 * ======================================================================= */

struct refs_dataset {
    char*    var_name;
    char*    source_path;   /* .bin relative path from JSON */
    char*    bin_path;      /* resolved absolute .bin path */
    uint32_t nx, ny, nt;
    float*   lats;          /* [ny] */
    float*   lons;          /* [nx] */
    int64_t* times;         /* [nt] */
    FILE*    bin_f;         /* open handle to .bin file */
};

/* =========================================================================
 * Minimal JSON helpers (known structure, no full parser needed)
 * ======================================================================= */

static char* json_get_string(const char* json, const char* key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* p = strstr(json, pattern);
    if (!p) return NULL;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '"') return NULL;
    p++;
    const char* end = strchr(p, '"');
    if (!end) return NULL;
    size_t len = (size_t)(end - p);
    char* val = (char*)malloc(len + 1);
    memcpy(val, p, len);
    val[len] = '\0';
    return val;
}

static uint32_t* json_get_int_array(const char* json, const char* key,
                                    int* out_len) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* p = strstr(json, pattern);
    if (!p) return NULL;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '[') return NULL;
    p++;
    uint32_t vals[64];
    int count = 0;
    while (*p && *p != ']' && count < 64) {
        while (*p == ' ' || *p == ',' || *p == '\n' || *p == '\r') p++;
        if (*p == ']') break;
        vals[count++] = (uint32_t)strtoul(p, (char**)&p, 10);
    }
    *out_len = count;
    uint32_t* arr = (uint32_t*)malloc((size_t)count * sizeof(uint32_t));
    memcpy(arr, vals, (size_t)count * sizeof(uint32_t));
    return arr;
}

static uint8_t* json_get_coord_b64(const char* json, const char* coord_name,
                                   size_t* out_len) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", coord_name);
    const char* p = strstr(json, pattern);
    if (!p) return NULL;
    const char* b64_key = "\"values_inline_base64\":";
    const char* q = strstr(p, b64_key);
    if (!q || (q - p) > 500) return NULL;
    q += strlen(b64_key);
    while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') q++;
    if (*q != '"') return NULL;
    q++;
    const char* end = strchr(q, '"');
    if (!end) return NULL;
    size_t b64_len = (size_t)(end - q);
    char* b64_str = (char*)malloc(b64_len + 1);
    memcpy(b64_str, q, b64_len);
    b64_str[b64_len] = '\0';
    uint8_t* decoded = (uint8_t*)malloc(base64_decode_len(b64_len));
    size_t dec_len = base64_decode(b64_str, decoded);
    free(b64_str);
    *out_len = dec_len;
    return decoded;
}

/* =========================================================================
 * Resolve .bin path relative to the refs JSON directory
 * ======================================================================= */

static char* resolve_bin(const char* refs_path, const char* source) {
    const char* last_sep = strrchr(refs_path, '/');
    const char* last_bsep = strrchr(refs_path, '\\');
    if (last_bsep && (!last_sep || last_bsep > last_sep))
        last_sep = last_bsep;

    char* out = (char*)malloc(4096);
    if (last_sep) {
        size_t dir_len = (size_t)(last_sep - refs_path + 1);
        memcpy(out, refs_path, dir_len);
        snprintf(out + dir_len, 4096 - dir_len, "%s", source);
    } else {
        snprintf(out, 4096, "%s", source);
    }
    return out;
}

/* =========================================================================
 * Public API
 * ======================================================================= */

refs_dataset_t* refs_open(const char* refs_json_path) {
    /* Read JSON file */
    FILE* f = fopen(refs_json_path, "r");
    if (!f) {
        fprintf(stderr, "Error: cannot open '%s'\n", refs_json_path);
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) { fclose(f); return NULL; }
    char* json = (char*)malloc((size_t)sz + 1);
    size_t rd = fread(json, 1, (size_t)sz, f);
    json[rd] = '\0';
    fclose(f);

    /* Parse metadata */
    char* var_name    = json_get_string(json, "name");
    char* source_path = json_get_string(json, "source_path");
    if (!var_name || !source_path) {
        fprintf(stderr, "Error: cannot parse refs JSON metadata\n");
        free(json); return NULL;
    }

    int shape_len = 0;
    uint32_t* shape = json_get_int_array(json, "shape", &shape_len);
    if (!shape || shape_len != 3) {
        fprintf(stderr, "Error: cannot parse shape\n");
        free(json); return NULL;
    }

    /* Decode coordinates */
    size_t tb = 0, lb = 0, lob = 0;
    uint8_t* time_raw = json_get_coord_b64(json, "time", &tb);
    uint8_t* lat_raw  = json_get_coord_b64(json, "lat",  &lb);
    uint8_t* lon_raw  = json_get_coord_b64(json, "lon",  &lob);
    if (!time_raw || !lat_raw || !lon_raw) {
        fprintf(stderr, "Error: cannot decode coordinate arrays\n");
        free(json); return NULL;
    }

    /* Open .bin file */
    char* bin_path = resolve_bin(refs_json_path, source_path);
    FILE* bin_f = fopen(bin_path, "rb");
    if (!bin_f) {
        fprintf(stderr, "Error: cannot open bin file '%s'\n", bin_path);
        free(json); free(bin_path); return NULL;
    }

    /* Build dataset */
    refs_dataset_t* ds = (refs_dataset_t*)calloc(1, sizeof(refs_dataset_t));
    ds->var_name    = var_name;
    ds->source_path = source_path;
    ds->bin_path    = bin_path;
    ds->nt          = shape[0];
    ds->ny          = shape[1];
    ds->nx          = shape[2];
    ds->times       = (int64_t*)time_raw;
    ds->lats        = (float*)lat_raw;
    ds->lons        = (float*)lon_raw;
    ds->bin_f       = bin_f;

    free(shape);
    free(json);
    return ds;
}

void refs_close(refs_dataset_t* ds) {
    if (!ds) return;
    if (ds->bin_f) fclose(ds->bin_f);
    free(ds->var_name);
    free(ds->source_path);
    free(ds->bin_path);
    free(ds->times);
    free(ds->lats);
    free(ds->lons);
    free(ds);
}

const char*    refs_variable_name(const refs_dataset_t* ds) { return ds->var_name; }
uint32_t       refs_nx(const refs_dataset_t* ds) { return ds->nx; }
uint32_t       refs_ny(const refs_dataset_t* ds) { return ds->ny; }
uint32_t       refs_nt(const refs_dataset_t* ds) { return ds->nt; }
const float*   refs_lats(const refs_dataset_t* ds) { return ds->lats; }
const float*   refs_lons(const refs_dataset_t* ds) { return ds->lons; }
const int64_t* refs_times(const refs_dataset_t* ds) { return ds->times; }

/* =========================================================================
 * Timestamp formatting
 * ======================================================================= */

void refs_unix_to_iso8601(int64_t ts, char* buf, size_t buf_sz) {
    if (ts < 0) { snprintf(buf, buf_sz, "unknown"); return; }

    int64_t days = ts / 86400;
    int sod  = (int)(ts % 86400);
    int hour = sod / 3600;
    int min  = (sod % 3600) / 60;
    int sec  = sod % 60;

    static const int dpm[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    int year = 1970;
    while (1) {
        int leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
        int yd = 365 + leap;
        if (days < yd) break;
        days -= yd;
        year++;
    }
    int leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    int month = 1;
    for (int m = 0; m < 12; m++) {
        int md = dpm[m] + (m == 1 ? leap : 0);
        if (days < md) break;
        days -= md;
        month++;
    }
    int day = (int)days + 1;

    snprintf(buf, buf_sz, "%04d-%02d-%02dT%02d:%02d:%02dZ",
             year, month, day, hour, min, sec);
}

/* =========================================================================
 * Nearest-neighbor lookups
 * ======================================================================= */

uint32_t refs_find_nearest_lat(const refs_dataset_t* ds, double lat) {
    uint32_t best = 0;
    double best_d = fabs((double)ds->lats[0] - lat);
    for (uint32_t i = 1; i < ds->ny; i++) {
        double d = fabs((double)ds->lats[i] - lat);
        if (d < best_d) { best_d = d; best = i; }
    }
    return best;
}

uint32_t refs_find_nearest_lon(const refs_dataset_t* ds, double lon) {
    uint32_t best = 0;
    double best_d = fabs((double)ds->lons[0] - lon);
    for (uint32_t i = 1; i < ds->nx; i++) {
        double d = fabs((double)ds->lons[i] - lon);
        if (d < best_d) { best_d = d; best = i; }
    }
    return best;
}

uint32_t refs_find_nearest_time(const refs_dataset_t* ds, int64_t unix_ts) {
    uint32_t best = 0;
    int64_t best_d = llabs(ds->times[0] - unix_ts);
    for (uint32_t i = 1; i < ds->nt; i++) {
        int64_t d = llabs(ds->times[i] - unix_ts);
        if (d < best_d) { best_d = d; best = i; }
    }
    return best;
}

/* =========================================================================
 * Data access
 * ======================================================================= */

int refs_read_timestep(refs_dataset_t* ds, uint32_t time_idx, float* out) {
    if (time_idx >= ds->nt) return -1;
    uint64_t chunk_bytes = (uint64_t)ds->ny * ds->nx * sizeof(float);
    uint64_t offset = (uint64_t)time_idx * chunk_bytes;
    fseek(ds->bin_f, (long)offset, SEEK_SET);
    size_t n = ds->ny * ds->nx;
    if (fread(out, sizeof(float), n, ds->bin_f) != n) return -1;
    return 0;
}

int refs_read_value(refs_dataset_t* ds,
                    uint32_t time_idx, uint32_t lat_idx, uint32_t lon_idx,
                    float* out_value) {
    if (time_idx >= ds->nt || lat_idx >= ds->ny || lon_idx >= ds->nx)
        return -1;
    uint64_t chunk_bytes = (uint64_t)ds->ny * ds->nx * sizeof(float);
    uint64_t offset = (uint64_t)time_idx * chunk_bytes
                    + ((uint64_t)lat_idx * ds->nx + lon_idx) * sizeof(float);
    fseek(ds->bin_f, (long)offset, SEEK_SET);
    if (fread(out_value, sizeof(float), 1, ds->bin_f) != 1) return -1;
    return 0;
}

/* =========================================================================
 * JSON output
 * ======================================================================= */

int refs_query_to_json(refs_dataset_t* ds,
                       const uint32_t* time_indices, uint32_t time_count,
                       int32_t lat_idx, int32_t lon_idx,
                       FILE* out_f) {
    uint32_t lat_start, lat_end, lon_start, lon_end;

    if (lat_idx >= 0) { lat_start = (uint32_t)lat_idx; lat_end = lat_start + 1; }
    else              { lat_start = 0; lat_end = ds->ny; }

    if (lon_idx >= 0) { lon_start = (uint32_t)lon_idx; lon_end = lon_start + 1; }
    else              { lon_start = 0; lon_end = ds->nx; }

    /* If no time indices given, use all */
    uint32_t* t_idx = NULL;
    uint32_t  t_cnt = time_count;
    if (!time_indices || time_count == 0) {
        t_cnt = ds->nt;
        t_idx = (uint32_t*)malloc(t_cnt * sizeof(uint32_t));
        for (uint32_t i = 0; i < t_cnt; i++) t_idx[i] = i;
    } else {
        t_idx = (uint32_t*)malloc(t_cnt * sizeof(uint32_t));
        memcpy(t_idx, time_indices, t_cnt * sizeof(uint32_t));
    }

    float* chunk = (float*)malloc((size_t)ds->ny * ds->nx * sizeof(float));
    if (!chunk) { free(t_idx); return -1; }

    fprintf(out_f, "{\n");
    fprintf(out_f, "  \"variable\": \"%s\",\n", ds->var_name);
    fprintf(out_f, "  \"grid\": { \"nx\": %u, \"ny\": %u, \"nt\": %u },\n",
            ds->nx, ds->ny, ds->nt);
    fprintf(out_f, "  \"results\": [\n");

    int first = 1;
    for (uint32_t ti = 0; ti < t_cnt; ti++) {
        uint32_t t = t_idx[ti];
        if (refs_read_timestep(ds, t, chunk) != 0) continue;

        char ts[64];
        refs_unix_to_iso8601(ds->times[t], ts, sizeof(ts));

        for (uint32_t j = lat_start; j < lat_end; j++) {
            for (uint32_t i = lon_start; i < lon_end; i++) {
                if (!first) fprintf(out_f, ",\n");
                first = 0;
                fprintf(out_f,
                    "    {\"time\": \"%s\", \"lat\": %.4f, \"lon\": %.4f, \"value\": %.6g}",
                    ts, (double)ds->lats[j], (double)ds->lons[i],
                    (double)chunk[j * ds->nx + i]);
            }
        }
    }

    fprintf(out_f, "\n  ]\n}\n");

    free(chunk);
    free(t_idx);
    return 0;
}
