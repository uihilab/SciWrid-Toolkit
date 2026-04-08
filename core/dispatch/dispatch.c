#include "dispatch.h"
#include "../errors.h"
#include "../grid/grid.h"
#include "../query/query.h"
#include "../engine/format_parser.h"

int dp_parse(
  uint8_t* data,
  uint32_t data_len,
  const dp_query_t* query,
  dp_result_t* result
) {
  if (!data || !query || !result)
    return DP_ERR_NULL;

  /* Get format parser by ID */
  const dp_format_source_t* source = dp_format_source_by_id(query->format);
  if (!source)
    return DP_ERR_UNSUPPORTED;

  /* Parse data into grid */
  dp_grid_t grid;
  int err = source->parse(data, data_len, &grid);
  if (err != DP_OK)
    return err;

  /* Execute query on the grid */
  return dp_query_execute(&grid, query, result);
}
