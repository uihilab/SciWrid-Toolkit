#include "cursor.h"
#include "../util/endian.h"
#include "../util/bits.h"
#include "../errors.h"

/* ---- positioning ---- */

int dp_cursor_seek(dp_cursor_t* c, uint32_t pos) {
  if (pos > c->size)
    return DP_ERR_EOF;
  c->pos = pos;
  c->bitpos = pos << 3;
  return DP_OK;
}

int dp_cursor_skip(dp_cursor_t* c, uint32_t n) {
  return dp_cursor_seek(c, c->pos + n);
}

int dp_cursor_align(dp_cursor_t* c, uint32_t align) {
  uint32_t p = (c->pos + align - 1) & ~(align - 1);
  return dp_cursor_seek(c, p);
}

/* ---- byte reads ---- */

int dp_read_u8(dp_cursor_t* c, uint8_t* out) {
  if (c->pos + 1 > c->size)
    return DP_ERR_EOF;
  *out = c->buf[c->pos++];
  c->bitpos = c->pos << 3;
  return DP_OK;
}

int dp_read_u16(dp_cursor_t* c, uint16_t* out) {
  if (c->pos + 2 > c->size)
    return DP_ERR_EOF;
  *out = dp_u16(c->buf + c->pos);
  c->pos += 2;
  c->bitpos = c->pos << 3;
  return DP_OK;
}

int dp_read_u32(dp_cursor_t* c, uint32_t* out) {
  if (c->pos + 4 > c->size)
    return DP_ERR_EOF;
  *out = dp_u32(c->buf + c->pos);
  c->pos += 4;
  c->bitpos = c->pos << 3;
  return DP_OK;
}

int dp_read_u64(dp_cursor_t* c, uint64_t* out) {
  if (c->pos + 8 > c->size)
    return DP_ERR_EOF;
  *out = dp_u64(c->buf + c->pos);
  c->pos += 8;
  c->bitpos = c->pos << 3;
  return DP_OK;
}

/* ---- raw bytes ---- */

int dp_read_bytes(
  dp_cursor_t* c,
  uint8_t* dst,
  uint32_t len
) {
  if (c->pos + len > c->size)
    return DP_ERR_EOF;
  for (uint32_t i = 0; i < len; i++)
    dst[i] = c->buf[c->pos + i];
  c->pos += len;
  c->bitpos = c->pos << 3;
  return DP_OK;
}

/* ---- bit reads ---- */

int dp_read_bits(
  dp_cursor_t* c,
  uint8_t nbits,
  uint32_t* out
) {
  if (c->bitpos + nbits > (c->size << 3))
    return DP_ERR_EOF;

  *out = dp_read_bits_raw(c->buf, c->bitpos, nbits);
  c->bitpos += nbits;
  c->pos = c->bitpos >> 3;
  return DP_OK;
}
