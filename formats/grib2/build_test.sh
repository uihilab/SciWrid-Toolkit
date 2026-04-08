#!/bin/bash
# Compilation script for test_grib2

# Source files
CORE_SRC="
  core/engine/engine.c
  core/engine/format_parser.c
  core/engine/formats_init.c
  core/dispatch/dispatch.c
  core/query/query.c
  core/memory/allocator.c
  core/cursor/cursor.c
  core/math/geo.c
  core/errors/errors.c
"

FORMAT_SRC="
  formats/grib2/grib2.c
  formats/grib2/grib2_metadata.c
"

TEST_SRC="formats/grib2/test_grib2.c"

# Include directories
INCLUDES="-I. -Icore -Iformats"

# Compile
gcc -Wall -Wextra -std=c99 -O2 \
  $INCLUDES \
  $CORE_SRC \
  $FORMAT_SRC \
  $TEST_SRC \
  -lm \
  -o test_grib2.exe

if [ $? -eq 0 ]; then
  echo "✓ Compilation successful: test_grib2.exe"
else
  echo "✗ Compilation failed"
  exit 1
fi

