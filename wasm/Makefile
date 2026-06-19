# wasm/Makefile  --  Build WASM bundle for browser
#
# Prerequisites: Emscripten (emcc) installed and activated
#
# Usage:
#   make            build sciwrid.js + sciwrid.wasm
#   make clean      remove build artifacts

EMCC ?= emcc
SRCS = wasm_api.c \
       ../tools/query_refs.c \
       ../core/util/base64.c \
       ../helper/grib2converthelpers.c \
       ../formats/grib2/grib2_metadata.c \
       ../formats/netcdf/netcdf3.c

OUT = sciwrid.js

CFLAGS = -O2 -std=c99 -I..

EMFLAGS = \
  -sEXPORTED_RUNTIME_METHODS="['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8']" \
  -sEXPORTED_FUNCTIONS="['_wp_scan','_wp_scan_get_vars_json','_wp_scan_free','_wp_normalize','_wp_nc3_scan','_wp_nc3_scan_get_vars_json','_wp_nc3_normalize','_wp_nc3_scan_free','_wp_open_from_float_arrays','_wp_close','_wp_nx','_wp_ny','_wp_nt','_wp_find_nearest_lat','_wp_find_nearest_lon','_wp_query','_wp_free','_wp_malloc','_wp_memcpy','_malloc','_free']" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=SciWridToolkit \
  -sENVIRONMENT=web,worker,node \
  -sNO_EXIT_RUNTIME=1

.PHONY: all clean

all: $(OUT)

$(OUT): $(SRCS)
	$(EMCC) $(CFLAGS) $(EMFLAGS) -o $@ $^ -lm

clean:
	-rm -f sciwrid.js sciwrid.wasm
