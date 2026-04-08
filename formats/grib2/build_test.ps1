# PowerShell compilation script for test_grib2

$ErrorActionPreference = "Stop"

# Source files
$coreSrc = @(
    "core/engine/engine.c",
    "core/engine/format_parser.c",
    "core/engine/formats_init.c",
    "core/dispatch/dispatch.c",
    "core/query/query.c",
    "core/memory/allocator.c",
    "core/cursor/cursor.c",
    "core/math/geo.c",
    "core/errors/errors.c"
)

$formatSrc = @(
    "formats/grib2/grib2.c",
    "formats/grib2/grib2_metadata.c",
    "formats/raw/raw.c",
    "formats/hdf5/hdf5.c",
    "formats/netcdf/netcdf.c"
)

$testSrc = "formats/grib2/test_grib2.c"

# Include directories
$includes = "-I. -Icore -Iformats"

# All source files
$allSrc = $coreSrc + $formatSrc + $testSrc

# Compile
Write-Host "Compiling test_grib2..." -ForegroundColor Cyan

$srcList = $allSrc -join " "
$cmd = "gcc -Wall -Wextra -std=c99 -O2 $includes $srcList -lm -o test_grib2.exe"

Invoke-Expression $cmd

if ($LASTEXITCODE -eq 0) {
    Write-Host "Compilation successful: test_grib2.exe" -ForegroundColor Green
} else {
    Write-Host "Compilation failed" -ForegroundColor Red
    exit 1
}

