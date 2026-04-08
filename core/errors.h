#ifndef DP_ERRORS_H
#define DP_ERRORS_H

#ifdef __cplusplus
extern "C" {
#endif

/* Success */
#define DP_OK 0

/* General / parameter errors */
#define DP_ERR_NULL        -1    /* null pointer */
#define DP_ERR_QUERY       -2    /* malformed / unsupported query */
#define DP_ERR_FORMAT      -3    /* unsupported or invalid format */
#define DP_ERR_RANGE       -4    /* coordinates / bounds outside grid */
#define DP_ERR_MEM         -5    /* allocation failure */
#define DP_ERR_STATE       -6    /* invalid engine state / not initialized */

/* IO / data errors */
#define DP_ERR_IO          -10   /* IO read/write fail */
#define DP_ERR_DATA        -11   /* corrupt / inconsistent data */
#define DP_ERR_EOF         -12   /* end of file / data */
#define DP_ERR_UNSUPPORTED -13   /* unsupported operation */
#define DP_ERR_NOTFOUND    -14   /* resource not found */

/**
 * Convert error code to human readable message.
 * Returned pointer is static, do NOT free.
 */
const char* dp_strerror(int code);

#ifdef __cplusplus
}
#endif

#endif//properties is an object with the properties of the function