#include "format_parser.h"
#include <string.h>

#define DP_MAX_FORMATS 16

static dp_format_source_t dp_formats[DP_MAX_FORMATS];
static int dp_format_count = 0;

int dp_format_register(const dp_format_source_t* source)
{
  if (!source || !source->name || !source->parse)
    return DP_ERR_NULL;

  if (dp_format_count >= DP_MAX_FORMATS)
    return DP_ERR_MEM;

  for (int i = 0; i < dp_format_count; i++) {
    if (strcmp(dp_formats[i].name, source->name) == 0 ||
        dp_formats[i].format_id == source->format_id)
      return DP_ERR_FORMAT;
  }

  dp_formats[dp_format_count] = *source;
  dp_format_count++;

  return DP_OK;
}

const dp_format_source_t*
dp_format_source_by_name(const char* name)
{
  if (!name) return NULL;

  for (int i = 0; i < dp_format_count; i++) {
    if (strcmp(dp_formats[i].name, name) == 0)
      return &dp_formats[i];
  }

  return NULL;
}

const dp_format_source_t*
dp_format_source_by_id(uint32_t format_id)
{
  for (int i = 0; i < dp_format_count; i++) {
    if (dp_formats[i].format_id == format_id)
      return &dp_formats[i];
  }

  return NULL;
}
