#include "raw.h"
#include "../../core/grid/grid.h"
#include "../../core/cursor/cursor.h"
#include "../../core/errors.h"

int dp_decode_raw(
  const uint8_t* data,
  uint32_t len,
  dp_grid_t* g
) {
  if (!data || !g)
    return DP_ERR_NULL;

  dp_cursor_t c;
  dp_cursor_init(&c, data, len);

  uint32_t nx, ny;
  if (dp_read_u32(&c, &nx) != DP_OK ||
      dp_read_u32(&c, &ny) != DP_OK)
    return DP_ERR_EOF;

  if (nx == 0 || ny == 0)
    return DP_ERR_FORMAT;

  double lon0, lat0, dlon, dlat;
  uint64_t tmp;

  if (dp_read_u64(&c, &tmp) != DP_OK) return DP_ERR_EOF;
  lon0 = *(double*)&tmp;
  if (dp_read_u64(&c, &tmp) != DP_OK) return DP_ERR_EOF;
  lat0 = *(double*)&tmp;
  if (dp_read_u64(&c, &tmp) != DP_OK) return DP_ERR_EOF;
  dlon = *(double*)&tmp;
  if (dp_read_u64(&c, &tmp) != DP_OK) return DP_ERR_EOF;
  dlat = *(double*)&tmp;

  uint32_t count = nx * ny;
  uint32_t bytes = count * sizeof(float);

  if (c.pos + bytes > len)
    return DP_ERR_EOF;

  g->type = DP_GRID_TYPE_REGULAR;
  g->u.regular.nx = nx;
  g->u.regular.ny = ny;
  g->u.regular.lon0 = lon0;
  g->u.regular.lat0 = lat0;
  g->u.regular.dlon = dlon;
  g->u.regular.dlat = dlat;
  g->u.regular.data = (float*)(data + c.pos);

  return DP_OK;
}
