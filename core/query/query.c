#include "query.h"
#include "../math/geo.h"
#include "../memory/allocator.h"
#include "../errors.h"

/* ---- internal helpers ---- */

static int latlon_to_index(
  const dp_grid_t* g,
  double lat,
  double lon,
  int* ix,
  int* iy
) {
  if (g->type != DP_GRID_TYPE_REGULAR)
    return 0; /* Only works for regular grids */
  
  lon = geo_normalize_lon(lon);

  double fx = (lon - g->u.regular.lon0) / g->u.regular.dlon;
  double fy = (lat - g->u.regular.lat0) / g->u.regular.dlat;

  *ix = (int)fx;
  *iy = (int)fy;

  return dp_grid_in_bounds(g, *ix, *iy);
}

/* ---- POINT query ---- */

static int query_point_regular(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  int i, j;
  if (!latlon_to_index(g, q->lat, q->lon, &i, &j)) {
    r->found = 0;
    return DP_OK;
  }

  uint32_t idx = dp_grid_index(g, i, j);

  r->found = 1;
  r->value = g->u.regular.data[idx];
  r->count = 1;
  r->data_ptr = 0;

  return DP_OK;
}

static int query_point_points(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  /* Find nearest point using distance calculation */
  if (g->type != DP_GRID_TYPE_POINTS || !g->u.points.points)
    return DP_ERR_FORMAT;
  
  double min_dist = 1e10;
  uint32_t nearest_idx = 0;
  int found = 0;
  
  for (uint32_t i = 0; i < g->u.points.num_points; i++) {
    double dist = geo_haversine(
      q->lat, q->lon,
      g->u.points.points[i].lat,
      g->u.points.points[i].lon
    );
    
    if (dist < min_dist) {
      min_dist = dist;
      nearest_idx = i;
      found = 1;
    }
  }
  
  if (found) {
    r->found = 1;
    r->value = g->u.points.points[nearest_idx].value;
    r->count = 1;
    r->data_ptr = 0;
    return DP_OK;
  }
  
  r->found = 0;
  return DP_OK;
}

static int query_point(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  if (g->type == DP_GRID_TYPE_REGULAR) {
    return query_point_regular(g, q, r);
  } else if (g->type == DP_GRID_TYPE_POINTS) {
    return query_point_points(g, q, r);
  }
  
  r->found = 0;
  return DP_ERR_FORMAT;
}

/* ---- BBOX query ---- */

static int query_bbox_regular(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  int i0, j0, i1, j1;

  if (!latlon_to_index(g, q->lat_min, q->lon_min, &i0, &j0))
    return DP_ERR_RANGE;

  if (!latlon_to_index(g, q->lat_max, q->lon_max, &i1, &j1))
    return DP_ERR_RANGE;

  if (i0 > i1) { int t = i0; i0 = i1; i1 = t; }
  if (j0 > j1) { int t = j0; j0 = j1; j1 = t; }

  uint32_t nx = (uint32_t)(i1 - i0 + 1);
  uint32_t ny = (uint32_t)(j1 - j0 + 1);
  uint32_t count = nx * ny;

  float* out = (float*)dp_alloc(count * sizeof(float));
  if (!out)
    return DP_ERR_MEM;

  uint32_t k = 0;
  for (int j = j0; j <= j1; j++) {
    for (int i = i0; i <= i1; i++) {
      out[k++] = g->u.regular.data[dp_grid_index(g, i, j)];
    }
  }

  r->found = 1;
  r->count = count;
  r->data_ptr = (uint32_t)((uintptr_t)out);
  r->value = 0.0f;

  return DP_OK;
}

static int query_bbox_points(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  /* Find all points within bounding box */
  if (g->type != DP_GRID_TYPE_POINTS || !g->u.points.points)
    return DP_ERR_FORMAT;
  
  /* Normalize longitude bounds */
  double lon_min = geo_normalize_lon(q->lon_min);
  double lon_max = geo_normalize_lon(q->lon_max);
  
  /* Count points in bbox */
  uint32_t count = 0;
  for (uint32_t i = 0; i < g->u.points.num_points; i++) {
    double lat = g->u.points.points[i].lat;
    double lon = geo_normalize_lon(g->u.points.points[i].lon);
    
    if (lat >= q->lat_min && lat <= q->lat_max) {
      /* Handle longitude wrap-around */
      if (lon_min <= lon_max) {
        if (lon >= lon_min && lon <= lon_max) count++;
      } else {
        /* Crosses 180/-180 boundary */
        if (lon >= lon_min || lon <= lon_max) count++;
      }
    }
  }
  
  if (count == 0) {
    r->found = 0;
    return DP_OK;
  }
  
  /* Allocate and fill result array */
  float* out = (float*)dp_alloc(count * sizeof(float));
  if (!out)
    return DP_ERR_MEM;
  
  uint32_t k = 0;
  for (uint32_t i = 0; i < g->u.points.num_points; i++) {
    double lat = g->u.points.points[i].lat;
    double lon = geo_normalize_lon(g->u.points.points[i].lon);
    
    if (lat >= q->lat_min && lat <= q->lat_max) {
      if (lon_min <= lon_max) {
        if (lon >= lon_min && lon <= lon_max)
          out[k++] = g->u.points.points[i].value;
      } else {
        if (lon >= lon_min || lon <= lon_max)
          out[k++] = g->u.points.points[i].value;
      }
    }
  }
  
  r->found = 1;
  r->count = count;
  r->data_ptr = (uint32_t)((uintptr_t)out);
  r->value = 0.0f;
  
  return DP_OK;
}

static int query_bbox(
  const dp_grid_t* g,
  const dp_query_t* q,
  dp_result_t* r
) {
  if (g->type == DP_GRID_TYPE_REGULAR) {
    return query_bbox_regular(g, q, r);
  } else if (g->type == DP_GRID_TYPE_POINTS) {
    return query_bbox_points(g, q, r);
  }
  
  r->found = 0;
  return DP_ERR_FORMAT;
}

/* ---- public API ---- */

int dp_query_execute(
  const dp_grid_t* grid,
  const dp_query_t* query,
  dp_result_t* result
) {
  if (!grid || !query || !result)
    return DP_ERR_QUERY;

  result->found = 0;
  result->count = 0;
  result->data_ptr = 0;
  result->value = 0.0f;

  switch (query->query_type) {
    case DP_QUERY_POINT:
      return query_point(grid, query, result);

    case DP_QUERY_BBOX:
      return query_bbox(grid, query, result);

    default:
      return DP_ERR_QUERY;
  }
}
