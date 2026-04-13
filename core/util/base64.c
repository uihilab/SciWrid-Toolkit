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

size_t base64_decode_len(size_t src_len) {
    return (src_len / 4) * 3 + 3;
}

static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

size_t base64_decode(const char* src, uint8_t* out) {
    size_t len = 0;
    while (*src) {
        int a = b64_val(*src++); if (a < 0 || !*src) break;
        int b = b64_val(*src++); if (b < 0) break;
        out[len++] = (uint8_t)((a << 2) | (b >> 4));

        if (!*src || *src == '=') break;
        int c = b64_val(*src++); if (c < 0) break;
        out[len++] = (uint8_t)(((b & 0xF) << 4) | (c >> 2));

        if (!*src || *src == '=') break;
        int d = b64_val(*src++); if (d < 0) break;
        out[len++] = (uint8_t)(((c & 0x3) << 6) | d);
    }
    return len;
}
