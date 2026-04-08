#ifndef DP_ENDIAN_H
#define DP_ENDIAN_H

#include <stdint.h>

static inline uint16_t dp_u16(const uint8_t* p) {
  return (uint16_t)(p[0] << 8 | p[1]);
}

static inline uint32_t dp_u32(const uint8_t* p) {
  return ((uint32_t)p[0] << 24) |
         ((uint32_t)p[1] << 16) |
         ((uint32_t)p[2] << 8)  |
         p[3];
}

static inline uint64_t dp_u64(const uint8_t* p) {
  return ((uint64_t)dp_u32(p) << 32) | dp_u32(p + 4);
}

#endif
