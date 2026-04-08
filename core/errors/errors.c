#include "errors.h"

const char* dp_strerror(int code)
{
  switch (code)
  {
    case DP_OK:          return "OK";

    case DP_ERR_NULL:    return "Null pointer";
    case DP_ERR_QUERY:   return "Invalid or unsupported query";
    case DP_ERR_FORMAT:  return "Unsupported or invalid format";
    case DP_ERR_RANGE:   return "Requested range outside grid";
    case DP_ERR_MEM:     return "Out of memory";
    case DP_ERR_STATE:   return "Invalid engine state";

    case DP_ERR_IO:      return "I/O failure";
    case DP_ERR_DATA:    return "Corrupt or invalid data";
    case DP_ERR_EOF:     return "End of file / data exhausted";
    case DP_ERR_UNSUPPORTED: return "Unsupported feature / operation";
    case DP_ERR_NOTFOUND: return "Resource not found";

    default:
      return "Unknown error";
  }
}
