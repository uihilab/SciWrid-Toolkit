/*
 * main.c  --  Interactive CLI for querying normalized GRIB2 data
 *
 * Scans the data directory for available .refs.json files, prompts the
 * user to pick a variable, optionally a time step and location, then
 * outputs JSON results.
 *
 * Build:  make query
 * Run:    ./query.exe
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "query_refs.h"

#ifdef _WIN32
#  include <windows.h>
#  define PATH_SEP '\\'
#else
#  include <dirent.h>
#  define PATH_SEP '/'
#endif

/* -------------------------------------------------------------------------
 * Scan data directory for .refs.json files
 * ---------------------------------------------------------------------- */

#define MAX_VARS 64

typedef struct {
    char path[512];     /* full path to .refs.json */
    char name[128];     /* display name (filename without extension) */
} available_var_t;

static int scan_data_dir(const char* dir, available_var_t* vars, int max) {
    int count = 0;

#ifdef _WIN32
    char search[1024];
    snprintf(search, sizeof(search), "%s*.refs.json", dir);

    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(search, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;

    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (count >= max) break;

        snprintf(vars[count].path, sizeof(vars[count].path),
                 "%s%s", dir, fd.cFileName);

        /* Extract variable name: strip .refs.json */
        strncpy(vars[count].name, fd.cFileName, sizeof(vars[count].name) - 1);
        vars[count].name[sizeof(vars[count].name) - 1] = '\0';
        char* ext = strstr(vars[count].name, ".refs.json");
        if (ext) *ext = '\0';

        count++;
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR* d = opendir(dir);
    if (!d) return 0;

    struct dirent* ent;
    while ((ent = readdir(d)) != NULL && count < max) {
        char* ext = strstr(ent->d_name, ".refs.json");
        if (!ext) continue;
        /* Make sure it ends with .refs.json (not just contains it) */
        if (strcmp(ext, ".refs.json") != 0) continue;

        snprintf(vars[count].path, sizeof(vars[count].path),
                 "%s/%s", dir, ent->d_name);

        strncpy(vars[count].name, ent->d_name, sizeof(vars[count].name) - 1);
        vars[count].name[sizeof(vars[count].name) - 1] = '\0';
        char* p = strstr(vars[count].name, ".refs.json");
        if (p) *p = '\0';

        count++;
    }
    closedir(d);
#endif

    return count;
}

/* -------------------------------------------------------------------------
 * Read a line of input (trims newline)
 * ---------------------------------------------------------------------- */

static int read_line(const char* prompt, char* buf, size_t sz) {
    printf("%s", prompt);
    fflush(stdout);
    if (!fgets(buf, (int)sz, stdin)) return -1;
    size_t len = strlen(buf);
    while (len > 0 && (buf[len-1] == '\n' || buf[len-1] == '\r'))
        buf[--len] = '\0';
    return (int)len;
}

/* -------------------------------------------------------------------------
 * Main interactive loop
 * ---------------------------------------------------------------------- */

int main(void) {
    const char* data_dir = "../data/";

    printf("============================================\n");
    printf("  SciWrid Toolkit - GRIB2 Query Tool\n");
    printf("============================================\n\n");

    /* Scan for available variables */
    available_var_t vars[MAX_VARS];
    int n_vars = scan_data_dir(data_dir, vars, MAX_VARS);

    if (n_vars == 0) {
        printf("No normalized data found in '%s'.\n", data_dir);
        printf("Run 'make' first to normalize the GRIB2 data.\n");
        return 1;
    }

    while (1) {
        /* ---- Show available variables ---- */
        printf("Available variables:\n");
        for (int i = 0; i < n_vars; i++)
            printf("  [%d] %s\n", i + 1, vars[i].name);
        printf("  [0] Exit\n");
        printf("\n");

        /* ---- Pick a variable ---- */
        char input[256];
        if (read_line("Select variable (number or name): ", input, sizeof(input)) < 0)
            break;

        if (strcmp(input, "0") == 0 || strcasecmp(input, "exit") == 0 ||
            strcasecmp(input, "quit") == 0 || strcasecmp(input, "q") == 0)
            break;

        /* Match by number or name */
        int sel = -1;
        int num = atoi(input);
        if (num >= 1 && num <= n_vars) {
            sel = num - 1;
        } else {
            for (int i = 0; i < n_vars; i++) {
                if (strcasecmp(input, vars[i].name) == 0) {
                    sel = i; break;
                }
            }
        }

        if (sel < 0) {
            printf("  Unknown variable '%s'. Try again.\n\n", input);
            continue;
        }

        /* ---- Open the dataset ---- */
        refs_dataset_t* ds = refs_open(vars[sel].path);
        if (!ds) {
            printf("  Error loading '%s'.\n\n", vars[sel].path);
            continue;
        }

        printf("\n");
        int is_ts = refs_is_timeseries(ds);
        printf("  Variable : %s\n", refs_variable_name(ds));
        printf("  Mode     : %s\n", is_ts ? "Time Series" : "Point / Level Data");
        printf("  Grid     : %u x %u  (%u %s)\n",
               refs_nx(ds), refs_ny(ds), refs_nt(ds),
               is_ts ? "time steps" : "levels");

        /* Show time range */
        char ts_first[64], ts_last[64];
        refs_unix_to_iso8601(refs_times(ds)[0], ts_first, sizeof(ts_first));
        refs_unix_to_iso8601(refs_times(ds)[refs_nt(ds)-1], ts_last, sizeof(ts_last));
        if (is_ts) {
            printf("  Time     : %s  ..  %s\n", ts_first, ts_last);
        } else {
            printf("  Time     : %s  (single analysis time)\n", ts_first);
        }

        /* Show lat/lon range */
        const float* lats = refs_lats(ds);
        const float* lons = refs_lons(ds);
        printf("  Lat      : %.2f .. %.2f\n",
               (double)lats[0], (double)lats[refs_ny(ds)-1]);
        printf("  Lon      : %.2f .. %.2f\n",
               (double)lons[0], (double)lons[refs_nx(ds)-1]);
        printf("\n");

        /* ---- Ask for time step / level ---- */
        uint32_t nt = refs_nt(ds);
        const int64_t* times = refs_times(ds);

        uint32_t  time_idx = 0;
        uint32_t* time_indices = NULL;
        uint32_t  time_count = 0;
        int       all_times = 0;

        if (is_ts) {
            /* TIME SERIES MODE — let user pick t1 and t2 by index */
            printf("Time steps available:\n");
            for (uint32_t t = 0; t < nt; t++) {
                char ts[64];
                refs_unix_to_iso8601(times[t], ts, sizeof(ts));
                printf("  [%u] %s\n", t + 1, ts);
            }
            printf("  [a] All time steps\n\n");

            if (read_line("Start time step t1 (number, 'a' for all): ", input, sizeof(input)) < 0) {
                refs_close(ds); break;
            }

            if (input[0] == 'a' || input[0] == 'A') {
                all_times = 1;
                time_count = nt;
            } else {
                int t1 = atoi(input);
                if (t1 < 1 || t1 > (int)nt) {
                    printf("  Invalid selection, using all.\n");
                    all_times = 1;
                    time_count = nt;
                } else {
                    if (read_line("End time step t2   (number, Enter=same as t1): ", input, sizeof(input)) < 0) {
                        refs_close(ds); break;
                    }
                    int t2 = (strlen(input) > 0) ? atoi(input) : t1;
                    if (t2 < t1) t2 = t1;
                    if (t2 > (int)nt) t2 = (int)nt;

                    time_count = (uint32_t)(t2 - t1 + 1);
                    uint32_t* t_buf = (uint32_t*)malloc(time_count * sizeof(uint32_t));
                    for (uint32_t i = 0; i < time_count; i++)
                        t_buf[i] = (uint32_t)(t1 - 1 + i);
                    time_indices = t_buf;

                    char ts1[64], ts2[64];
                    refs_unix_to_iso8601(times[t1 - 1], ts1, sizeof(ts1));
                    refs_unix_to_iso8601(times[t2 - 1], ts2, sizeof(ts2));
                    printf("  Selected %u time steps: %s .. %s\n", time_count, ts1, ts2);
                }
            }
        } else {
            /* POINT / LEVEL MODE — let user pick a level */
            printf("Pressure levels available:\n");
            uint32_t show_max = nt < 20 ? nt : 20;
            for (uint32_t t = 0; t < show_max; t++) {
                printf("  [%u] Level %u\n", t + 1, t + 1);
            }
            if (nt > show_max)
                printf("  ... and %u more\n", nt - show_max);
            printf("  [a] All levels\n\n");

            if (read_line("Select level (number, 'a' for all): ", input, sizeof(input)) < 0) {
                refs_close(ds); break;
            }

            if (input[0] == 'a' || input[0] == 'A') {
                all_times = 1;
                time_count = nt;
            } else {
                int tn = atoi(input);
                if (tn >= 1 && tn <= (int)nt) {
                    time_idx = (uint32_t)(tn - 1);
                    time_indices = &time_idx;
                    time_count = 1;
                } else {
                    printf("  Invalid selection, using all levels.\n");
                    all_times = 1;
                    time_count = nt;
                }
            }
        }

        /* ---- Ask for lat/lon ---- */
        int32_t q_lat_idx = -1, q_lon_idx = -1;

        if (read_line("Latitude (press Enter for all): ", input, sizeof(input)) > 0) {
            double lat = atof(input);
            q_lat_idx = (int32_t)refs_find_nearest_lat(ds, lat);
            printf("  -> nearest lat: %.4f (index %d)\n",
                   (double)lats[q_lat_idx], q_lat_idx);
        }

        if (read_line("Longitude (press Enter for all): ", input, sizeof(input)) > 0) {
            double lon = atof(input);
            q_lon_idx = (int32_t)refs_find_nearest_lon(ds, lon);
            printf("  -> nearest lon: %.4f (index %d)\n",
                   (double)lons[q_lon_idx], q_lon_idx);
        }

        /* ---- Build output filename automatically ---- */
        char out_path[512];
        snprintf(out_path, sizeof(out_path), "../data/%s_query.json",
                 vars[sel].name);

        FILE* out_f = fopen(out_path, "w");
        if (!out_f) {
            printf("  Error: cannot write '%s'.\n", out_path);
            refs_close(ds);
            continue;
        }

        printf("\n  Running query...\n");

        /* ---- Run query ---- */
        if (all_times) {
            refs_query_to_json(ds, NULL, 0, q_lat_idx, q_lon_idx, out_f);
        } else {
            refs_query_to_json(ds, time_indices, time_count,
                               q_lat_idx, q_lon_idx, out_f);
        }

        fclose(out_f);
        printf("  Output written to: %s\n", out_path);

        /* Free time range buffer if allocated (time series mode) */
        if (is_ts && !all_times && time_indices != NULL && time_indices != &time_idx)
            free(time_indices);

        refs_close(ds);
        printf("\n--------------------------------------------\n\n");
    }

    printf("\nGoodbye.\n");
    return 0;
}
