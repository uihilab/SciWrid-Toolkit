#include "base64.h"

static const char B64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t base64_encode_len(size_t src_len) {
    return ((src_len + 2) / 3) * 4 + 1; /* +1 for null terminator */
}

void base64_encode(const uint8_t* src, size_t src_len, char* out) {
    size_t i = 0, j = 0;

    while (i < src_len) {
        uint32_t a = (i < src_len) ? src[i++] : 0;
        uint32_t b = (i < src_len) ? src[i++] : 0;
        uint32_t c = (i < src_len) ? src[i++] : 0;
        uint32_t triple = (a << 16) | (b << 8) | c;

        out[j++] = B64[(triple >> 18) & 0x3F];
        out[j++] = B64[(triple >> 12) & 0x3F];
        out[j++] = B64[(triple >>  6) & 0x3F];
        out[j++] = B64[(triple      ) & 0x3F];
    }

    /* Padding */
    if (src_len % 3 == 1) { out[j - 2] = '='; out[j - 1] = '='; }
    if (src_len % 3 == 2) { out[j - 1] = '='; }

    out[j] = '\0';
}
