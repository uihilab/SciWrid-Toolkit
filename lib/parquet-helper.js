import { UnsupportedFormatError, ExtractError } from './errors.js';
import { UnsupportedCRSError } from './tiff/errors.js';
import { nativeToLatLon } from './tiff/projections.js';
import { decodeGeoArrowPoint, decodePointWKB, isPointEncoding } from './parquet/geometry.js';
import { numericColumnNames, parseGeoMetadata, resolveColumnRoles } from './parquet/metadata.js';
import { openRowSource, isUrlSource } from './parquet/row-source.js';
import { survivingRowGroups } from './parquet/predicate.js';
import {
  classifyGrid, groupTimes, isoTimes, nearestAxisIndex, nearestPointSeries,
  pivotMesh, rasterizeMeanBin, TOL,
} from './parquet/spatialize.js';

const PAR1 = [0x50, 0x41, 0x52, 0x31];

function hasPar1At(u8, offset) {
  return u8.length >= offset + 4 && PAR1.every((b, i) => u8[offset + i] === b);
}

async function detectUrl(url, fetchImpl = globalThis.fetch) {
  const { fetchRange } = await import('./sources/range-fetcher.js');
  const head = await fetchImpl(url, { method: 'HEAD' });
  if (!head.ok) return null;
  const len = Number(head.headers.get('content-length'));
  if (!Number.isFinite(len) || len < 8) return null;
  const first = await fetchRange(url, 0, 4, fetchImpl);
  const last = await fetchRange(url, len - 4, 4, fetchImpl);
  return hasPar1At(first, 0) && hasPar1At(last, 0) ? 'parquet' : null;
}

export async function detectFormat(source, opts = {}) {
  if (isUrlSource(source)) return detectUrl(source instanceof URL ? source.href : source, opts.fetchImpl);
  const u8 = source instanceof Uint8Array ? source : new Uint8Array(source);
  return u8.length >= 8 && hasPar1At(u8, 0) && hasPar1At(u8, u8.length - 4) ? 'parquet' : null;
}

function ensureParquet(source, opts) {
  return detectFormat(source, opts).then(fmt => {
    if (fmt !== 'parquet') throw new UnsupportedFormatError('Parquet: missing PAR1 magic at head and tail');
  });
}

function toFiniteArray(values, label) {
  const out = values.map(Number);
  for (const v of out) if (!Number.isFinite(v)) throw new ExtractError('Parquet: non-numeric ' + label + ' value');
  return out;
}

function epsgCode(crs) {
  if (!crs) return null;
  if (crs === null) return null;
  if (typeof crs === 'string') {
    const m = /EPSG[:/ ](\d+)/i.exec(crs);
    return m ? Number(m[1]) : null;
  }
  if (crs.id) {
    if (String(crs.id.authority || '').toUpperCase() === 'EPSG' && crs.id.code != null) return Number(crs.id.code);
    if (crs.id.code != null && crs.id.authority == null) return Number(crs.id.code);
  }
  return null;
}

function geoForEpsg(code) {
  if (!code || code === 4326) return { kind: 'geographic' };
  if (code >= 32601 && code <= 32660) return { kind: 'utm', zone: code - 32600, hemisphere: 'N' };
  if (code >= 32701 && code <= 32760) return { kind: 'utm', zone: code - 32700, hemisphere: 'S' };
  throw new UnsupportedCRSError('Parquet geometry CRS EPSG:' + code + ' not supported', { epsg: code });
}

function applyCrs(points, geo) {
  const code = epsgCode(geo && geo.crs);
  if (!code || code === 4326) return points;
  const nativeGeo = geoForEpsg(code);
  return points.map(p => {
    const ll = nativeToLatLon({ x: p.lon, y: p.lat }, nativeGeo);
    return { lon: ll.lon, lat: ll.lat };
  });
}

function resolveCoords(colData, roles, geo) {
  if (roles.geometryCol) {
    if (!isPointEncoding(geo && geo.encoding)) throw new ExtractError('Parquet: unsupported geometry encoding ' + (geo && geo.encoding));
    let points = colData[roles.geometryCol].map(v => {
      const enc = String((geo && geo.encoding) || 'WKB').toLowerCase();
      return enc === 'wkb' && (v instanceof Uint8Array || v instanceof ArrayBuffer) ? decodePointWKB(v) : decodeGeoArrowPoint(v);
    });
    points = applyCrs(points, geo);
    return { lat: points.map(p => p.lat), lon: points.map(p => p.lon) };
  }
  return {
    lat: toFiniteArray(colData[roles.latCol], 'latitude'),
    lon: toFiniteArray(colData[roles.lonCol], 'longitude'),
  };
}

function bboxFromCoords(lat, lon, geo) {
  if (geo && geo.bbox && (!geo.crs || epsgCode(geo.crs) == null || epsgCode(geo.crs) === 4326)) return geo.bbox;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] < minLat) minLat = lat[i];
    if (lat[i] > maxLat) maxLat = lat[i];
    if (lon[i] < minLon) minLon = lon[i];
    if (lon[i] > maxLon) maxLon = lon[i];
  }
  return [minLon, minLat, maxLon, maxLat];
}

function resolveTimeIndex(times, opts = {}) {
  if (opts.t != null) return Math.max(0, Math.min(times.length - 1, opts.t | 0));
  if (opts.time != null) return Math.max(0, Math.min(times.length - 1, opts.time | 0));
  if (opts.date != null) {
    const target = Math.round(Date.parse(opts.date) / 1000);
    let best = 0, bd = Infinity;
    times.forEach((tt, i) => { const d = Math.abs(tt - target); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  return 0;
}

function neededColumns(roles) {
  return [...new Set([
    roles.geometryCol, roles.latCol, roles.lonCol, roles.timeCol, ...roles.valueCols,
  ].filter(Boolean))];
}

export async function scan(source, opts = {}) {
  await ensureParquet(source, opts);
  const rowSource = await openRowSource(source, opts);
  try {
    const allCols = rowSource.schemaColumns();
    const geo = parseGeoMetadata(rowSource.keyValueMetadata());
    let roles = resolveColumnRoles(allCols, geo, opts.columns || null);
    const numeric = new Set(numericColumnNames(rowSource.metadata));
    if (!(opts.columns && opts.columns.variable)) {
      roles = { ...roles, valueCols: roles.valueCols.filter(c => numeric.has(c)) };
    }
    if (roles.valueCols.length === 0) throw new ExtractError('Parquet: no numeric value columns found');

    const groups = rowSource.listRowGroups();
    const selectedGroups = survivingRowGroups(groups, {
      timeCol: roles.timeCol,
      latCol: roles.latCol,
      lonCol: roles.lonCol,
      bbox: opts.bbox,
      timeRange: opts._timeRange,
    });
    const colData = await rowSource.readColumns(neededColumns(roles), selectedGroups);
    const coords = resolveCoords(colData, roles, geo);
    const rowCount = coords.lat.length;
    const grouped = groupTimes(roles.timeCol ? colData[roles.timeCol] : null, rowCount);
    const byVar = {};
    for (const name of roles.valueCols) {
      byVar[name] = classifyGrid(coords.lat, coords.lon, grouped.frames, grouped.times.length, TOL, 0.5);
      byVar[name].times = grouped.times;
      byVar[name].timesInfo = isoTimes(grouped.times);
    }
    return {
      format: 'parquet', rowSource, roles, geo, colData, coords,
      times: grouped.times, timesInfo: isoTimes(grouped.times), frames: grouped.frames,
      byVar, bbox: bboxFromCoords(coords.lat, coords.lon, geo), bytesFetched: rowSource.bytesFetched,
    };
  } catch (e) {
    await rowSource.close();
    throw e;
  }
}

export function scanGetVarsJson(scanResult) {
  return JSON.stringify(scanResult.roles.valueCols.map((name, index) => {
    const info = scanResult.byVar[name];
    const nx = info.gridType === 'mesh' ? info.lons.length : 0;
    const ny = info.gridType === 'mesh' ? info.lats.length : 0;
    return {
      index, name, gridType: info.gridType, nx, ny,
      messages: info.times.length,
      supported: true,
      times: info.timesInfo,
      warnings: scanResult.roles.warnings,
    };
  }));
}

export function geoBbox(scanResult) {
  return scanResult && scanResult.bbox ? scanResult.bbox : null;
}

export async function scanFree(scanResult) {
  if (scanResult && scanResult.rowSource) await scanResult.rowSource.close();
}

function variableInfo(scanResult, name) {
  const varName = name || scanResult.roles.valueCols[0];
  const info = scanResult.byVar[varName];
  if (!info) throw new ExtractError('Parquet: variable "' + varName + '" not found');
  return { varName, info };
}

export async function extract(source, opts = {}) {
  const scanResult = await scan(source, opts);
  try {
    const { varName, info } = variableInfo(scanResult, opts.variable);
    const values = scanResult.colData[varName].map(Number);
    let series;
    if (info.gridType === 'point') {
      series = nearestPointSeries(scanResult.coords.lat, scanResult.coords.lon, values,
        scanResult.frames, info.times.length, opts.lat, opts.lon);
    } else {
      const grid = pivotMesh(scanResult.coords.lat, scanResult.coords.lon, values,
        scanResult.frames, info.times.length, info.lats, info.lons, TOL);
      const iy = nearestAxisIndex(info.lats, opts.lat);
      const ix = nearestAxisIndex(info.lons, opts.lon);
      series = new Float32Array(info.times.length);
      const ny = info.lats.length, nx = info.lons.length;
      for (let f = 0; f < info.times.length; f++) series[f] = grid[f * ny * nx + iy * nx + ix];
    }
    return { variable: varName, values: series, times: info.timesInfo.values, location: { lat: opts.lat, lon: opts.lon } };
  } finally {
    await scanFree(scanResult);
  }
}

function resampleMesh(grid, lats, lons, frameIndex, bbox, width, height) {
  const ny = lats.length, nx = lons.length;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const out = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    const la = maxLat - ((r + 0.5) / height) * (maxLat - minLat);
    const iy = nearestAxisIndex(lats, la);
    for (let c = 0; c < width; c++) {
      const lo = minLon + ((c + 0.5) / width) * (maxLon - minLon);
      const ix = nearestAxisIndex(lons, lo);
      out[r * width + c] = grid[frameIndex * ny * nx + iy * nx + ix];
    }
  }
  return out;
}

export async function extractGrid(source, opts = {}) {
  const scanResult = await scan(source, opts);
  try {
    const { varName, info } = variableInfo(scanResult, opts.variable);
    const values = scanResult.colData[varName].map(Number);
    const bbox = opts.bbox || scanResult.bbox;
    const width = opts.width || 256;
    const height = opts.height || 256;
    const fi = resolveTimeIndex(info.times, opts);
    let data;
    if (info.gridType === 'point') {
      data = rasterizeMeanBin(scanResult.coords.lat, scanResult.coords.lon, values, scanResult.frames, fi, bbox, width, height);
    } else {
      const grid = pivotMesh(scanResult.coords.lat, scanResult.coords.lon, values,
        scanResult.frames, info.times.length, info.lats, info.lons, TOL);
      data = resampleMesh(grid, info.lats, info.lons, fi, bbox, width, height);
    }
    return { data, width, height, bbox, variable: varName, time: fi, date: info.timesInfo.values[fi] };
  } finally {
    await scanFree(scanResult);
  }
}

export async function normalize(scanResult, varName, wasm) {
  const { info } = variableInfo(scanResult, varName);
  if (info.gridType !== 'mesh') throw new ExtractError('Parquet: normalize() is mesh-only; use extract()/extractGrid() for scattered points');
  const values = scanResult.colData[varName].map(Number);
  const nt = info.times.length, ny = info.lats.length, nx = info.lons.length;
  const grid = pivotMesh(scanResult.coords.lat, scanResult.coords.lon, values,
    scanResult.frames, nt, info.lats, info.lons, TOL);
  const times = new Float64Array(info.times);
  const lats = new Float32Array(info.lats);
  const lons = new Float32Array(info.lons);
  const nameLen = wasm.lengthBytesUTF8(varName) + 1;
  const namePtr = wasm.ccall('wp_malloc', 'number', ['number'], [nameLen]);
  wasm.stringToUTF8(varName, namePtr, nameLen);
  const latsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [ny * 4]);
  const lonsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [nx * 4]);
  const tsPtr = wasm.ccall('wp_malloc', 'number', ['number'], [nt * 8]);
  const dataPtr = wasm.ccall('wp_malloc', 'number', ['number'], [grid.byteLength]);
  wasm.HEAPF32.set(lats, latsPtr / 4);
  wasm.HEAPF32.set(lons, lonsPtr / 4);
  wasm.HEAPF64.set(times, tsPtr / 8);
  wasm.HEAPF32.set(grid, dataPtr / 4);
  const ds = wasm.ccall('wp_open_from_float_arrays', 'number',
    ['number','number','number','number','number','number','number','number'],
    [namePtr, nx, ny, nt, latsPtr, lonsPtr, tsPtr, dataPtr]);
  for (const p of [namePtr, latsPtr, lonsPtr, tsPtr, dataPtr]) wasm.ccall('wp_free', null, ['number'], [p]);
  return ds;
}

