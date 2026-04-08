#include "engine.h"
#include "../memory/allocator.h"
#include <string.h>
#include <stdlib.h>

static dp_grid_t* active_grid = NULL;
static int engine_initialized = 0;

// Free currently loaded grid
static void engine_free_grid(void) {
    if (!active_grid) return;
    /* Grid data is either:
     * 1. Pointing into the original buffer (no free needed)
     * 2. Allocated via dp_alloc (freed by dp_reset)
     */
    active_grid = NULL;
}

// Engine initialization
int dp_engine_init(void) {
    if (engine_initialized) return DP_ERR_STATE;
    dp_reset();          // reset bump allocator
    active_grid = NULL;
    engine_initialized = 1;
    return DP_OK;
}

// Engine shutdown
int dp_engine_shutdown(void) {
    if (!engine_initialized) return DP_ERR_STATE;
    engine_free_grid();
    dp_reset();          // free bump allocator memory
    engine_initialized = 0;
    return DP_OK;
}

// Set an existing grid (takes ownership)
int dp_engine_set_grid(dp_grid_t* grid) {
    if (!engine_initialized) return DP_ERR_STATE;
    if (!grid) return DP_ERR_NULL;

    engine_free_grid();
    dp_reset();          // clear heap for new grid memory
    active_grid = grid;

    return DP_OK;
}

// Load buffer via a format source
int dp_engine_load_buffer(const uint8_t* data, uint32_t size, const char* format_name) {
    if (!engine_initialized) return DP_ERR_STATE;
    if (!data || size == 0 || !format_name) return DP_ERR_NULL;

    const dp_format_source_t* source = dp_format_source_by_name(format_name);
    if (!source) return DP_ERR_FORMAT;

    engine_free_grid();
    dp_reset();  // clear heap for new grid memory

    /* Allocate grid structure */
    dp_grid_t* grid = (dp_grid_t*)dp_alloc(sizeof(dp_grid_t));
    if (!grid) return DP_ERR_MEM;

    int err = source->parse(data, size, grid);
    if (err != DP_OK) {
        return err;
    }

    active_grid = grid;
    return DP_OK;
}

// Execute query
int dp_engine_query(const dp_query_t* query, dp_result_t* result) {
    if (!engine_initialized) return DP_ERR_STATE;
    if (!active_grid || !query || !result) return DP_ERR_NULL;

    memset(result, 0, sizeof(dp_result_t));

    return dp_query_execute(active_grid, query, result);
}
