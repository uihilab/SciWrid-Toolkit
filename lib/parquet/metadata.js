// lib/parquet/metadata.js
// hyparquet API findings from scripts/spike-parquet-api.mjs:
// - metadata.key_value_metadata is an array of { key, value }.
// - row_groups[].columns[].meta_data.path_in_schema is an array, e.g. ['lat'].
// - statistics use min_value/max_value; min/max are often undefined.
// - offsets are BigInt-capable: column.file_offset, meta_data.data_page_offset,
//   meta_data.dictionary_page_offset, meta_data.total_compressed_size.
import { ExtractError } from '../errors.js';

const LAT = ['lat', 'latitude', 'y'];
const LON = ['lon', 'longitude', 'x'];
const TIME = ['time', 'datetime', 'date', 'timestamp', 'valid_time'];

export function kvArrayToObject(kv) {
  const out = {};
  if (!kv) return out;
  if (Array.isArray(kv)) {
    for (const e of kv) if (e && e.key != null) out[e.key] = e.value;
  } else {
    for (const [k, v] of Object.entries(kv)) out[k] = v;
  }
  return out;
}

export function parseGeoMetadata(kv) {
  const map = kvArrayToObject(kv);
  if (!map.geo) return null;
  let g;
  try { g = JSON.parse(map.geo); }
  catch { return null; }
  const primaryColumn = g.primary_column || (g.columns && Object.keys(g.columns)[0]);
  if (!primaryColumn) return null;
  const col = (g.columns && g.columns[primaryColumn]) || {};
  return {
    primaryColumn,
    encoding: col.encoding || 'WKB',
    crs: col.crs ?? null,
    bbox: Array.isArray(col.bbox) ? col.bbox : (Array.isArray(g.bbox) ? g.bbox : null),
    raw: g,
  };
}

const findAlias = (cols, aliases) => {
  const lower = cols.map(c => String(c).toLowerCase());
  for (const a of aliases) {
    const i = lower.indexOf(a);
    if (i >= 0) return cols[i];
  }
  return null;
};

function hasColumn(cols, name) {
  return cols.includes(name);
}

function requireColumn(cols, name, role) {
  if (name != null && !hasColumn(cols, name)) {
    throw new ExtractError('Parquet: column "' + name + '" for ' + role +
      ' not found; available: ' + cols.join(', '));
  }
}

export function resolveColumnRoles(columnNames, geo, override = null) {
  const cols = columnNames.slice();
  const warnings = [];
  let latCol = null;
  let lonCol = null;
  let timeCol = null;
  let geometryCol = null;
  let source = 'none';

  if (override) {
    requireColumn(cols, override.lat, 'lat');
    requireColumn(cols, override.lon, 'lon');
    requireColumn(cols, override.time, 'time');
    requireColumn(cols, override.geometry, 'geometry');
    requireColumn(cols, override.variable, 'variable');
    latCol = override.lat || null;
    lonCol = override.lon || null;
    timeCol = override.time || null;
    geometryCol = override.geometry || null;
    source = 'override';
  }

  if (!geometryCol && !latCol && geo) {
    geometryCol = geo.primaryColumn;
    requireColumn(cols, geometryCol, 'geometry');
    if (findAlias(cols, LAT) && findAlias(cols, LON)) {
      warnings.push('Parquet: both geometry column "' + geometryCol +
        '" and lat/lon columns present; using geometry.');
    }
    if (source !== 'override') source = 'geo';
  }

  if (!geometryCol && !latCol) {
    latCol = findAlias(cols, LAT);
    lonCol = findAlias(cols, LON);
    if (latCol && lonCol && source !== 'override') source = 'alias';
  }
  if (!timeCol) timeCol = findAlias(cols, TIME);

  if (!geometryCol && (!latCol || !lonCol)) {
    throw new ExtractError('Parquet: no coordinate or geometry columns found; pass opts.columns = {lat, lon} or {geometry}. Available: ' + cols.join(', '));
  }

  const used = new Set([latCol, lonCol, timeCol, geometryCol].filter(Boolean));
  let valueCols;
  if (override && override.variable) valueCols = Array.isArray(override.variable) ? override.variable : [override.variable];
  else valueCols = cols.filter(c => !used.has(c));
  return { latCol, lonCol, timeCol, geometryCol, valueCols, source, warnings };
}

export function schemaColumnNames(metadata) {
  return (metadata.schema || []).filter(e => e.type).map(e => e.name);
}

export function numericColumnNames(metadata) {
  const numeric = new Set(['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE']);
  return (metadata.schema || []).filter(e => e.type && numeric.has(e.type)).map(e => e.name);
}
