/*
 * wasm/grid-output.js  --  Serializers for extractGrid() results.
 *
 * Public helpers:
 *   gridToJSON(grid)     → string             portable, human-readable
 *   gridToGeoTIFF(grid)  → Uint8Array         single-band Float32 GeoTIFF (WGS84)
 *
 * Both consume the result returned by extractGrid:
 *   { data: Float32Array, width, height, bbox: [minLon,minLat,maxLon,maxLat],
 *     variable, units?, time? }
 *
 * The GeoTIFF writer is a minimal, dependency-free implementation:
 *   - Little-endian byte order
 *   - Single uncompressed strip
 *   - SampleFormat = 3 (IEEE float), BitsPerSample = 32
 *   - GeoKeys: WGS84 geographic CRS (EPSG:4326), pixel-is-area
 *   - Row 0 at maxLat (north-up) — matches extractGrid's row convention
 */

/* ========================================================================
 * JSON
 * ====================================================================== */
export function gridToJSON(grid, { pretty = false } = {}) {
  _validateGrid(grid);
  const payload = {
    variable: grid.variable,
    width:    grid.width,
    height:   grid.height,
    bbox:     grid.bbox,
    units:    grid.units ?? null,
    time:     grid.time ?? null,
    /* Float32Array → plain array. JSON has no NaN, so encode as null. */
    data:     Array.from(grid.data, (v) => (Number.isFinite(v) ? v : null)),
  };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

/* ========================================================================
 * GeoTIFF — single-band Float32, WGS84
 * ====================================================================== */
export function gridToGeoTIFF(grid) {
  _validateGrid(grid);
  const { data, width, height, bbox } = grid;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dx = (maxLon - minLon) / width;
  const dy = (maxLat - minLat) / height;

  /* External values — must be written outside the IFD because each is >4 bytes. */
  const modelPixelScale = new Float64Array([dx, dy, 0]);          // 24 bytes
  const modelTiepoint   = new Float64Array([0, 0, 0, minLon, maxLat, 0]); // 48 bytes
  /* GeoKeyDirectory: header (4 SHORTs) + 3 keys × 4 SHORTs each = 16 SHORTs = 32 bytes
   * Header: keyDirectoryVersion=1, keyRevision=1, minorRevision=0, numberOfKeys=3 */
  const geoKeyDirectory = new Uint16Array([
    1, 1, 0, 3,
    1024, 0, 1, 2,        // GTModelTypeGeoKey       = 2 (ModelTypeGeographic)
    1025, 0, 1, 1,        // GTRasterTypeGeoKey      = 1 (RasterPixelIsArea)
    2048, 0, 1, 4326,     // GeographicTypeGeoKey    = 4326 (WGS84)
  ]);

  /* TIFF tag types: 3 = SHORT (uint16), 4 = LONG (uint32), 12 = DOUBLE (float64) */
  const tags = [
    { id: 256,   type: 4,  count: 1, value: width },
    { id: 257,   type: 4,  count: 1, value: height },
    { id: 258,   type: 3,  count: 1, value: 32 },                 // BitsPerSample
    { id: 259,   type: 3,  count: 1, value: 1 },                  // Compression = none
    { id: 262,   type: 3,  count: 1, value: 1 },                  // PhotometricInterpretation = BlackIsZero
    { id: 273,   type: 4,  count: 1, valueRef: 'stripOffset' },   // StripOffsets
    { id: 277,   type: 3,  count: 1, value: 1 },                  // SamplesPerPixel
    { id: 278,   type: 4,  count: 1, value: height },             // RowsPerStrip
    { id: 279,   type: 4,  count: 1, value: width * height * 4 }, // StripByteCounts
    { id: 284,   type: 3,  count: 1, value: 1 },                  // PlanarConfiguration = chunky
    { id: 339,   type: 3,  count: 1, value: 3 },                  // SampleFormat = IEEE float
    { id: 33550, type: 12, count: 3, external: modelPixelScale.buffer },
    { id: 33922, type: 12, count: 6, external: modelTiepoint.buffer },
    { id: 34735, type: 3,  count: geoKeyDirectory.length, external: geoKeyDirectory.buffer },
  ];

  /* Layout: header (8) + IFD (2+N*12+4) + externals + strip data */
  const numEntries  = tags.length;
  const ifdSize     = 2 + numEntries * 12 + 4;
  const ifdOffset   = 8;
  let cursor        = ifdOffset + ifdSize;
  for (const tag of tags) {
    if (tag.external) {
      tag.offset = cursor;
      cursor += tag.external.byteLength;
      /* Word-align (TIFF spec recommends offsets be even). */
      if (cursor & 1) cursor++;
    }
  }
  const stripOffset = cursor;
  const totalSize   = stripOffset + width * height * 4;

  const out = new Uint8Array(totalSize);
  const dv  = new DataView(out.buffer);

  /* Header: "II" (little-endian) + magic 42 + offset-to-first-IFD */
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42,     true);
  dv.setUint32(4, ifdOffset, true);

  /* IFD */
  dv.setUint16(ifdOffset, numEntries, true);
  let p = ifdOffset + 2;
  for (const tag of tags) {
    dv.setUint16(p,     tag.id,   true);
    dv.setUint16(p + 2, tag.type, true);
    dv.setUint32(p + 4, tag.count, true);
    if (tag.external) {
      dv.setUint32(p + 8, tag.offset, true);
    } else if (tag.valueRef === 'stripOffset') {
      dv.setUint32(p + 8, stripOffset, true);
    } else {
      /* Inline value. Field is 4 bytes; SHORT fits in low 2 bytes. */
      if (tag.type === 4)      dv.setUint32(p + 8, tag.value, true);
      else if (tag.type === 3) dv.setUint16(p + 8, tag.value, true);
      else throw new Error('gridToGeoTIFF: unhandled inline tag type ' + tag.type);
    }
    p += 12;
  }
  /* Next-IFD offset = 0 (single IFD) */
  dv.setUint32(p, 0, true);

  /* External values */
  for (const tag of tags) {
    if (tag.external) {
      out.set(new Uint8Array(tag.external), tag.offset);
    }
  }

  /* Image data — row-major Float32 (already in the right order: row 0 = maxLat). */
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), stripOffset);

  return out;
}

/* ========================================================================
 * helpers
 * ====================================================================== */
function _validateGrid(g) {
  if (!g || typeof g !== 'object')
    throw new Error('grid must be an object returned by extractGrid()');
  if (!(g.data instanceof Float32Array))
    throw new Error('grid.data must be a Float32Array');
  if (!Number.isInteger(g.width) || g.width <= 0 ||
      !Number.isInteger(g.height) || g.height <= 0)
    throw new Error('grid.width and grid.height must be positive integers');
  if (!Array.isArray(g.bbox) || g.bbox.length !== 4)
    throw new Error('grid.bbox must be [minLon, minLat, maxLon, maxLat]');
  if (g.data.length !== g.width * g.height)
    throw new Error(`grid.data.length (${g.data.length}) != width*height (${g.width * g.height})`);
}
