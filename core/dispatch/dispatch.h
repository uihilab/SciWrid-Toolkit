#ifndef DP_DISPATCH_H
#define DP_DISPATCH_H

#include <stdint.h>
#include "../abi/abi.h"

/* ABI entry point (eventually exported to WASM) */
int dp_parse(
  uint8_t* data,
  uint32_t data_len,
  const dp_query_t* query,
  dp_result_t* result
);

#endif
