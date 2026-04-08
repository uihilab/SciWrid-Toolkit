#ifndef DP_ERRORS_H
#define DP_ERRORS_H

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Standard return codes ---- */
#define DP_OK              0    /* success */

/* General / parameter */
#define DP_ERR_NULL       -1
#define DP_ERR_QUERY      -2
#define DP_ERR_FORMAT     -3
#define DP_ERR_RANGE      -4
#define DP_ERR_MEM        -5
#define DP_ERR_STATE      -6

/* IO / data */
#define DP_ERR_IO         -10
#define DP_ERR_DATA       -11
#define DP_ERR_EOF        -12
#define DP_ERR_UNSUPPORTED -13
#define DP_ERR_NOTFOUND   -14

/**
 * Convert error code to human readable message.
 * Returned pointer is static, do NOT free.
 */
const char* dp_strerror(int code);

#ifdef __cplusplus
}
#endif

#endif /* DP_ERRORS_H */
