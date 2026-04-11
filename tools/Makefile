# tools/Makefile  --  Build the offline normalizer (native only, never WASM)
#
# Usage:
#   make              build normalize_refs
#   make clean        remove build artifacts
#
# Requirements: GCC, standard C99, libm (-lm)

CC      = gcc
CFLAGS  = -O2 -Wall -Wextra -std=c99 -I..
LDFLAGS = -lm

SRCS   = normalize_refs.c \
         ../helper/grib2converthelpers.c \
         ../core/util/base64.c \
         ../formats/grib2/grib2_metadata.c

TARGET  = normalize_refs.exe
EXAMPLE = ../examples/gfs.t06z.pgrb2.1p00.anl.grb2
DATADIR = ../data/

.PHONY: all clean data

all: $(TARGET) data

$(TARGET): $(SRCS)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

# Auto-normalize all recognized variables from the example file.
# Re-runs only if the binary or the source GRIB2 changes.
data: $(TARGET) $(EXAMPLE)
	@mkdir -p $(DATADIR)
	@echo ""
	@echo "==> Normalizing $(EXAMPLE) -> $(DATADIR)"
	./$(TARGET) $(EXAMPLE) $(DATADIR)

clean:
	-rm -f $(TARGET)
	-rm -f $(DATADIR)*.refs.json $(DATADIR)*.bin
