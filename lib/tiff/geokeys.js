// lib/tiff/geokeys.js
//
// Parse the GeoKey directory (tag 34735) and resolve the CRS into one of
//   { kind: 'geographic', epsg: 4326, name: 'WGS 84' }
//   { kind: 'utm', epsg, zone, hemisphere }
//   { kind: 'sinusoidal', epsg, centralMeridianDeg, falseEasting, falseNorthing,
//     earthRadiusM }
// or throw UnsupportedCRSError with the EPSG.

import { UnsupportedCRSError } from './errors.js';

// GeoKey IDs we use
const GTModelTypeGeoKey         = 1024;  // 1 projected, 2 geographic, 3 geocentric
const GTRasterTypeGeoKey        = 1025;  // 1 pixel-is-area, 2 pixel-is-point
const GeographicTypeGeoKey      = 2048;  // EPSG GCS code (e.g. 4326)
const ProjectedCSTypeGeoKey     = 3072;  // EPSG PCS code (e.g. 32615)
const ProjCoordTransGeoKey      = 3075;  // CT code (e.g. 1=Transverse Mercator, 24=Sinusoidal)
const ProjFalseEastingGeoKey    = 3082;
const ProjFalseNorthingGeoKey   = 3083;
const ProjCenterLongGeoKey      = 3088;
const ProjLinearUnitsGeoKey     = 3076;

// EPSG → UTM zone/hemisphere lookup
function utmFromEpsg(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, hemisphere: 'N' };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, hemisphere: 'S' };
  return null;
}

export function parseGeoKeys(tags) {
  const dir = tags.get(34735)?.values;
  if (!dir) throw new UnsupportedCRSError('tiff: no GeoKeyDirectory (tag 34735)');
  const doubles = tags.get(34736)?.values || [];
  const ascii   = tags.get(34737)?.values || [];

  // Header: [kvRev, minor, count, numKeys]; then 4*numKeys shorts
  const numKeys = dir[3];
  const keys = new Map();
  for (let i = 0; i < numKeys; i++) {
    const off = 4 + i * 4;
    const keyId         = dir[off];
    const tiffTagRef    = dir[off + 1];
    const count         = dir[off + 2];
    const valueOrOff    = dir[off + 3];
    let value;
    if (tiffTagRef === 0)              value = valueOrOff;
    else if (tiffTagRef === 34736)     value = doubles.slice(valueOrOff, valueOrOff + count);
    else if (tiffTagRef === 34737)     value = String.fromCharCode(...ascii.slice(valueOrOff, valueOrOff + count));
    keys.set(keyId, value);
  }

  const modelType  = keys.get(GTModelTypeGeoKey);
  const rasterType = keys.get(GTRasterTypeGeoKey) ?? 1;   // default pixel-is-area

  if (modelType === 2) {
    const epsg = keys.get(GeographicTypeGeoKey);
    if (epsg !== 4326)
      throw new UnsupportedCRSError(`Geographic CRS EPSG:${epsg} not supported in v1`, { epsg, crsName: 'unknown geographic' });
    return { kind: 'geographic', epsg: 4326, name: 'WGS 84', rasterType };
  }

  if (modelType === 1) {
    const epsg = keys.get(ProjectedCSTypeGeoKey);
    const utm = utmFromEpsg(epsg);
    if (utm) {
      return { kind: 'utm', epsg, name: `UTM zone ${utm.zone}${utm.hemisphere}`, zone: utm.zone, hemisphere: utm.hemisphere, rasterType };
    }
    // Sinusoidal — MODIS commonly uses ProjCoordTrans=24 with user-defined PCS (epsg=32767)
    if (keys.get(ProjCoordTransGeoKey) === 24) {
      const lon0 = (keys.get(ProjCenterLongGeoKey)?.[0]) ?? 0;
      const fe   = (keys.get(ProjFalseEastingGeoKey)?.[0]) ?? 0;
      const fn   = (keys.get(ProjFalseNorthingGeoKey)?.[0]) ?? 0;
      // MODIS sphere radius (the de-facto convention for MODIS sinusoidal)
      const R = 6371007.181;
      return { kind: 'sinusoidal', epsg, name: 'Sinusoidal', centralMeridianDeg: lon0,
               falseEasting: fe, falseNorthing: fn, earthRadiusM: R, rasterType };
    }
    throw new UnsupportedCRSError(`Projected CRS EPSG:${epsg} not supported in v1`,
      { epsg, crsName: 'unknown projected' });
  }

  throw new UnsupportedCRSError(`GTModelType ${modelType} not supported in v1`, { epsg: null });
}
