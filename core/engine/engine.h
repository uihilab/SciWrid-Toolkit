#ifndef DP_ENGINE_H
#define DP_ENGINE_H

#include "../grid/grid.h"
#include "../query/query.h"
#include "../abi/abi.h"
#include "../errors.h"
#include "format_parser.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initialize engine runtime
int dp_engine_init(void);

// Shutdown engine
int dp_engine_shutdown(void);

// Set an already created grid (engine takes ownership)
int dp_engine_set_grid(dp_grid_t* grid);

// Load a buffer from any format using the namespaced format sources
int dp_engine_load_buffer(const uint8_t* data, uint32_t size, const char* format_name);

// Execute a query on the current grid
int dp_engine_query(const dp_query_t* query, dp_result_t* result);

#ifdef __cplusplus
}
#endif

#endif // DP_ENGINE_H
