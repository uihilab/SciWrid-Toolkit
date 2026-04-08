#include "formats_init.h"
#include "format_parser.h"
#include "../../core/abi/abi.h"
#include "../../formats/raw/raw.h"
#include "../../formats/grib2/grib2.h"
#include "../../formats/hdf5/hdf5.h"
#include "../../formats/netcdf/netcdf.h"

static int register_format(const char* name,
                           uint32_t id,
                           dp_format_parse_fn fn)
{
  dp_format_source_t s;
  s.name = name;
  s.format_id = id;
  s.parse = fn;

  return dp_format_register(&s);
}

int dp_formats_init(void)
{
  int r;

  if ((r = register_format("raw",    DP_FORMAT_RAW,    dp_decode_raw)) != DP_OK)
    return r;

  if ((r = register_format("grib2",  DP_FORMAT_GRIB2,  dp_decode_grib2_metadata)) != DP_OK)
    return r;

  if ((r = register_format("hdf5",   DP_FORMAT_HDF5,   dp_decode_hdf5)) != DP_OK)
    return r;

  if ((r = register_format("netcdf", DP_FORMAT_NETCDF, dp_decode_netcdf)) != DP_OK)
    return r;

  return DP_OK;
}
