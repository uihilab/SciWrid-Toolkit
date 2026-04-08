#ifndef GRIB2_METADATA_H
#define GRIB2_METADATA_H

#include <stdint.h>

/* GRIB2 metadata structure */
typedef struct {
  /* Section 1: Identification */
  uint16_t centre;           /* Originating centre */
  uint16_t subcentre;       /* Originating sub-centre */
  uint8_t  tables_version;  /* GRIB master tables version */
  uint8_t  local_version;   /* Version number of local tables */
  uint8_t  significance;   /* Significance of reference time */
  uint16_t year;            /* Year */
  uint8_t  month;          /* Month */
  uint8_t  day;             /* Day */
  uint8_t  hour;            /* Hour */
  uint8_t  minute;          /* Minute */
  uint8_t  second;          /* Second */
  uint8_t  production_status; /* Production status */
  uint8_t  data_type;       /* Type of data */
  
  /* Section 4: Product Definition */
  uint16_t parameter_category;  /* Parameter category */
  uint16_t parameter_number;     /* Parameter number */
  uint8_t  type_of_generating_process; /* Type of generating process */
  uint8_t  background_process;   /* Background generating process identifier */
  uint8_t  generating_process;   /* Generating process identifier */
  uint16_t hours_after_reftime;  /* Hours after reference time (2 bytes) */
  uint8_t  minutes_after_reftime; /* Minutes after reference time */
  uint8_t  indicator_of_unit;    /* Indicator of unit of time range */
  uint32_t forecast_time;        /* Forecast time in units specified */
  
  /* Data representation (from Section 5) */
  uint8_t  data_rep_template;    /* Data representation template number */
  uint8_t  packing_type;         /* Type of packing */
  
  /* Computed fields */
  char variable_name[64];        /* Human-readable variable name */
  double valid_time;             /* Valid time as Unix timestamp (if computable) */
} grib2_metadata_t;

/* Get human-readable variable name from parameter category/number */
const char* grib2_get_variable_name(uint16_t category, uint16_t number);

#endif

