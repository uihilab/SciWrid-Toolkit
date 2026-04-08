#ifndef DP_GRID_POINT_H
#define DP_GRID_POINT_H

#include <stdint.h>

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

#endif

