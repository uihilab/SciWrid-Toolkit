# parser-web

A C library (targeting WebAssembly via Emscripten) that extracts meteorological
data from **GRIB2**, **NetCDF**, and **HDF5** files into a unified in-memory grid
structure, queryable by point or bounding-box, for downstream use in web
applications or export to GeoTIFF.

---

## Project Scope

The goal is a **single-source C library** that:

1. **Parses** raw binary meteorological formats without external dependencies
   (no eccodes, no netcdf-c — pure C for WASM portability).
2. **Exposes a query API** for extracting values at a given (lat, lon) or
   within a geographic bounding box.
3. **Maps results** into a regular rectilinear grid (`dp_grid_regular_t`)
   suitable for export as GeoTIFF / cloud-optimized GeoTIFF.

---

## Directory Structure

```
parser-web/
├── core/
│   ├── abi/            ABI version header
│   ├── cursor/         Byte/bit cursor over a read-only buffer
│   ├── dispatch/       Format dispatcher
│   ├── engine/         Engine lifecycle + format registry
│   ├── errors/         Error codes + dp_strerror()
│   ├── grid/           Unified grid types (regular lat/lon + point cloud)
│   ├── math/           geo.c — haversine, lon normalisation, grid indexing
│   ├── memory/         Bump allocator (dp_alloc / dp_reset)
│   ├── query/          Point and bbox query execution
│   ├── util/           Bit reader, endian helpers
│   └── wasm/           WASM build flags
├── formats/
│   ├── grib2/          GRIB2 decoder + section indexer
│   │   ├── grib2.c          Main decoder + grib2_index()
│   │   ├── grib2.h          Public API + grib2_field_descriptor_t
│   │   ├── grib2_metadata.c Parameter name table
│   │   ├── grib2_metadata.h grib2_metadata_t struct
│   │   ├── test_grib2.c     FORMAT PROBE (see below)
│   │   └── build_test.ps1   Windows build script (gcc)
│   ├── hdf5/           Stub — not yet implemented
│   ├── netcdf/         Stub — not yet implemented
│   └── raw/            Raw binary grid format (for testing)
├── docs/
├── examples/           Sample GRIB2 files (see below)
│   ├── ak_20240202_24h.grb2
│   ├── conus_20240202_24h.grb2
│   ├── pr_20240202_24h.grb2
│   └── icon_global_icosahedral_single-level_2025121900_000_T_2M.grib2
└── js/                 (JavaScript bindings — future)
```

---

## Building the Test Binary

Requires **gcc** in PATH (MinGW on Windows is fine).

```powershell
# From the repo root:
powershell.exe -ExecutionPolicy Bypass -File .\formats\grib2\build_test.ps1

# Then run the format probe:
.\test_grib2.exe <file.grib2>
```

---

## Format Probe (`test_grib2.exe`)

`test_grib2.exe` is a **pure diagnostic tool** — it never calls the engine or
query API. It walks every section of a GRIB2 file and prints structured metadata
to stdout. Use it to understand a new file before attempting extraction.

```
.\test_grib2.exe my_file.grib2
```

Output covers:
- Section 0: Discipline, edition, total length
- Section 1: Centre, reference time, data type, forecast status
- Section 2: Local use (skipped, size noted)
- Section 3: Grid template, number of points, grid-specific parameters
- Section 4: Parameter (category + number), product template, forecast time
- Section 5: Packing method, reference value, binary/decimal scale, bits-per-value
- Section 6: Bitmap indicator
- Section 7: Data payload byte count

---

## Example Files — Format Survey

### 1. `examples/ak_20240202_24h.grb2` (101 KB)
| Field | Value |
|---|---|
| Source | NCEP/NWS (USA), sub-centre 4 |
| Reference time | 2024-02-01 12:00:00 UTC — Analysis |
| Grid template | **20 — Polar Stereographic** |
| Points | 243,800 (grid); 590,556 (Section 5 data count — with bitmap) |
| Parameter | Category 1 / Number 8 |
| Product template | 8 — Statistically processed (24h time range accumulation) |
| Packing | Complex packing with spatial differencing (Template 3), 20 bits/value |
| Decimal scale | 4 (values × 10⁻⁴) |
| Bitmap | **Present** — coverage mask follows in Section 6 |
| Data payload | 72,914 bytes |

**Notes:** Polar Stereographic grids have explicit projection parameters in
Section 3 (standard parallel, orientation of grid, Dx/Dy). The probe does not yet
decode Polar Stereographic template fields — this needs to be added to
`probe_section3()` in `test_grib2.c` (template 20 starts at offset sec+5+9).

---

### 2. `examples/conus_20240202_24h.grb2` (475 KB)
| Field | Value |
|---|---|
| Source | NCEP/NWS (USA), sub-centre 4 |
| Reference time | 2024-02-01 12:00:00 UTC — Analysis |
| Grid template | **20 — Polar Stereographic** |
| Points | 987,601 (grid); 590,556 (data, post-bitmap) |
| Parameter | Category 1 / Number 8 |
| Product template | 8 — Statistically processed (24h) |
| Packing | Complex packing with spatial differencing (Template 3), 21 bits/value |
| Decimal scale | 4 |
| Bitmap | **Present** — 123,457-byte bitmap in Section 6 |
| Data payload | 363,276 bytes |

**Notes:** Same parameter and time as `ak` but CONUS (Continental US) coverage.
Point count mismatch between Section 3 (987,601) and Section 5 (590,556) is
**normal and expected** when a bitmap is used — Section 5 only counts the
unmasked (valid) data points.

---

### 3. `examples/pr_20240202_24h.grb2` (14 KB)
| Field | Value |
|---|---|
| Source | NCEP/NWS (USA), sub-centre 4 |
| Reference time | 2024-02-01 12:00:00 UTC — Analysis |
| Grid template | **20 — Polar Stereographic** |
| Points | 42,025 (grid); 42,025 (data) |
| Parameter | Category 1 / Number 8 |
| Product template | 8 — Statistically processed (24h) |
| Packing | Complex packing with spatial differencing (Template 3), 18 bits/value |
| Decimal scale | 4 |
| Bitmap | **Present** (5,260 bytes) |
| Data payload | 9,363 bytes |

**Notes:** Puerto Rico regional domain. Smallest file in the set — good for unit
testing the decoding pipeline once it is implemented.

---

### 4. `examples/icon_global_icosahedral_single-level_2025121900_000_T_2M.grib2` (5.6 MB)
| Field | Value |
|---|---|
| Source | DWD (Germany), centre 78 |
| Reference time | 2025-12-19 00:00:00 UTC — Forecast (T+0) |
| Grid template | **101 — General Unstructured Grid (ICON icosahedral)** |
| Points | **2,949,120** |
| Parameter | Category 0 / Number 0 → **Temperature at 2m** |
| Product template | 0 — Instantaneous analysis/forecast |
| Packing | **Simple packing (Template 0)** |
| Bitmap | None (all 2,949,120 values present) |
| Data payload | 5,898,240 bytes |

**Notes — CRITICAL for extraction:**
- Grid Template 101 **does not embed lat/lon coordinates** in Section 3. The
  grid geometry (cell centroids) lives in a separate **Grid Description File
  (GGDF)**, distributed by DWD as a NetCDF file (e.g.
  `icon_grid_0026_R03B07_G.nc`). Without the GGDF, you cannot map data values
  to geographic coordinates.
- The `N2`, `Ni`, `Nd` fields in Section 3 are ICON-internal refinement
  parameters, not directly usable point counts.
- Once you have the GGDF, the mapping is: `cell_index → (clat[i], clon[i])`,
  and the GRIB2 data values are in the same cell-index order.

---

## Current Engine Architecture

### Grid Types
| Enum | Struct | Use |
|---|---|---|
| `DP_GRID_TYPE_REGULAR` | `dp_grid_regular_t` | Lat/lon and projected rectilinear grids |
| `DP_GRID_TYPE_POINTS` | `dp_grid_points_t` | Unstructured/icosahedral — point cloud |

### Memory
The bump allocator (`core/memory/allocator.c`) uses a **static 256 MB heap**
(`DP_HEAP_SIZE`). This is intentionally large to accommodate ICON-scale point
arrays in WASM linear memory. In WASM this compiles to a BSS segment, so it
does not bloat the `.wasm` binary on disk.

```c
// core/memory/allocator.c
#define DP_HEAP_SIZE (256 * 1024 * 1024)
```

`dp_reset()` resets the bump pointer to 0 (effectively freeing everything).
There is no per-object `free()` — the allocator is used in a load → query →
reset cycle.

### Query API
Located in `core/query/query.c`. Returns a single value (`DP_QUERY_POINT`) or
an array of floats (`DP_QUERY_BBOX`):

- **Regular grids**: direct index computation.
- **Point-cloud grids**: O(N) linear scan using Haversine distance to find the
  nearest point. For 2.9M ICON points this is ~100ms in native C; in WASM it
  may need a spatial index (k-d tree or quad-tree) for acceptable performance.

---

## Known Issues / Current State

### ✅ Working
- GRIB2 section walking and metadata indexing (`grib2_index`)
- Simple packing decoding (template 0)
- Point + bbox queries on regular rectilinear grids
- Point query (nearest-neighbour) on point-cloud grids
- Format probe tool (`test_grib2.exe`)
- Memory sized for large ICON grids

### ⚠️ Needs Work
1. **Section 3 decoder for Polar Stereographic (template 20)** — the probe skips
   template-specific parameters for templates other than 0, 40, and 101. Full
   decoding of Dx/Dy, standard parallel, and orientation is needed to build a
   proper regular grid for AK/CONUS/PR files.

2. **Complex packing with spatial differencing (template 3)** — used by all the
   NCEP/NWS files. This requires a multi-step decode:
   - Extract group widths / group references (complex packing groups)
   - Apply first-order or second-order spatial differencing
   - Reconstruct the original integer array
   - Apply binary scale + decimal scale + reference value
   Reference: WMO GRIB2 regulation, Section 5 Template 3 (Annex D).

3. **ICON GGDF pairing** — for icosahedral grids (template 101), the library
   needs a way to ingest the companion grid geometry file (DWD NetCDF GGDF)
   to populate `dp_grid_point_t.lat` / `.lon`. Without this, point-cloud
   queries have coordinates of 0,0.

4. **Bitmap application** — when Section 6 contains a bitmap (indicator = 0),
   the data array in Section 7 only contains values for unmasked points.
   The decoder must expand these back to the full grid using the bitmap mask.

5. **Spatial index for point-cloud queries** — O(N) Haversine scan over 2.9M
   ICON cells will be ~150–300ms in WASM. Needs a k-d tree on (lat, lon) or
   a geographic quad-tree, seeded once at load time.

6. **GeoTIFF export** — the output pipeline (rectilinear grid → TIFF tags +
   sample data) is not yet implemented. Once the grid is in
   `dp_grid_regular_t`, writing a cloud-optimised GeoTIFF is a matter of
   encoding TIFF headers + image strips.

7. **NetCDF and HDF5** — stubs only. No parsing logic implemented.

### ❌ Known Bug (now fixed)
- Section lengths were previously being read as **24-bit big-endian** via
  `read_be24()`. GRIB2 sections use **32-bit big-endian** lengths. This caused
  the parser to misidentify section boundaries and enter infinite scan loops
  on real files. Fixed in `grib2.c` — all section length reads now use
  `read_be32()`.

---

## Suggested Next Steps (priority order)

1. **Decode Polar Stereographic template fields in `probe_section3()`** (and
   ultimately in `grib2_parse_grid()`) to get Dx/Dy and the projection origin.
   This unlocks AK/CONUS/PR data extraction.

2. **Implement complex packing Template 3 decoder** in
   `grib2_parse_data_section()`. Start with `pr_20240202_24h.grb2` (smallest
   file, 42k points, 18-bit values).

3. **Implement bitmap expansion** — when Section 6 bitmap indicator is 0, read
   the `ceil(N/8)` bitmap bytes and use them as a mask when filling
   `g->u.regular.data[]`.

4. **Add GGDF loader** as a companion path. Propose: `dp_load_icon_ggdf(path,
   grid)` that reads a DWD NetCDF GGDF and populates `dp_grid_point_t.lat/lon`
   arrays. This is a separate `formats/ggdf/` module.

5. **Add k-d tree for point-cloud nearest-neighbour** in `core/query/`. A flat
   2D k-d tree on spherical coordinates will reduce ICON point query time from
   O(N) to O(log N).

6. **Implement GeoTIFF writer** in a new `output/geotiff/` module. Minimum
   viable: single-band float32 GeoTIFF with GeoKeys for the CRS.

---

## Parameter Table (GRIB2 — observed in examples)

| Category | Number | Variable |
|---|---|---|
| 0 | 0 | Temperature (2m, Kelvin for ICON) |
| 1 | 8 | Total precipitation (statistically processed — 24h accumulation) |

The full GRIB2 parameter table is in WMO Code Table 4.2.
`formats/grib2/grib2_metadata.c` contains a partial lookup table for common
meteorological parameters.

---

## GRIB2 Section Quick Reference

| # | Name | Notes |
|---|---|---|
| 0 | Indicator | 16 bytes, fixed. Contains discipline + edition + total message length |
| 1 | Identification | Centre, sub-centre, reference time, data type |
| 2 | Local use | Optional, centre-specific data |
| 3 | Grid Definition | Grid template number + grid-specific geometry |
| 4 | Product Definition | Parameter, forecast time, level, ensemble info |
| 5 | Data Representation | Packing type, reference value, scale factors, bits-per-value |
| 6 | Bitmap | Optional mask indicating which points have data |
| 7 | Data | Packed binary values |
| 8 | End | 4-byte literal `"7777"` |

Section lengths in GRIB2 are **4-byte big-endian integers** at the start of
each section (offsets 0–3), followed by the 1-byte section number at offset 4.

---

*Last updated: 2026-04-08 — initial diagnostic session*
*Status: format probe working; decoder stubs in place; extraction pipeline in progress*
