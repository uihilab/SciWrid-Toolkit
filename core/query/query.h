#ifndef DP_QUERY_H
#define DP_QUERY_H

#include <stdint.h>
#include "../grid/grid.h"
#include "../abi/abi.h"

/* Execute a spatial query on a grid */
int dp_query_execute(
  const dp_grid_t* grid,
  const dp_query_t* query,
  dp_result_t* result
);

#endif
