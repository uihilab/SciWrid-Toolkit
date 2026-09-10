/*
 * lib/netcdf/cf-grid-mapping.js
 *
 * CF grid_mapping -> the `geo` descriptor that lib/tiff/projections.js speaks.
 *
 * A NetCDF file on a projected grid does not carry latitude and longitude. It
 * carries `x` / `y` axes in metres plus a container variable -- named by each
 * data variable's `grid_mapping` attribute -- whose attributes describe the
 * projection. NWS/NCEP precipitation grids are the common case here:
 *
 *   x: units="Meter"  standard_name="projection_x_coordinate"
 *   crs: grid_mapping_name="polar_stereographic"
 *        straight_vertical_longitude_from_pole=-105
 *        standard_parallel=60  latitude_of_projection_origin=90
 *        earth_radius=6371200
 *
 * Read as degrees, an x of -1902530 is not a longitude that can be clamped
 * back into range -- it is 1902 km west of the projection origin, and the only
 * way back is the inverse projection. This module builds the parameter block
 * that inverse needs; lib/tiff/projections.js already has the math.
 *
 * Scope: the projections that projections.js implements AND that appear with a
 * CF grid_mapping_name. `latitude_longitude` maps to the identity ('geographic')
 * so callers can treat every file the same way.
 */

/* CF grid mappings we can NAME but not invert. Listing them separately from
 * "unknown" buys a specific message, and for the rotated pole it buys much
 * more than that: its axes are DEGREES in ordinary geographic range, so no
 * range check can flag them. A rotated-pole grid read as plain lat/lon yields
 * coordinates that look entirely reasonable and point at the wrong continent.
 * Being able to say so is the difference between a gap and a wrong answer. */
const CF_KNOWN_UNSUPPORTED = {
  rotated_latitude_longitude:
    'rotated pole grids need a spherical pole rotation, which this build does not implement; ' +
    'rlat/rlon are degrees about a shifted pole, NOT latitude and longitude',
  geostationary:            'geostationary (GOES/Meteosat) scan-angle geometry is not implemented',
  lambert_azimuthal_equal_area: 'Lambert azimuthal equal area (EASE-Grid) is not implemented',
  mercator:                 'Mercator is not implemented',
  stereographic:            'oblique/equatorial stereographic is not implemented (polar is)',
  azimuthal_equidistant:    'azimuthal equidistant is not implemented',
  orthographic:             'orthographic is not implemented',
  vertical_perspective:     'vertical perspective is not implemented',
  lambert_cylindrical_equal_area: 'Lambert cylindrical equal area is not implemented',
  oblique_mercator:         'oblique Mercator is not implemented',
};

/* CF §5.6 grid_mapping_name -> projections.js `kind`. A name that is absent
 * here is a projection whose math we do not have; detectProjection() reports it
 * by name rather than silently pretending the axes are degrees. */
const CF_KIND = {
  latitude_longitude:          'geographic',
  polar_stereographic:         'polar-stereo',
  lambert_conformal_conic:     'lcc',
  albers_conical_equal_area:   'albers',
  sinusoidal:                  'sinusoidal',
  transverse_mercator:         'tmerc',
};

/* CF allows a scalar attribute to arrive as a number, a length-1 array, or --
 * through h5wasm -- an object keyed by index. standard_parallel is the awkward
 * one: for LCC and Albers it may legitimately hold TWO values. */
function attrNums(raw) {
  if (raw == null) return [];
  const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  if (typeof v === 'number') return [v];
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? [n] : [];
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, Number).filter(Number.isFinite);
  if (typeof v === 'object') {
    /* h5wasm hands back { "0": -105 } for a length-1 numeric attribute. Sort
     * the keys numerically so a two-element standard_parallel keeps its order. */
    const keys = Object.keys(v).filter(k => /^\d+$/.test(k)).sort((p, q) => p - q);
    return keys.map(k => Number(v[k])).filter(Number.isFinite);
  }
  return [];
}

const num  = (raw, dflt = undefined) => { const a = attrNums(raw); return a.length ? a[0] : dflt; };
const text = (raw) => {
  if (raw == null) return '';
  const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return typeof v === 'string' ? v : String(v ?? '');
};

/**
 * Earth figure from CF attributes.
 *
 * `earth_radius` means a sphere, and a sphere is not a rounding of WGS84 here:
 * the HRAP grid's 6371200 m sphere differs from WGS84 by up to ~20 km at mid
 * latitudes, several grid cells. Defaulting a missing figure to WGS84 is
 * correct per CF, which names WGS84 as the default ellipsoid.
 */
function earthFrom(attrs, get) {
  const r  = num(get(attrs, 'earth_radius'));
  if (r != null) return { a: r, e2: 0 };              // sphere: eccentricity 0

  const a  = num(get(attrs, 'semi_major_axis'));
  const b  = num(get(attrs, 'semi_minor_axis'));
  const rf = num(get(attrs, 'inverse_flattening'));
  if (a != null && b != null) return { a, e2: 1 - (b * b) / (a * a) };
  if (a != null && rf != null && rf !== 0) {
    const f = 1 / rf;
    return { a, e2: f * (2 - f) };
  }
  if (a != null) return { a, e2: 0 };
  return {};                                          // let projections.js default to WGS84
}

/**
 * Build a projections.js `geo` from a CF grid-mapping variable's attributes.
 *
 * @param {object} attrs  the grid-mapping variable's attribute bag
 * @param {(attrs:object, name:string)=>*} get  reads one attribute (the caller
 *        owns this because h5wasm, NetCDF3 and Zarr each wrap values differently)
 * @returns {{geo:object|null, name:string, reason?:string}}
 */
export function geoFromGridMapping(attrs, get) {
  const gmName = text(get(attrs, 'grid_mapping_name')).toLowerCase().trim();
  if (!gmName) return { geo: null, name: '', reason: 'no grid_mapping_name attribute' };

  const kind = CF_KIND[gmName];
  if (!kind) {
    const known = CF_KNOWN_UNSUPPORTED[gmName];
    return { geo: null, name: gmName,
             reason: known
               ? `grid_mapping_name '${gmName}': ${known}`
               : `grid_mapping_name '${gmName}' is not one of the projections ` +
                 `this build can invert (${Object.keys(CF_KIND).join(', ')})` };
  }

  if (kind === 'geographic') return { geo: { kind: 'geographic' }, name: gmName };

  const earth = earthFrom(attrs, get);
  const fe = num(get(attrs, 'false_easting'),  0);
  const fn = num(get(attrs, 'false_northing'), 0);
  const sp = attrNums(get(attrs, 'standard_parallel'));

  if (kind === 'polar-stereo') {
    /* CF names the central meridian `straight_vertical_longitude_from_pole`
     * here, not `longitude_of_central_meridian`. */
    const lon0 = num(get(attrs, 'straight_vertical_longitude_from_pole'))
              ?? num(get(attrs, 'longitude_of_projection_origin'), 0);
    const latOrigin = num(get(attrs, 'latitude_of_projection_origin'), 90);
    /* Scale-factor form (scale_factor_at_projection_origin) is the alternative
     * to a standard parallel; projections.js takes a true-scale latitude, so a
     * file giving only the scale factor is reported rather than mis-converted. */
    const trueScale = sp.length ? sp[0]
                    : num(get(attrs, 'latitude_of_standard_parallel'));
    if (trueScale == null)
      return { geo: null, name: gmName,
               reason: 'polar_stereographic without standard_parallel is not supported ' +
                       '(scale_factor_at_projection_origin form)' };
    return {
      geo: { kind, hemisphere: latOrigin < 0 ? 'S' : 'N', trueScaleLat: trueScale,
             lon0, falseEasting: fe, falseNorthing: fn, ...earth },
      name: gmName,
    };
  }

  if (kind === 'lcc' || kind === 'albers') {
    const lon0 = num(get(attrs, 'longitude_of_central_meridian'))
              ?? num(get(attrs, 'longitude_of_projection_origin'), 0);
    const lat0 = num(get(attrs, 'latitude_of_projection_origin'), 0);
    /* One standard parallel is the tangent case: both parallels equal. */
    const sp1 = sp.length ? sp[0] : lat0;
    const sp2 = sp.length > 1 ? sp[1] : sp1;
    return {
      geo: { kind, lat0, lon0, sp1, sp2, falseEasting: fe, falseNorthing: fn, ...earth },
      name: gmName,
    };
  }

  if (kind === 'tmerc') {
    /* CF names the scale factor `scale_factor_at_central_meridian`; the
     * `_at_projection_origin` spelling belongs to other mappings but appears in
     * the wild here too, so both are read. A missing scale factor defaults to
     * 1, NOT to UTM's 0.9996 -- 0.9996 is a property of the UTM system, and
     * assuming it for a plain transverse Mercator would shrink every distance
     * by 400 ppm (~400 m across a 1000 km grid). */
    const lon0 = num(get(attrs, 'longitude_of_central_meridian'))
              ?? num(get(attrs, 'longitude_of_projection_origin'), 0);
    const k0 = num(get(attrs, 'scale_factor_at_central_meridian'))
            ?? num(get(attrs, 'scale_factor_at_projection_origin'), 1);
    return {
      geo: {
        kind, lon0, lat0: num(get(attrs, 'latitude_of_projection_origin'), 0),
        scaleFactor: k0, falseEasting: fe, falseNorthing: fn, ...earth,
      },
      name: gmName,
    };
  }

  /* sinusoidal — projections.js takes a radius and central meridian directly */
  return {
    geo: {
      kind,
      centralMeridianDeg: num(get(attrs, 'longitude_of_projection_origin'), 0),
      earthRadiusM: earth.a ?? 6371007.181,     // MODIS sinusoidal sphere
      falseEasting: fe, falseNorthing: fn,
    },
    name: gmName,
  };
}

/* Axis units that mean "linear distance", i.e. definitely not degrees. */
const LINEAR_UNITS = new Set(['m', 'meter', 'meters', 'metre', 'metres',
                              'km', 'kilometer', 'kilometers', 'kilometre', 'kilometres']);

/** Metres per unit for a linear axis, so km axes scale into the CRS's metres. */
export function linearScale(units) {
  const u = String(units || '').toLowerCase().trim();
  return u.startsWith('km') || u.startsWith('kilomet') ? 1000 : 1;
}

/**
 * Decide whether a pair of axes is projected rather than geographic.
 *
 * Three signals, strongest first. The explicit CF markers are checked before
 * the value range because they are declarations rather than inferences -- a
 * regional grid in metres can easily hold x values that look like plausible
 * longitudes, and a global grid in degrees is not projected however its numbers
 * happen to fall.
 *
 * The range check is the backstop the CF markers cannot provide: a file whose
 * axes are metres but which forgot `standard_name` and `units` still gives
 * itself away, because a latitude outside +-90 or a longitude outside +-360 is
 * not a coordinate any convention produces.
 *
 * @returns {{projected:boolean, why:string, outOfRange:boolean}}
 */
export function detectProjection({ latStd, lonStd, latUnits, lonUnits, latMin, latMax, lonMin, lonMax }) {
  const std = (s) => String(s || '').toLowerCase().trim();
  if (std(latStd) === 'projection_y_coordinate' || std(lonStd) === 'projection_x_coordinate')
    return { projected: true, outOfRange: false,
             why: 'axes declare standard_name projection_x/y_coordinate' };

  /* Rotated pole. Checked here and not left to the range test because it CANNOT
   * be caught by range: grid_latitude/grid_longitude are degrees, and a regional
   * domain's values sit comfortably inside +-90/+-180. The standard_name is the
   * only thing that distinguishes them from real coordinates. */
  if (std(latStd) === 'grid_latitude' || std(lonStd) === 'grid_longitude')
    return { projected: true, outOfRange: false,
             why: 'axes declare standard_name grid_latitude/grid_longitude ' +
                  '(rotated pole -- degrees about a shifted pole, not lat/lon)' };

  const lu = String(latUnits || '').toLowerCase().trim();
  const xu = String(lonUnits || '').toLowerCase().trim();
  if (LINEAR_UNITS.has(lu) || LINEAR_UNITS.has(xu))
    return { projected: true, outOfRange: false,
             why: `axis units are linear ('${latUnits || lonUnits}'), not degrees` };

  /* Backstop: values that cannot be degrees whatever the metadata claims. */
  const badLat = Number.isFinite(latMin) && Number.isFinite(latMax) &&
                 (Math.abs(latMin) > 90.0001 || Math.abs(latMax) > 90.0001);
  const badLon = Number.isFinite(lonMin) && Number.isFinite(lonMax) &&
                 (Math.abs(lonMin) > 360.0001 || Math.abs(lonMax) > 360.0001);
  if (badLat || badLon)
    return {
      projected: true, outOfRange: true,
      why: `axis values are outside geographic range (` +
           (badLat ? `lat ${latMin}..${latMax} exceeds +-90` : '') +
           (badLat && badLon ? '; ' : '') +
           (badLon ? `lon ${lonMin}..${lonMax} exceeds +-360` : '') + ')',
    };

  return { projected: false, outOfRange: false, why: '' };
}
