#include "allocator.h"

#ifndef DP_HEAP_SIZE
#define DP_HEAP_SIZE (256 * 1024 * 1024)
#endif

static uint8_t dp_heap[DP_HEAP_SIZE];
static uint32_t dp_heap_ptr = 0;

void dp_reset(void) {
  dp_heap_ptr = 0;
}

void* dp_alloc(uint32_t size) {
  size = (size + 7) & ~7;
  if (dp_heap_ptr + size > DP_HEAP_SIZE)
    return 0;

  void* p = dp_heap + dp_heap_ptr;
  dp_heap_ptr += size;
  return p;
}
