# tools/Makefile  --  Build offline tools (native only, never WASM)
#
# Usage:
#   make              build all tools + normalize example data
#   make query        build interactive query CLI
#   make clean        remove build artifacts
#
# Requirements: GCC, standard C99, libm (-lm)

CC      = gcc
CFLAGS  = -O2 -Wall -Wextra -std=c99 -I..
LDFLAGS = -lm

# --- normalize_refs ---
NORM_SRCS = normalize_refs.c \
            ../helper/grib2converthelpers.c \
            ../core/util/base64.c \
            ../formats/grib2/grib2_metadata.c
NORM_TARGET = normalize_refs.exe

# --- query (interactive CLI) ---
QUERY_SRCS = main.c \
             query_refs.c \
             ../core/util/base64.c
QUERY_TARGET = query.exe

EXAMPLE = ../examples/timeseries/gfs_timeseries.grb2
DATADIR = ../data/

.PHONY: all clean data query

all: $(NORM_TARGET) $(QUERY_TARGET) data

$(NORM_TARGET): $(NORM_SRCS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

$(QUERY_TARGET): $(QUERY_SRCS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

query: $(QUERY_TARGET)

# Auto-normalize all recognized variables from the example file.
data: $(NORM_TARGET) $(EXAMPLE)
	@mkdir -p $(DATADIR)
	@echo ""
	@echo "==> Normalizing $(EXAMPLE) -> $(DATADIR)"
	./$(NORM_TARGET) $(EXAMPLE) $(DATADIR)

clean:
	-rm -f $(NORM_TARGET) $(QUERY_TARGET)
	-rm -f $(DATADIR)*.refs.json $(DATADIR)*.bin $(DATADIR)*.json $(DATADIR)*_query.json
	-rm -f *.exe
