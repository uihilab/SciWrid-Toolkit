# Compilation Command for test_grib2

## Command

From the project root directory:

```bash
gcc -Wall -Wextra -std=c99 -O2 \
  -I. -Icore -Iformats \
  core/engine/engine.c \
  core/engine/format_parser.c \
  core/engine/formats_init.c \
  core/dispatch/dispatch.c \
  core/query/query.c \
  core/memory/allocator.c \
  core/cursor/cursor.c \
  core/math/geo.c \
  core/errors/errors.c \
  formats/grib2/grib2.c \
  formats/grib2/grib2_metadata.c \
  formats/grib2/test_grib2.c \
  -lm \
  -o test_grib2.exe
```

## PowerShell Command

```powershell
cd C:\Users\cerazoramirez\Documents\parser-web
gcc -Wall -Wextra -std=c99 -O2 -I. -Icore -Iformats `
  core\engine\engine.c `
  core\engine\format_parser.c `
  core\engine\formats_init.c `
  core\dispatch\dispatch.c `
  core\query\query.c `
  core\memory\allocator.c `
  core\cursor\cursor.c `
  core\math\geo.c `
  core\errors\errors.c `
  formats\grib2\grib2.c `
  formats\grib2\grib2_metadata.c `
  formats\grib2\test_grib2.c `
  -lm -o test_grib2.exe
```

## Current Compilation Errors

The following functions are missing and need to be implemented in `grib2.c`:

1. **`grib2_read_section_header`** - Function to read GRIB2 section header (1 byte section number + 4 bytes length)
2. **`dp_free`** - This function doesn't exist in the bump allocator. The line `dp_free(values);` should be removed since the bump allocator doesn't require explicit freeing.

## Notes

- The test uses the engine API (`dp_engine_init`, `dp_engine_load_buffer`, `dp_engine_query`)
- All format parsers are registered via `dp_formats_init()`
- The test loads the GRIB2 file and can execute point/bbox queries

