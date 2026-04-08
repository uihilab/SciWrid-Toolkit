#ifndef DP_BITS_H
#define DP_BITS_H

#include <stdint.h>

static inline uint32_t dp_read_bits_raw(
  const uint8_t* buf,
  uint32_t bitpos,
  uint8_t nbits
) {
  uint32_t v = 0;
  for (uint8_t i = 0; i < nbits; i++) {
    uint32_t byte = (bitpos + i) >> 3;
    uint8_t bit = 7 - ((bitpos + i) & 7);
    v = (v << 1) | ((buf[byte] >> bit) & 1);
  }
  return v;
}

#endif
