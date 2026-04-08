#ifndef DP_ABI_H
#define DP_ABI_H

#include <stdint.h>

#define DP_FORMAT_RAW     1
#define DP_FORMAT_GRIB2   2
#define DP_FORMAT_NETCDF  3
#define DP_FORMAT_HDF5    4
#define DP_FORMAT_TIFF    5

#define DP_QUERY_POINT    1
#define DP_QUERY_BBOX     2

typedef struct {
  uint32_t format;
  uint32_t query_type;

  uint32_t var_ptr;
  uint32_t var_len;

  double lat;
  double lon;

  double lat_min;
  double lon_min;
  double lat_max;
  double lon_max;

  uint32_t flags;
} dp_query_t;

typedef struct {
  uint32_t found;

  float value;

  uint32_t count;
  uint32_t data_ptr;
} dp_result_t;

#ifdef __cplusplus
extern "C" {
#endif

// MUST be exported by every format WASM module
int dp_parse(
  uint8_t* data,
  uint32_t data_len,
  const dp_query_t* query,
  dp_result_t* result
);

// MUST be exported
void dp_reset(void);

// Optional but recommended
uint32_t dp_abi(void);

#ifdef __cplusplus
}
#endif

#endif
