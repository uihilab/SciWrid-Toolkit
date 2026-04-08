#ifndef DP_GRID_H
#define DP_GRID_H

#include <stdint.h>

/* Grid type enumeration */
typedef enum {
  DP_GRID_TYPE_REGULAR = 0,    /* Regular lat/lon grid */
  DP_GRID_TYPE_POINTS = 1      /* Point-based grid (icosahedral, unstructured) */
} dp_grid_type_t;

/* Regular lat/lon grid */
typedef struct {
  uint32_t nx;
  uint32_t ny;

  double lon0;   /* origin longitude */
  double lat0;   /* origin latitude */
  double dlon;   /* step in longitude */
  double dlat;   /* step in latitude */

  float* data;   /* nx * ny values, row-major */
} dp_grid_regular_t;

/* Point-based grid (for icosahedral, unstructured, etc.) */
typedef struct {
  double lat;
  double lon;
  float value;
} dp_grid_point_t;

/* Point-based grid structure */
typedef struct {
  uint32_t num_points;
  dp_grid_point_t* points;  /* Array of points with coordinates and values */
} dp_grid_points_t;

/* Unified grid structure */
typedef struct {
  dp_grid_type_t type;
  union {
    dp_grid_regular_t regular;
    dp_grid_points_t points;
  } u;
} dp_grid_t;

/* ---- helpers ---- */

static inline uint32_t dp_grid_size(const dp_grid_t* g) {
  if (g->type == DP_GRID_TYPE_REGULAR) {
    return g->u.regular.nx * g->u.regular.ny;
  } else if (g->type == DP_GRID_TYPE_POINTS) {
    return g->u.points.num_points;
  }
  return 0;
}

static inline uint32_t dp_grid_index(
  const dp_grid_t* g,
  uint32_t i,
  uint32_t j
) {
  if (g->type == DP_GRID_TYPE_REGULAR) {
    return j * g->u.regular.nx + i;
  }
  return 0; /* Not applicable for point-based grids */
}

static inline int dp_grid_in_bounds(
  const dp_grid_t* g,
  int i,
  int j
) {
  if (g->type == DP_GRID_TYPE_REGULAR) {
    return (i >= 0 && j >= 0 &&
            (uint32_t)i < g->u.regular.nx &&
            (uint32_t)j < g->u.regular.ny);
  }
  return 0; /* Point-based grids use different indexing */
}

#endif
