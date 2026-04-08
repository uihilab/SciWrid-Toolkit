#include "netcdf.h"
#include "../../core/grid/grid.h"
#include "../../core/cursor/cursor.h"
#include "../../core/errors.h"

int dp_decode_netcdf(
  const uint8_t* data,
  uint32_t len,
  dp_grid_t* g
) {
  if (!data || !g)
    return DP_ERR_NULL;

  /* TODO: Implement NetCDF parsing */
  return DP_ERR_UNSUPPORTED;
}

