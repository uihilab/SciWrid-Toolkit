import { ExtractError } from '../errors.js';

const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;

function geometryName(type) {
  const base = type & 0xff;
  if (base === WKB_POINT) return 'Point';
  if (base === WKB_LINESTRING) return 'LineString';
  if (base === WKB_POLYGON) return 'Polygon';
  if (base === WKB_MULTIPOINT) return 'MultiPoint';
  if (base === WKB_MULTILINESTRING) return 'MultiLineString';
  if (base === WKB_MULTIPOLYGON) return 'MultiPolygon';
  return 'type ' + type;
}

export function decodePointWKB(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 21) throw new ExtractError('Parquet: geometry too short to be a WKB point');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = u8[0] === 1;
  if (!le && u8[0] !== 0) throw new ExtractError('Parquet: invalid WKB byte order ' + u8[0]);
  const geomType = dv.getUint32(1, le);
  if ((geomType & 0xff) !== WKB_POINT) {
    throw new ExtractError('Parquet: unsupported geometry ' + geometryName(geomType) +
      ' (only Point is supported)');
  }
  return { lon: dv.getFloat64(5, le), lat: dv.getFloat64(13, le) };
}

export function decodeGeoArrowPoint(value) {
  if (Array.isArray(value) && value.length >= 2) return { lon: Number(value[0]), lat: Number(value[1]) };
  if (value && typeof value === 'object') {
    if (value.type === 'Point' && Array.isArray(value.coordinates)) return { lon: Number(value.coordinates[0]), lat: Number(value.coordinates[1]) };
    if ('x' in value && 'y' in value) return { lon: Number(value.x), lat: Number(value.y) };
    if ('lon' in value && 'lat' in value) return { lon: Number(value.lon), lat: Number(value.lat) };
  }
  throw new ExtractError('Parquet: unsupported GeoArrow point value');
}

export function isPointEncoding(encoding) {
  const e = String(encoding || '').toLowerCase();
  return e === 'wkb' || e === 'point' || e === 'geoarrow.point' || e === 'geoarrow_point';
}

