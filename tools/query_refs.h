#ifndef QUERY_REFS_H
#define QUERY_REFS_H

/*
 * query_refs.h  --  Query engine API for normalized refs data
 *
 * Loads a .refs.json + .bin pair, then supports queries by
 * variable / time / lat / lon.  Used by main.c (interactive CLI).
 */

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
/* Opaque handle to a loaded refs dataset */
typedef struct refs_dataset refs_dataset_t;

/* Load a refs dataset from a .refs.json file.
 * Returns NULL on failure (prints error to stderr). */
refs_dataset_t* refs_open(const char* refs_json_path);

/* Close and free a refs dataset */
void refs_close(refs_dataset_t* ds);

/* Accessors */
const char*    refs_variable_name(const refs_dataset_t* ds);
uint32_t       refs_nx(const refs_dataset_t* ds);
uint32_t       refs_ny(const refs_dataset_t* ds);
uint32_t       refs_nt(const refs_dataset_t* ds);
const float*   refs_lats(const refs_dataset_t* ds);
const float*   refs_lons(const refs_dataset_t* ds);
const int64_t* refs_times(const refs_dataset_t* ds);

/* Format a Unix timestamp as ISO 8601 string */
void refs_unix_to_iso8601(int64_t ts, char* buf, size_t buf_sz);

/* Find the nearest grid index for a given lat, lon, or time */
uint32_t refs_find_nearest_lat(const refs_dataset_t* ds, double lat);
uint32_t refs_find_nearest_lon(const refs_dataset_t* ds, double lon);
uint32_t refs_find_nearest_time(const refs_dataset_t* ds, int64_t unix_ts);

/* Read a single value at (time_idx, lat_idx, lon_idx).
 * Returns 0 on success, -1 on error. */
int refs_read_value(refs_dataset_t* ds,
                    uint32_t time_idx, uint32_t lat_idx, uint32_t lon_idx,
                    float* out_value);

/* Read an entire time step into a caller-allocated buffer (nx*ny floats).
 * Returns 0 on success. */
int refs_read_timestep(refs_dataset_t* ds, uint32_t time_idx, float* out);

/* Write query results as JSON to a file.
 * time_indices: array of time step indices to include (NULL = all)
 * lat_idx, lon_idx: grid indices (-1 = all lats / all lons)
 * Returns 0 on success. */
int refs_query_to_json(refs_dataset_t* ds,
                       const uint32_t* time_indices, uint32_t time_count,
                       int32_t lat_idx, int32_t lon_idx,
                       FILE* out_f);

#endif /* QUERY_REFS_H */
