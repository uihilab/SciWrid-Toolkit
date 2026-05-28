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
const ProjCoordTransGeoKey      = 3075;  // CT code (e.g. 1=Transverse Mercator, 8=LCC_2SP, 24=Sinusoidal)
const ProjLinearUnitsGeoKey     = 3076;
const ProjStdParallel1GeoKey    = 3078;
const ProjStdParallel2GeoKey    = 3079;
const ProjNatOriginLongGeoKey   = 3080;
const ProjNatOriginLatGeoKey    = 3081;
const ProjFalseEastingGeoKey    = 3082;
const ProjFalseNorthingGeoKey   = 3083;
const ProjFalseOriginLongGeoKey = 3084;
const ProjFalseOriginLatGeoKey  = 3085;
const ProjCenterLongGeoKey      = 3088;
const ProjCenterLatGeoKey       = 3089;

// Lookup helper: GeoKey values that reference GeoDoubleParams come back as
// arrays; plain integers stored in the directory come back as numbers. This
// flattens both shapes to a single number with a default fallback.
function scalarKey(keys, id, def) {
  const v = keys.get(id);
  if (v == null) return def;
  if (Array.isArray(v)) return v.length > 0 ? Number(v[0]) : def;
  return Number(v);
}

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
    // Polar stereographic: EPSG 3413 (NSIDC north), 3031 (south).
    if (epsg === 3413) {
      return { kind: 'polar-stereo', epsg, name: 'WGS 84 / NSIDC Sea Ice Polar Stereographic North',
               hemisphere: 'N', trueScaleLat: 70, lon0: -45,
               falseEasting: 0, falseNorthing: 0, rasterType };
    }
    if (epsg === 3031) {
      return { kind: 'polar-stereo', epsg, name: 'WGS 84 / Antarctic Polar Stereographic',
               hemisphere: 'S', trueScaleLat: -71, lon0: 0,
               falseEasting: 0, falseNorthing: 0, rasterType };
    }
    // Sinusoidal — MODIS commonly uses ProjCoordTrans=24 with user-defined PCS (epsg=32767)
    if (keys.get(ProjCoordTransGeoKey) === 24) {
      const lon0 = scalarKey(keys, ProjCenterLongGeoKey, 0);
      const fe   = scalarKey(keys, ProjFalseEastingGeoKey, 0);
      const fn   = scalarKey(keys, ProjFalseNorthingGeoKey, 0);
      // MODIS sphere radius (the de-facto convention for MODIS sinusoidal)
      const R = 6371007.181;
      return { kind: 'sinusoidal', epsg, name: 'Sinusoidal', centralMeridianDeg: lon0,
               falseEasting: fe, falseNorthing: fn, earthRadiusM: R, rasterType };
    }
    // Albers Equal Area Conic (ProjCoordTrans=11). USDA NASS CDL + USGS.
    if (keys.get(ProjCoordTransGeoKey) === 11) {
      const sp1  = scalarKey(keys, ProjStdParallel1GeoKey, 0);
      const sp2  = scalarKey(keys, ProjStdParallel2GeoKey, sp1);
      const lat0 = scalarKey(keys, ProjFalseOriginLatGeoKey,
                  scalarKey(keys, ProjNatOriginLatGeoKey, sp1));
      const lon0 = scalarKey(keys, ProjFalseOriginLongGeoKey,
                  scalarKey(keys, ProjNatOriginLongGeoKey, 0));
      const fe   = scalarKey(keys, ProjFalseEastingGeoKey, 0);
      const fn   = scalarKey(keys, ProjFalseNorthingGeoKey, 0);
      return {
        kind: 'albers', epsg,
        name: `Albers Equal Area Conic (sp1=${sp1}, sp2=${sp2})`,
        sp1, sp2, lat0, lon0,
        falseEasting: fe, falseNorthing: fn,
        rasterType,
      };
    }
    // Lambert Conformal Conic 2SP (ProjCoordTrans=8). Used heavily by
    // NOAA HRRR / RAP / NAM. Parameters come from GeoKeys 3078/3079/3084/3085/3082/3083.
    if (keys.get(ProjCoordTransGeoKey) === 8) {
      const sp1  = scalarKey(keys, ProjStdParallel1GeoKey, 0);
      const sp2  = scalarKey(keys, ProjStdParallel2GeoKey, sp1);
      // GeoTIFF spec lets the origin lat/lon live in either NatOrigin or
      // FalseOrigin keys depending on the writer; accept both.
      const lat0 = scalarKey(keys, ProjFalseOriginLatGeoKey,
                  scalarKey(keys, ProjNatOriginLatGeoKey, sp1));
      const lon0 = scalarKey(keys, ProjFalseOriginLongGeoKey,
                  scalarKey(keys, ProjNatOriginLongGeoKey, 0));
      const fe   = scalarKey(keys, ProjFalseEastingGeoKey, 0);
      const fn   = scalarKey(keys, ProjFalseNorthingGeoKey, 0);
      return {
        kind: 'lcc', epsg,
        name: `Lambert Conformal Conic (sp1=${sp1}, sp2=${sp2})`,
        sp1, sp2, lat0, lon0,
        falseEasting: fe, falseNorthing: fn,
        rasterType,
      };
    }
    throw new UnsupportedCRSError(`Projected CRS EPSG:${epsg} not supported in v1`,
      { epsg, crsName: 'unknown projected' });
  }

  throw new UnsupportedCRSError(`GTModelType ${modelType} not supported in v1`, { epsg: null });
}
