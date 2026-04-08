#ifndef DP_ALLOCATOR_H
#define DP_ALLOCATOR_H

#include <stdint.h>

void* dp_alloc(uint32_t size);
void  dp_reset(void);

#endif
