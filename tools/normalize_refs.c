/*
 * normalize_refs.c  --  Offline GRIB2 normalizer for SciWrid Toolkit (Sprint 1)
 *
 * Reads a GRIB2 regular lat/lon file (grid template 0 or 40), decodes
 * every field (time step) to raw float32, writes a .bin companion file,
 * and emits a refs_v1 JSON the C runtime can query without ever loading
 * the original GRIB2 again.
 *
 * This is a NATIVE-ONLY offline tool.  Never compiled to WASM.
 *
 * Usage:
 *   normalize_refs <input.grb2> <outdir/>               auto mode
 *   normalize_refs <input.grb2> <out.refs.json> --var <name>
 *   normalize_refs <input.grb2> --list
 *   normalize_refs --vars
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

#include "../core/util/base64.h"
#include "../formats/grib2/grib2_metadata.h"
#include "../helper/grib2converthelpers.h"

/* -------------------------------------------------------------------------
 * Platform portability
 * ---------------------------------------------------------------------- */

#ifdef _WIN32
#  define PATH_SEP '\\'
#else
#  define PATH_SEP '/'
#endif

/* -------------------------------------------------------------------------
 * File I/O
 * ---------------------------------------------------------------------- */

static uint8_t* read_file(const char* path, uint64_t* out_len) {
    FILE* f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "Error: cannot open '%s'\n", path); return NULL; }

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (sz <= 0) {
        fprintf(stderr, "Error: invalid file size for '%s'\n", path);
        fclose(f); return NULL;
    }

    uint8_t* buf = (uint8_t*)malloc((size_t)sz);
    if (!buf) {
        fprintf(stderr, "Error: out of memory\n");
        fclose(f); return NULL;
    }

    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "Error: incomplete read of '%s'\n", path);
        free(buf); fclose(f); return NULL;
    }

    fclose(f);
    *out_len = (uint64_t)sz;
    return buf;
}

/* -------------------------------------------------------------------------
 * Coordinate array builders
 * ---------------------------------------------------------------------- */

static float* build_lat_array(const grid_latlon_t* g) {
    float* lats = (float*)malloc(g->ny * sizeof(float));
    if (!lats) return NULL;
    for (uint32_t j = 0; j < g->ny; j++)
        lats[j] = (float)(g->lat1 + j * g->dj);
    return lats;
}

static float* build_lon_array(const grid_latlon_t* g) {
    float* lons = (float*)malloc(g->nx * sizeof(float));
    if (!lons) return NULL;
    for (uint32_t i = 0; i < g->nx; i++) {
        double lon = g->lon1 + i * g->di;
        while (lon >  180.0) lon -= 360.0;
        while (lon < -180.0) lon += 360.0;
        lons[i] = (float)lon;
    }
    return lons;
}

/* -------------------------------------------------------------------------
 * Variable name <-> (cat, num) lookup table
 * ---------------------------------------------------------------------- */

typedef struct { const char* name; uint8_t cat; uint8_t num; } var_entry_t;

static const var_entry_t VAR_TABLE[] = {
    { "temperature",         0,  0 },
    { "specific_humidity",   1,  0 },
    { "relative_humidity",   1,  1 },
    { "total_precipitation", 1,  8 },
    { "u_component_of_wind", 2,  2 },
    { "v_component_of_wind", 2,  3 },
    { "u_wind",              2,  2 }, /* alias */
    { "v_wind",              2,  3 }, /* alias */
    { "pressure",            3,  0 },
    { "geopotential_height", 3,  5 },
};
static const int VAR_TABLE_LEN =
    (int)(sizeof(VAR_TABLE) / sizeof(VAR_TABLE[0]));

/* name -> (cat, num); returns 0 on success, -1 if not found */
static int var_lookup(const char* name, uint8_t* out_cat, uint8_t* out_num) {
    for (int i = 0; i < VAR_TABLE_LEN; i++) {
        if (strcmp(VAR_TABLE[i].name, name) == 0) {
            *out_cat = VAR_TABLE[i].cat;
            *out_num = VAR_TABLE[i].num;
            return 0;
        }
    }
    return -1;
}

static void print_supported_vars(void) {
    printf("Supported --var names:\n");
    for (int i = 0; i < VAR_TABLE_LEN; i++) {
        int dup = 0;
        for (int j = 0; j < i; j++) {
            if (VAR_TABLE[j].cat == VAR_TABLE[i].cat &&
                VAR_TABLE[j].num == VAR_TABLE[i].num) { dup = 1; break; }
        }
        printf("  %-26s  cat=%u  num=%u  (%s)%s\n",
               VAR_TABLE[i].name,
               VAR_TABLE[i].cat, VAR_TABLE[i].num,
               grib2_get_variable_name(VAR_TABLE[i].cat, VAR_TABLE[i].num),
               dup ? "  [alias]" : "");
    }
}

/* -------------------------------------------------------------------------
 * JSON output helpers
 * ---------------------------------------------------------------------- */

static void json_write_base64_array(FILE* f, const char* label,
                                    const char* dtype,
                                    const uint8_t* src, size_t src_bytes,
                                    int indent) {
    char* b64 = (char*)malloc(base64_encode_len(src_bytes));
    if (!b64) { fprintf(stderr, "Error: out of memory\n"); return; }
    base64_encode(src, src_bytes, b64);

    for (int i = 0; i < indent; i++) fputc(' ', f);
    fprintf(f, "\"%s\": {\n", label);
    for (int i = 0; i < indent + 2; i++) fputc(' ', f);
    fprintf(f, "\"dtype\": \"%s\",\n", dtype);
    for (int i = 0; i < indent + 2; i++) fputc(' ', f);
    fprintf(f, "\"values_inline_base64\": \"%s\"\n", b64);
    for (int i = 0; i < indent; i++) fputc(' ', f);
    fprintf(f, "}");
    free(b64);
}

static int write_refs_json(const char*    refs_path,
                           const char*    bin_rel_path,
                           const char*    var_name,
                           uint32_t       nx,  uint32_t ny, uint32_t nt,
                           const float*   lats, const float* lons,
                           const int64_t* times_unix,
                           uint64_t       chunk_bytes) {
    FILE* f = fopen(refs_path, "w");
    if (!f) {
        fprintf(stderr, "Error: cannot write '%s'\n", refs_path);
        return -1;
    }

    fprintf(f, "{\n");
    fprintf(f, "  \"version\": 1,\n");
    fprintf(f, "  \"source_path\": \"%s\",\n", bin_rel_path);
    fprintf(f, "  \"format\": \"raw_f32le\",\n");
    fprintf(f, "  \"variable\": {\n");
    fprintf(f, "    \"name\": \"%s\",\n",           var_name);
    fprintf(f, "    \"dtype\": \"f32le\",\n");
    fprintf(f, "    \"shape\": [%u, %u, %u],\n",    nt, ny, nx);
    fprintf(f, "    \"chunks\": [1, %u, %u],\n",    ny, nx);
    fprintf(f, "    \"compression\": \"none\",\n");
    fprintf(f, "    \"fill_value\": 9.96920996838686905e+36,\n");
    fprintf(f, "    \"units\": \"unknown\",\n");
    fprintf(f, "    \"dimensions\": [\"time\", \"lat\", \"lon\"]\n");
    fprintf(f, "  },\n");

    fprintf(f, "  \"coordinates\": {\n");
    json_write_base64_array(f, "time", "i64",
                            (const uint8_t*)times_unix,
                            (size_t)nt * sizeof(int64_t), 4);
    fprintf(f, ",\n");
    json_write_base64_array(f, "lat", "f32",
                            (const uint8_t*)lats,
                            (size_t)ny * sizeof(float), 4);
    fprintf(f, ",\n");
    json_write_base64_array(f, "lon", "f32",
                            (const uint8_t*)lons,
                            (size_t)nx * sizeof(float), 4);
    fprintf(f, "\n");
    fprintf(f, "  },\n");

    fprintf(f, "  \"chunk_index\": {\n");
    for (uint32_t t = 0; t < nt; t++) {
        uint64_t offset = (uint64_t)t * chunk_bytes;
        fprintf(f, "    \"%u.0.0\": { \"offset\": %llu, \"length\": %llu }",
                t,
                (unsigned long long)offset,
                (unsigned long long)chunk_bytes);
        if (t + 1 < nt) fprintf(f, ",");
        fprintf(f, "\n");
    }
    fprintf(f, "  }\n}\n");

    fclose(f);
    return 0;
}

/* -------------------------------------------------------------------------
 * Build .bin output path and relative name from refs path
 * ---------------------------------------------------------------------- */

static void build_bin_path(const char* refs_path,
                           char* bin_path, size_t bin_path_sz,
                           char* bin_rel,  size_t bin_rel_sz) {
    strncpy(bin_path, refs_path, bin_path_sz - 1);
    bin_path[bin_path_sz - 1] = '\0';

    char* ext = strstr(bin_path, ".refs.json");
    if (!ext) ext = strstr(bin_path, ".json");
    if (ext) *ext = '\0';
    strncat(bin_path, ".bin", bin_path_sz - strlen(bin_path) - 1);

    const char* last_sep = strrchr(bin_path, PATH_SEP);
    const char* bin_name = last_sep ? last_sep + 1 : bin_path;
    snprintf(bin_rel, bin_rel_sz, "%s", bin_name);
}

/* -------------------------------------------------------------------------
 * --list subcommand
 * ---------------------------------------------------------------------- */

static void cmd_list(const uint8_t* data, uint64_t file_len,
                     grib2_msg_t* msgs, int n_msgs) {
    (void)file_len;
    printf("\nFields found: %d\n\n", n_msgs);
    printf("  %-5s %-30s %-10s %-10s %-8s %-8s\n",
           "IDX", "VARIABLE", "CAT", "NUM", "TMPL", "GRID");
    printf("  %s\n",
           "--------------------------------------------------------------");

    for (int i = 0; i < n_msgs; i++) {
        grib2_msg_t* m = &msgs[i];
        uint32_t nx = 0, ny = 0;
        if (m->sec3_len >= 38) {
            nx = be32(data + m->sec3_off + 30);
            ny = be32(data + m->sec3_off + 34);
        }
        printf("  %-5d %-30s cat=%-4u num=%-4u grid=%-4u data=%-4u %ux%u\n",
               i,
               grib2_get_variable_name(m->param_cat, m->param_num),
               m->param_cat, m->param_num,
               be16(data + m->sec3_off + 12),
               be16(data + m->sec5_off + 9),
               nx, ny);
    }
    printf("\n");
}

/* -------------------------------------------------------------------------
 * Core normalizer: collect all time steps for one variable, decode,
 * write .bin, write .refs.json
 * ---------------------------------------------------------------------- */

static int normalize_grib2(const uint8_t* data, uint64_t file_len,
                            grib2_msg_t* msgs, int n_msgs,
                            uint8_t target_cat, uint8_t target_num,
                            const char* refs_path) {
    (void)file_len;

    /* Collect matching messages that share the same grid as the first one.
     * GFS files contain the same variable on different grids (e.g.,
     * different pressure-level subsets use reduced grids). We only
     * normalize messages whose grid dimensions match the first hit. */
    int* sel     = (int*)malloc((size_t)n_msgs * sizeof(int));
    int  sel_cnt = 0;
    if (!sel) { fprintf(stderr, "Error: out of memory\n"); return -1; }

    /* Find first matching message and use its grid as reference */
    int first_idx = -1;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat == target_cat &&
            msgs[i].param_num == target_num) {
            first_idx = i; break;
        }
    }
    if (first_idx < 0) { free(sel); return -1; }

    /* Parse reference grid */
    grid_latlon_t grid;
    if (parse_sec3_latlon(data + msgs[first_idx].sec3_off,
                          (uint32_t)msgs[first_idx].sec3_len, &grid) != 0) {
        free(sel); return -1;
    }

    /* Collect only messages with matching num_pts.
     * GRIB2 messages can share Section 3 (grid definition), so checking
     * sec3 nx/ny alone is not reliable. Section 5 num_pts (octets 5-8)
     * is the authoritative point count for each message's actual data. */
    uint32_t ref_npts = grid.nx * grid.ny;
    int skipped_grid = 0;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat != target_cat ||
            msgs[i].param_num != target_num)
            continue;
        uint32_t npts = (msgs[i].sec5_len >= 9)
                        ? be32(data + msgs[i].sec5_off + 5) : 0;
        if (npts == ref_npts) {
            sel[sel_cnt++] = i;
        } else {
            skipped_grid++;
        }
    }

    printf("  Variable    : %s (cat=%u, num=%u)\n",
           grib2_get_variable_name(target_cat, target_num),
           target_cat, target_num);
    printf("  Time steps  : %d messages", sel_cnt);
    if (skipped_grid > 0)
        printf("  (%d skipped, different grid)", skipped_grid);
    printf("\n");

    printf("  Grid        : %ux%u  lat=[%.4f..%.4f]  lon=[%.4f..%.4f]\n",
           grid.nx, grid.ny, grid.lat1, grid.lat2, grid.lon1, grid.lon2);
    printf("  Di/Dj       : %.6f / %.6f degrees\n", grid.di, grid.dj);
    printf("  Scanning    : 0x%02X\n", grid.scanning_mode);

    uint32_t nx = grid.nx, ny = grid.ny;
    uint32_t nt = (uint32_t)sel_cnt;

    float* lats = build_lat_array(&grid);
    float* lons = build_lon_array(&grid);
    if (!lats || !lons) {
        fprintf(stderr, "Error: out of memory for coordinate arrays\n");
        free(sel); free(lats); free(lons); return -1;
    }

    int64_t* times_unix = (int64_t*)malloc((size_t)nt * sizeof(int64_t));
    if (!times_unix) {
        fprintf(stderr, "Error: out of memory\n");
        free(sel); free(lats); free(lons); return -1;
    }

    for (uint32_t t = 0; t < nt; t++) {
        grib2_msg_t* m = &msgs[sel[t]];
        int64_t ref = parse_sec1_reftime(data + m->sec1_off,
                                         (uint32_t)m->sec1_len);
        int64_t off = parse_sec4_forecast_offset(data + m->sec4_off,
                                                 (uint32_t)m->sec4_len);
        times_unix[t] = ref + off;
    }

    uint32_t n_pts      = nx * ny;
    uint64_t chunk_bytes = (uint64_t)n_pts * sizeof(float);
    float*   chunk_buf  = (float*)malloc((size_t)chunk_bytes);
    if (!chunk_buf) {
        fprintf(stderr, "Error: out of memory for chunk buffer\n");
        free(sel); free(lats); free(lons); free(times_unix); return -1;
    }

    char bin_path[4096], bin_rel[512];
    build_bin_path(refs_path, bin_path, sizeof(bin_path),
                   bin_rel,   sizeof(bin_rel));

    printf("\n  Writing %s\n", bin_path);
    FILE* bin_f = fopen(bin_path, "wb");
    if (!bin_f) {
        fprintf(stderr, "Error: cannot write '%s'\n", bin_path);
        free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
        return -1;
    }

    for (uint32_t t = 0; t < nt; t++) {
        grib2_msg_t* m = &msgs[sel[t]];

        packing_t pk;
        memset(&pk, 0, sizeof(pk));
        if (parse_sec5(data + m->sec5_off, (uint32_t)m->sec5_len, &pk) != 0) {
            fclose(bin_f);
            free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
            return -1;
        }

        if (pk.num_pts != n_pts) {
            fprintf(stderr,
                    "  Error: time step %u has %u points but grid has %u\n",
                    t, pk.num_pts, n_pts);
            fclose(bin_f);
            free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
            return -1;
        }

        if (decode_sec7(data + m->sec7_off, (uint32_t)m->sec7_len,
                        &pk, chunk_buf) != 0) {
            fclose(bin_f);
            free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
            return -1;
        }

        if (fwrite(chunk_buf, sizeof(float), n_pts, bin_f) != n_pts) {
            fprintf(stderr, "Error: write failed for time step %u\n", t);
            fclose(bin_f);
            free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
            return -1;
        }

        if (t % 10 == 0 || t == nt - 1) {
            printf("    step %u/%u  valid=%lld\r", t + 1, nt,
                   (long long)times_unix[t]);
            fflush(stdout);
        }
    }
    fclose(bin_f);
    printf("\n");

    printf("  Wrote %.2f MB to %s\n",
           (double)(nt * chunk_bytes) / (1024.0 * 1024.0), bin_path);

    printf("  Writing %s\n", refs_path);
    int rc = write_refs_json(refs_path, bin_rel,
                             grib2_get_variable_name(target_cat, target_num),
                             nx, ny, nt, lats, lons, times_unix, chunk_bytes);

    free(sel); free(lats); free(lons); free(times_unix); free(chunk_buf);
    return rc;
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

static int is_dir_path(const char* path) {
    size_t len = strlen(path);
    return len > 0 && (path[len-1] == '/' || path[len-1] == '\\');
}

static void usage(const char* prog) {
    fprintf(stderr,
        "Usage:\n"
        "  %s <input.grb2> <outdir/>                 auto-normalize all recognized vars\n"
        "  %s <input.grb2> <out.refs.json> --var <n> single variable\n"
        "  %s <input.grb2> --list                     show all fields in file\n"
        "  %s --vars                                   show supported variable names\n",
        prog, prog, prog, prog);
}

int main(int argc, char** argv) {
    if (argc < 2) { usage(argv[0]); return 1; }

    if (strcmp(argv[1], "--vars") == 0) {
        print_supported_vars();
        return 0;
    }

    if (argc < 3) { usage(argv[0]); return 1; }

    const char* input_path = argv[1];
    int         do_list    = (strcmp(argv[2], "--list") == 0);
    const char* out_path   = do_list ? NULL : argv[2];
    const char* var_name   = NULL;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--var") == 0 && i + 1 < argc)
            var_name = argv[++i];
    }

    /* Load file */
    uint64_t file_len = 0;
    uint8_t* data = read_file(input_path, &file_len);
    if (!data) return 1;

    if (file_len < 16 || memcmp(data, "GRIB", 4) != 0) {
        fprintf(stderr, "Error: not a GRIB file (wrong magic bytes)\n");
        free(data); return 1;
    }
    if (data[7] != 2) {
        fprintf(stderr, "Error: not GRIB2 (edition=%u)\n", data[7]);
        free(data); return 1;
    }

    printf("File  : %s  (%.2f MB)\n",
           input_path, (double)file_len / (1024.0 * 1024.0));

    grib2_msg_t* msgs = NULL;
    int n_msgs = index_messages(data, file_len, &msgs);
    if (n_msgs == 0) { free(data); return 1; }
    printf("Messages indexed: %d\n", n_msgs);

    if (do_list) {
        cmd_list(data, file_len, msgs, n_msgs);
        free(msgs); free(data);
        return 0;
    }

    /* ------------------------------------------------------------------ */
    /* AUTO mode: output path ends in / or \                               */
    /* ------------------------------------------------------------------ */
    if (is_dir_path(out_path) && var_name == NULL) {
        printf("Auto mode: normalizing all recognized variables -> %s\n\n",
               out_path);

        typedef struct {
            char     name[64];
            uint8_t  cat, num;
            uint16_t grid_tmpl, data_tmpl;
            uint32_t nx, ny;
            int      normalized;
            char     refs_file[256];
        } manifest_entry_t;

        manifest_entry_t manifest[256];
        int manifest_cnt = 0;

        uint8_t seen_cat[256] = {0};
        uint8_t seen_num[256] = {0};
        int     seen_cnt = 0;
        int     done = 0, skipped = 0;

        for (int i = 0; i < n_msgs; i++) {
            uint8_t cat = msgs[i].param_cat;
            uint8_t num = msgs[i].param_num;

            int already = 0;
            for (int s = 0; s < seen_cnt; s++) {
                if (seen_cat[s] == cat && seen_num[s] == num) {
                    already = 1; break;
                }
            }
            if (already) continue;
            if (seen_cnt < 256) { seen_cat[seen_cnt] = cat; seen_num[seen_cnt] = num; seen_cnt++; }

            uint16_t grid_tmpl = be16(data + msgs[i].sec3_off + 12);
            uint16_t data_tmpl = be16(data + msgs[i].sec5_off + 9);
            uint32_t nx = (msgs[i].sec3_len >= 34) ? be32(data + msgs[i].sec3_off + 30) : 0;
            uint32_t ny = (msgs[i].sec3_len >= 38) ? be32(data + msgs[i].sec3_off + 34) : 0;

            manifest_entry_t* me = &manifest[manifest_cnt++];
            snprintf(me->name, sizeof(me->name), "%s",
                     grib2_get_variable_name(cat, num));
            me->cat = cat; me->num = num;
            me->grid_tmpl = grid_tmpl; me->data_tmpl = data_tmpl;
            me->nx = nx;   me->ny = ny;
            me->normalized = 0;
            me->refs_file[0] = '\0';

            if (grid_tmpl != 0 && grid_tmpl != 40) { skipped++; continue; }

            /* Use VAR_TABLE name if available, otherwise build from cat/num */
            const char* vname = NULL;
            for (int v = 0; v < VAR_TABLE_LEN; v++) {
                if (VAR_TABLE[v].cat == cat && VAR_TABLE[v].num == num) {
                    vname = VAR_TABLE[v].name; break;
                }
            }

            /* Build a safe filename */
            char safe_name[256];
            if (vname) {
                snprintf(safe_name, sizeof(safe_name), "%s", vname);
            } else {
                /* Sanitize the metadata name for use as filename */
                const char* meta_name = grib2_get_variable_name(cat, num);
                size_t j = 0;
                for (size_t k = 0; meta_name[k] && j < sizeof(safe_name) - 1; k++) {
                    char ch = meta_name[k];
                    if (ch == ' ' || ch == '/' || ch == '\\' || ch == '(' || ch == ')' || ch == ',')
                        ch = '_';
                    if (ch == '=' || ch == '"' || ch == '\'')
                        continue;
                    safe_name[j++] = (char)(ch >= 'A' && ch <= 'Z' ? ch + 32 : ch);
                }
                safe_name[j] = '\0';
                /* Trim trailing underscores */
                while (j > 0 && safe_name[j-1] == '_') safe_name[--j] = '\0';
            }

            char refs_path[4096];
            snprintf(refs_path, sizeof(refs_path), "%s%s.refs.json",
                     out_path, safe_name);

            printf("[%s]  cat=%u num=%u  grid=%u data=%u  %ux%u\n",
                   safe_name, cat, num, grid_tmpl, data_tmpl, nx, ny);

            int rc = normalize_grib2(data, file_len, msgs, n_msgs,
                                     cat, num, refs_path);
            if (rc != 0) {
                printf("  Skipped (unsupported packing or decode error)\n\n");
                skipped++;
            } else {
                me->normalized = 1;
                snprintf(me->refs_file, sizeof(me->refs_file), "%s.refs.json", safe_name);
                done++;
                printf("\n");
            }
        }

        /* Write manifest.json */
        char manifest_path[4096];
        snprintf(manifest_path, sizeof(manifest_path), "%smanifest.json", out_path);
        FILE* mf = fopen(manifest_path, "w");
        if (mf) {
            fprintf(mf, "{\n");
            fprintf(mf, "  \"source\": \"%s\",\n", input_path);
            fprintf(mf, "  \"fields_found\": %d,\n", manifest_cnt);
            fprintf(mf, "  \"fields_normalized\": %d,\n", done);
            fprintf(mf, "  \"fields\": [\n");
            for (int i = 0; i < manifest_cnt; i++) {
                manifest_entry_t* me = &manifest[i];
                fprintf(mf, "    {\n");
                fprintf(mf, "      \"name\": \"%s\",\n",       me->name);
                fprintf(mf, "      \"cat\": %u,\n",            me->cat);
                fprintf(mf, "      \"num\": %u,\n",            me->num);
                fprintf(mf, "      \"grid_template\": %u,\n",  me->grid_tmpl);
                fprintf(mf, "      \"data_template\": %u,\n",  me->data_tmpl);
                fprintf(mf, "      \"nx\": %u,\n",             me->nx);
                fprintf(mf, "      \"ny\": %u,\n",             me->ny);
                fprintf(mf, "      \"normalized\": %s%s\n",
                        me->normalized ? "true" : "false",
                        me->normalized ? "," : "");
                if (me->normalized)
                    fprintf(mf, "      \"refs\": \"%s\"\n", me->refs_file);
                fprintf(mf, "    }%s\n", i + 1 < manifest_cnt ? "," : "");
            }
            fprintf(mf, "  ]\n}\n");
            fclose(mf);
            printf("Manifest written: %s\n", manifest_path);
        }

        printf("\nAuto mode complete: %d normalized, %d skipped.\n",
               done, skipped);
        free(msgs); free(data);
        return 0;
    }

    /* ------------------------------------------------------------------ */
    /* SINGLE variable mode                                                 */
    /* ------------------------------------------------------------------ */
    if (var_name == NULL) {
        fprintf(stderr,
                "Error: specify --var <name> for single-variable mode,\n"
                "       or pass an output directory (ending in / or \\) for auto mode.\n"
                "Run with --vars to see supported names.\n");
        free(msgs); free(data);
        return 1;
    }

    uint8_t target_cat = 0, target_num = 0;
    if (var_lookup(var_name, &target_cat, &target_num) != 0) {
        fprintf(stderr, "Error: unknown variable '%s'.\n"
                        "Run with --vars to see supported names.\n", var_name);
        free(msgs); free(data);
        return 1;
    }

    int found = 0;
    for (int i = 0; i < n_msgs; i++) {
        if (msgs[i].param_cat == target_cat && msgs[i].param_num == target_num) {
            uint16_t tmpl = be16(data + msgs[i].sec3_off + 12);
            if (tmpl != 0 && tmpl != 40) {
                fprintf(stderr,
                        "Error: grid template %u is not regular lat/lon.\n",
                        tmpl);
                free(msgs); free(data);
                return 1;
            }
            found = 1; break;
        }
    }

    if (!found) {
        fprintf(stderr,
                "Error: variable '%s' (cat=%u, num=%u) not found in file.\n"
                "Run with --list to see available fields.\n",
                var_name, target_cat, target_num);
        free(msgs); free(data);
        return 1;
    }

    int rc = normalize_grib2(data, file_len, msgs, n_msgs,
                             target_cat, target_num, out_path);
    free(msgs); free(data);

    if (rc == 0)
        printf("\nDone. Query with:  dp_cli info --ref %s\n\n", out_path);
    else
        fprintf(stderr, "\nNormalization failed.\n");

    return rc != 0 ? 1 : 0;
}
