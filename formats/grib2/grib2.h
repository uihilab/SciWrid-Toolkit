#ifndef GRIB2_H
#define GRIB2_H

#include <stdint.h>
#include "../../core/grid/grid.h"
#include "grib2_metadata.h"

int dp_decode_grib2(
  const uint8_t* data,
  uint32_t len,
  dp_grid_t* g
);

/* Metadata-only parser (reads headers only, no data allocation) */
int dp_decode_grib2_metadata(
  const uint8_t* data,
  uint32_t len,
  dp_grid_t* g
);

typedef struct {
  /* byte offsets into the original buffer */
  uint64_t sec1_offset;
  uint64_t sec3_offset;
  uint64_t sec4_offset;
  uint64_t sec5_offset;
  uint64_t sec6_offset;
  uint64_t sec7_offset;

  /* dimensions (from section 3) */
  uint32_t nx;
  uint32_t ny;

  /* identification */
  uint16_t param_category;
  uint16_t param_number;

  /* representation */
  uint16_t grid_template;
  uint16_t data_template;

  /* book keeping */
  uint64_t message_start;
  uint64_t message_end;
} grib2_field_descriptor_t;

int grib2_index(
  const uint8_t* data,
  uint32_t len,
  grib2_field_descriptor_t* out,
  uint32_t max_fields,
  uint32_t* found_fields
);

/* Get metadata from last parsed GRIB2 file */
grib2_metadata_t* grib2_get_metadata(void);

#endif

