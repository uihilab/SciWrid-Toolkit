#ifndef DP_NETCDF_FORMAT_H
#define DP_NETCDF_FORMAT_H

#include "../../core/grid/grid.h"
#include <stdint.h>

int dp_decode_netcdf(const uint8_t* data, uint32_t len, dp_grid_t* g);

#endif

