#ifndef DP_HDF5_FORMAT_H
#define DP_HDF5_FORMAT_H

#include "../../core/grid/grid.h"
#include <stdint.h>

int dp_decode_hdf5(const uint8_t* data, uint32_t len, dp_grid_t* g);

#endif

