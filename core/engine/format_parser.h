#ifndef DP_FORMAT_PARSER_H
#define DP_FORMAT_PARSER_H

#include "../grid/grid.h"
#include "../errors.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Parser callback.
 * Returns DP_OK or DP_ERR_xxx.
 */
typedef int (*dp_format_parse_fn)(
  const uint8_t* data,
  uint32_t len,
  dp_grid_t* grid
);

/**
 * Format source descriptor.
 * NOTE: name and function pointers must be static lifetime.
 */
typedef struct {
  const char* name;          /* unique name, lowercase preferred */
  uint32_t    format_id;     /* ABI stable numeric ID */
  dp_format_parse_fn parse;  /* decode entry point */
} dp_format_source_t;

int dp_format_register(const dp_format_source_t* source);
const dp_format_source_t* dp_format_source_by_name(const char* name);
const dp_format_source_t* dp_format_source_by_id(uint32_t format_id);

#ifdef __cplusplus
}
#endif

#endif
