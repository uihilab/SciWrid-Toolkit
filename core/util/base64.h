#ifndef DP_BASE64_H
#define DP_BASE64_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * base64_encode_len - return the number of bytes needed for the output buffer,
 * including the null terminator.
 */
size_t base64_encode_len(size_t src_len);

/*
 * base64_encode - encode src_len bytes from src into out.
 * out must be at least base64_encode_len(src_len) bytes.
 * The output is null-terminated.
 */
void base64_encode(const uint8_t* src, size_t src_len, char* out);

/*
 * base64_decode_len - upper bound of decoded bytes for a base64 string
 * of length src_len (not including null terminator).
 */
size_t base64_decode_len(size_t src_len);

/*
 * base64_decode - decode a null-terminated base64 string into out.
 * out must be at least base64_decode_len(strlen(src)) bytes.
 * Returns the number of bytes written.
 */
size_t base64_decode(const char* src, uint8_t* out);

#ifdef __cplusplus
}
#endif

#endif /* DP_BASE64_H */
