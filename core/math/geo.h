#ifndef GEO_H
#define GEO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Constants ---- */
#define GEO_EARTH_RADIUS_M 6371000.0

/* ---- Basic structs ---- */

typedef struct {
    double lat;
    double lon;
} geo_coord_t;

typedef struct {
    uint32_t nx;
    uint32_t ny;
} geo_dims_t;

/* Generic rectilinear grid */
typedef struct {
    double lon0;      /* origin longitude */
    double lat0;      /* origin latitude */
    double dlon;      /* longitudinal resolution */
    double dlat;      /* latitudinal resolution */
    geo_dims_t dims;
} geo_latlon_grid_t;

/* ---- Utilities ---- */

double geo_deg2rad(double deg);
double geo_rad2deg(double rad);

double geo_normalize_lon(double lon);
double geo_clamp_lat(double lat);

/* ---- Grid math ---- */

geo_coord_t geo_latlon_at(
    const geo_latlon_grid_t *grid,
    uint32_t i,
    uint32_t j
);

int geo_latlon_to_index(
    const geo_latlon_grid_t *grid,
    double lon,
    double lat,
    uint32_t *i,
    uint32_t *j
);

/* ---- Distance / metrics ---- */

double geo_haversine(
    double lat1,
    double lon1,
    double lat2,
    double lon2
);

#ifdef __cplusplus
}
#endif

#endif
