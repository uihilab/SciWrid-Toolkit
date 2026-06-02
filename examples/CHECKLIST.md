# Map demo — cross-format verification checklist

The map demo (`examples/map-demo.html` + `map-demo.js` + `map-demo.worker.js`)
is format-agnostic: every reader produces the same `ExtractGridResult`, so a
single render path covers all formats. This checklist is run **by hand in a
real browser** — it cannot be automated headlessly.

## How to run

```bash
npm run demo:web
# then open http://localhost:5173/examples/map-demo.html
```

Drop a file, pick a variable + ramp, confirm the overlay, then click the map to
read a value. Requires an internet connection (MapLibre + basemap load from a
CDN) and a modern browser (module workers).

## Status legend

- `[x]` verified in a browser
- `[ ]` not yet verified

## Sweep

- [ ] **GRIB2** — `examples/timeseries/gfs_timeseries.grb2`. Pick a pressure /
      temperature field and confirm the synoptic pattern is visible.
- [ ] **NetCDF3** — supply a `.nc3` file (no fixture ships in the repo). Confirm
      it renders.
- [ ] **NetCDF4** — supply a `.nc` file (uses h5wasm from the CDN). Confirm.
- [ ] **Zarr** — supply a zipped Zarr store (`.zip`). The repo ships an unzipped
      store at `examples/testfile/sample-zarr/`; zip it first
      (`Compress-Archive examples/testfile/sample-zarr/* sample.zarr.zip`).
- [ ] **TIFF (small)** — `examples/testfile/tiff/synthetic-u8-none-strip-wgs84.tif`.
      Confirm.
- [ ] **TIFF (COG)** — `examples/testfile/tiff/synthetic-f32-none-tile-cog-wgs84.tif`.
      Pan around and confirm range-fetched bytes stay reasonable
      (devtools → Network).
- [ ] **Real-world** — drop a real Sentinel-2 RGB COG or a NOAA HRRR file if
      available. Verify it loads.
- [ ] **Click-to-query** — click inside each rendered layer and confirm the
      popup shows a plausible value (or "out of bounds" outside coverage).
- [ ] **Pan/zoom smoothness** — rapidly pan/zoom on a 1 MB+ file and confirm the
      UI never freezes (worker offload + request cancellation).

## Notes

Record observations here as you verify (date, browser, file, result).
