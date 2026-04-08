#include "geo.h"
#define _USE_MATH_DEFINES
#include <math.h>

double geo_deg2rad(double deg) {
    return deg * M_PI / 180.0;
}

double geo_rad2deg(double rad) {
    return rad * 180.0 / M_PI;
}

double geo_normalize_lon(double lon) {
    while (lon < -180.0) lon += 360.0;
    while (lon > 180.0)  lon -= 360.0;
    return lon;
}

double geo_clamp_lat(double lat) {
    if (lat > 90.0)  return 90.0;
    if (lat < -90.0) return -90.0;
    return lat;
}

geo_coord_t geo_latlon_at(
    const geo_latlon_grid_t *grid,
    uint32_t i,
    uint32_t j
) {
    geo_coord_t c;

    c.lon = grid->lon0 + i * grid->dlon;
    c.lat = grid->lat0 + j * grid->dlat;

    c.lon = geo_normalize_lon(c.lon);
    c.lat = geo_clamp_lat(c.lat);

    return c;
}

int geo_latlon_to_index(
    const geo_latlon_grid_t *grid,
    double lon,
    double lat,
    uint32_t *i,
    uint32_t *j
) {
    lon = geo_normalize_lon(lon);

    if (lat < grid->lat0 ||
        lat > grid->lat0 + grid->dlat * (grid->dims.ny - 1)) {
        return -1;
    }

    double fi = (lon - grid->lon0) / grid->dlon;
    double fj = (lat - grid->lat0) / grid->dlat;

    if (fi < 0 || fj < 0) return -1;

    *i = (uint32_t)fi;
    *j = (uint32_t)fj;

    if (*i >= grid->dims.nx || *j >= grid->dims.ny) {
        return -1;
    }

    return 0;
}

double geo_haversine(
    double lat1,
    double lon1,
    double lat2,
    double lon2
) {
    double dlat = geo_deg2rad(lat2 - lat1);
    double dlon = geo_deg2rad(lon2 - lon1);

    lat1 = geo_deg2rad(lat1);
    lat2 = geo_deg2rad(lat2);

    double a = sin(dlat / 2) * sin(dlat / 2) +
               cos(lat1) * cos(lat2) *
               sin(dlon / 2) * sin(dlon / 2);

    double c = 2 * atan2(sqrt(a), sqrt(1 - a));
    return GEO_EARTH_RADIUS_M * c;
}
