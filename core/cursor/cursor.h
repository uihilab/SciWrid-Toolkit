#ifndef DP_CURSOR_H
#define DP_CURSOR_H

#include <stdint.h>

/* Cursor over a read-only buffer */
typedef struct {
  const uint8_t* buf;
  uint32_t size;
  uint32_t pos;     /* byte position */
  uint32_t bitpos;  /* bit position from start */
} dp_cursor_t;

/* ---- lifecycle ---- */

static inline void dp_cursor_init(
  dp_cursor_t* c,
  const uint8_t* buf,
  uint32_t size
) {
  c->buf = buf;
  c->size = size;
  c->pos = 0;
  c->bitpos = 0;
}

/* ---- positioning ---- */

int dp_cursor_seek(dp_cursor_t* c, uint32_t pos);
int dp_cursor_skip(dp_cursor_t* c, uint32_t n);
int dp_cursor_align(dp_cursor_t* c, uint32_t align);

/* ---- byte reads (big endian) ---- */

int dp_read_u8 (dp_cursor_t* c, uint8_t*  out);
int dp_read_u16(dp_cursor_t* c, uint16_t* out);
int dp_read_u32(dp_cursor_t* c, uint32_t* out);
int dp_read_u64(dp_cursor_t* c, uint64_t* out);

/* ---- raw access ---- */

int dp_read_bytes(
  dp_cursor_t* c,
  uint8_t* dst,
  uint32_t len
);

/* ---- bit reads (GRIB-style) ---- */

int dp_read_bits(
  dp_cursor_t* c,
  uint8_t nbits,
  uint32_t* out
);

#endif
