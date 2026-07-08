# Parquet / GeoParquet Decode Logic

Parquet support is a JS-only reader layered over `hyparquet`. The public entry is `lib/parquet-helper.js`; internals live under `lib/parquet/`.

## Schema Interpretation

`scan()` reads Parquet footer metadata, parses the optional GeoParquet `geo` key-value block, and resolves roles in this order: explicit `opts.columns`, GeoParquet primary geometry, then lat/lon/time aliases. Value variables are the remaining numeric columns. Missing coordinates or geometry raises `ExtractError`.

## Spatialization

Rows are grouped by normalized epoch-second time. Each value column is classified independently. Dense, duplicate-free coordinate lattices become `mesh` variables; they are pivoted into a row-major `Float32Array` with row 0 at maximum latitude and missing cells as `NaN`. Sparse or duplicate point sets remain `point` variables and are rasterized lazily with mean-bin aggregation for `extractGrid()`.

`extract()` on scattered data returns the nearest observation's time series. `extractGrid()` on scattered data bins into the caller's requested bbox and size, so no native resolution is invented.

## Range Sources

`WholeFileRowSource` and `RangedRowSource` expose the same row/column interface. The ranged source uses `fetchRange()` and `ChunkCache` through a hyparquet async buffer. Row-group predicates are conservative: missing statistics keep the group, so sorted files may skip work while unsorted files fall back to reading overlapping groups.

## CRS

Plain lat/lon columns are WGS84 degrees. GeoParquet WKB points default to CRS84/WGS84; supported projected EPSG codes are converted per point through the TIFF projection helpers. Unsupported CRS identifiers raise `UnsupportedCRSError`.
