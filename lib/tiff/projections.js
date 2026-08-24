// lib/tiff/projections.js
//
// Forward and inverse projection math for v1's supported CRS set.
// Each forward takes ({ lat, lon }, geo) and returns { x, y } in the
// projection's linear/angular units (matching the tiepoint/scale tags).

const DEG = Math.PI / 180;
const A   = 6378137;          // WGS84 semi-major axis (m)
const E2  = 0.00669437999014; // WGS84 first eccentricity squared
const K0  = 0.9996;

// ── Transverse Mercator (EPSG 9807), with UTM as a parameterisation ──────
//
// UTM is transverse Mercator with four values fixed by the zone, so both live
// on one implementation. Splitting them would mean two copies of Snyder §8 to
// keep in step, and the CF `transverse_mercator` grid mapping supplies exactly
// the parameters UTM hardcodes.
//
// Geo carries (all optional; defaults reproduce UTM/WGS84):
//   lon0  — central meridian (degrees). For UTM, derived from `zone`.
//   lat0  — latitude of projection origin (degrees, default 0 as in UTM)
//   k0    — scale factor on the central meridian (default 0.9996, UTM's)
//   falseEasting / falseNorthing (metres; UTM uses 500000, and 10000000 south)
//   a, e2 — ellipsoid (default WGS84)
//   zone, hemisphere — UTM shorthand for the four values above
// Reference: Snyder, USGS PP-1395, §8.
function tmConstants(geo) {
  const isUtm = geo.zone != null;
  const a  = geo.a  ?? A;
  const e2 = geo.e2 ?? E2;
  /* A zone's central meridian is its western edge plus 3 degrees. */
  const lon0 = isUtm ? ((geo.zone - 1) * 6 - 177) : (geo.lon0 ?? 0);
  const k0   = isUtm ? K0 : (geo.scaleFactor ?? K0);
  const fe   = isUtm ? 500000 : (geo.falseEasting  ?? 0);
  const fn   = isUtm ? (geo.hemisphere === 'S' ? 10000000 : 0)
                     : (geo.falseNorthing ?? 0);
  const lat0 = isUtm ? 0 : (geo.lat0 ?? 0);
  return { a, e2, ep2: e2 / (1 - e2), lon0: lon0 * DEG, lat0: lat0 * DEG, k0, fe, fn };
}

/* Meridional arc length from the equator to phi (Snyder eq 3-21). Pulled out
 * because the general form needs it twice: once for the point and once for the
 * origin parallel, whose arc is subtracted. UTM's lat0 is 0, so its M0 is 0 --
 * which is why the original code could omit the term entirely. */
function meridionalArc(phi, a, e2) {
  return a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi)
  );
}

function tmForward(lat, lon, geo) {
  const c = tmConstants(geo);
  const { a, e2, ep2, k0 } = c;
  const phi    = lat * DEG;
  const lambda = lon * DEG;
  const N  = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T  = Math.tan(phi) ** 2;
  const C  = ep2 * Math.cos(phi) ** 2;
  const ALo = (lambda - c.lon0) * Math.cos(phi);
  const M  = meridionalArc(phi, a, e2);
  const M0 = c.lat0 === 0 ? 0 : meridionalArc(c.lat0, a, e2);
  const x = k0 * N * (ALo + (1 - T + C) * ALo ** 3 / 6
            + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * ALo ** 5 / 120) + c.fe;
  const y = k0 * (M - M0 + N * Math.tan(phi) * (ALo ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * ALo ** 4 / 24
            + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * ALo ** 6 / 720))
            + c.fn;
  return { x, y };
}

function tmInverse(x, y, geo) {
  const c = tmConstants(geo);
  const { a, e2, ep2, k0 } = c;
  const e1   = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const xx = x - c.fe;
  const yy = y - c.fn;
  const M0 = c.lat0 === 0 ? 0 : meridionalArc(c.lat0, a, e2);
  const M  = M0 + yy / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
                  + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
                  + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const C1  = ep2 * Math.cos(phi1) ** 2;
  const T1  = Math.tan(phi1) ** 2;
  const N1  = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const R1  = a * (1 - e2) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D   = xx / (N1 * k0);
  const phi = phi1 - (N1 * Math.tan(phi1) / R1) * (
    D ** 2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720
  );
  const lambda = c.lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(phi1);
  return { lat: phi / DEG, lon: lambda / DEG };
}

/* UTM keeps its own names: callers pass { kind: 'utm', zone, hemisphere } and
 * tmConstants() expands that into the general parameters. */
const utmForward = tmForward;
const utmInverse = tmInverse;

// ── Lambert Conformal Conic (EPSG 9802) ─────────────────────────────────
//
// Two-standard-parallel form. Geo carries:
//   lat0, lon0  — origin (degrees)
//   sp1, sp2    — standard parallels (degrees)
//   falseEasting, falseNorthing (metres, default 0)
//   a, e2       — ellipsoid params (default WGS84)
// Reference: Snyder, "Map Projections — A Working Manual", USGS PP-1395, §15.
function lccConstants(geo) {
  const a   = geo.a   ?? A;
  const e2  = geo.e2  ?? E2;
  const e   = Math.sqrt(e2);
  const phi0 = (geo.lat0 || 0) * DEG;
  const phi1 = (geo.sp1  || 0) * DEG;
  const phi2 = (geo.sp2  || phi1 / DEG) * DEG;
  const lambda0 = (geo.lon0 || 0) * DEG;

  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2)
                   / Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2);

  let n;
  if (Math.abs(phi1 - phi2) < 1e-12) n = Math.sin(phi1);
  else n = Math.log(m(phi1) / m(phi2)) / Math.log(t(phi1) / t(phi2));
  const F  = m(phi1) / (n * Math.pow(t(phi1), n));
  const rho0 = a * F * Math.pow(t(phi0), n);

  return { a, e, e2, n, F, rho0, phi0, lambda0,
           fe: geo.falseEasting || 0, fn: geo.falseNorthing || 0 };
}

function lccForward(lat, lon, geo) {
  const c = lccConstants(geo);
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const t = Math.tan(Math.PI / 4 - phi / 2)
          / Math.pow((1 - c.e * Math.sin(phi)) / (1 + c.e * Math.sin(phi)), c.e / 2);
  const rho   = c.a * c.F * Math.pow(t, c.n);
  const theta = c.n * (lambda - c.lambda0);
  return {
    x: c.fe + rho * Math.sin(theta),
    y: c.fn + c.rho0 - rho * Math.cos(theta),
  };
}

function lccInverse(x, y, geo) {
  const c = lccConstants(geo);
  const xx = x - c.fe;
  const yy = c.rho0 - (y - c.fn);
  const sgn = c.n >= 0 ? 1 : -1;
  const rho   = sgn * Math.sqrt(xx * xx + yy * yy);
  const theta = Math.atan2(sgn * xx, sgn * yy);
  const t = Math.pow(rho / (c.a * c.F), 1 / c.n);
  // Iteratively solve for phi (Snyder eq 15-11). 6 iterations are ample.
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const phi1 = Math.PI / 2 - 2 * Math.atan(
      t * Math.pow((1 - c.e * Math.sin(phi)) / (1 + c.e * Math.sin(phi)), c.e / 2));
    if (Math.abs(phi1 - phi) < 1e-12) { phi = phi1; break; }
    phi = phi1;
  }
  const lambda = theta / c.n + c.lambda0;
  return { lat: phi / DEG, lon: lambda / DEG };
}

// ── Polar Stereographic (ellipsoidal) ───────────────────────────────────
// Snyder §21. Geo carries:
//   hemisphere ('N' | 'S')
//   trueScaleLat — latitude of true scale (default 70 N, -71 S — matches EPSG 3413/3031)
//   lon0         — longitude of origin (default -45 for 3413, 0 for 3031)
//   falseEasting / falseNorthing (metres, default 0)
//   a, e2        — ellipsoid params (default WGS84)
function psConstants(geo) {
  const a   = geo.a   ?? A;
  const e2  = geo.e2  ?? E2;
  const e   = Math.sqrt(e2);
  const north = geo.hemisphere !== 'S';
  const phi1Default = north ? 70 : -71;       // EPSG 3413 vs 3031
  const phi1 = (geo.trueScaleLat ?? phi1Default) * DEG;
  const lon0 = (geo.lon0 ?? (north ? -45 : 0)) * DEG;
  // tF for phi1 (Snyder eq 15-9)
  const sphi1 = Math.sin(Math.abs(phi1));
  const tF = Math.tan(Math.PI / 4 - Math.abs(phi1) / 2)
           / Math.pow((1 - e * sphi1) / (1 + e * sphi1), e / 2);
  const mF = Math.cos(Math.abs(phi1)) / Math.sqrt(1 - e2 * sphi1 * sphi1);
  return { a, e, e2, phi1, lon0, tF, mF, north,
           fe: geo.falseEasting || 0, fn: geo.falseNorthing || 0 };
}

function polarStereoForward(lat, lon, geo) {
  const c = psConstants(geo);
  const phi    = lat * DEG;
  const lambda = lon * DEG;
  const sgn = c.north ? 1 : -1;
  const sphi = Math.sin(sgn * phi);
  const t = Math.tan(Math.PI / 4 - sgn * phi / 2)
          / Math.pow((1 - c.e * sphi) / (1 + c.e * sphi), c.e / 2);
  const rho = c.a * c.mF * t / c.tF;
  const x = c.fe + rho * Math.sin(lambda - c.lon0);
  const y = c.fn - sgn * rho * Math.cos(lambda - c.lon0);
  return { x, y };
}

function polarStereoInverse(x, y, geo) {
  const c = psConstants(geo);
  const xx = x - c.fe;
  const yy = y - c.fn;
  const sgn = c.north ? 1 : -1;
  const rho = Math.sqrt(xx * xx + yy * yy);
  if (rho === 0) {
    return { lat: sgn * 90, lon: c.lon0 / DEG };
  }
  const t = rho * c.tF / (c.a * c.mF);
  // Iterative solve for phi (Snyder eq 7-9).
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 12; i++) {
    const sphi = Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(
      t * Math.pow((1 - c.e * sphi) / (1 + c.e * sphi), c.e / 2));
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  const lambda = c.lon0 + Math.atan2(xx, -sgn * yy);
  return { lat: sgn * phi / DEG, lon: lambda / DEG };
}

// ── Albers Equal Area Conic ─────────────────────────────────────────────
// Snyder §14, ellipsoidal form. Same parameter shape as LCC (sp1, sp2,
// lat0, lon0). Used by USDA NASS CDL and many USGS national-extent products.
function albersConstants(geo) {
  const a   = geo.a   ?? A;
  const e2  = geo.e2  ?? E2;
  const e   = Math.sqrt(e2);
  const phi0 = (geo.lat0 || 0) * DEG;
  const phi1 = (geo.sp1  || 0) * DEG;
  const phi2 = (geo.sp2  || phi1 / DEG) * DEG;
  const lambda0 = (geo.lon0 || 0) * DEG;

  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const q = (phi) => {
    const s = Math.sin(phi);
    return (1 - e2) * (s / (1 - e2 * s * s)
      - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };

  const m1 = m(phi1), m2 = m(phi2);
  const q0 = q(phi0), q1 = q(phi1), q2 = q(phi2);
  const n = (Math.abs(phi1 - phi2) < 1e-12)
    ? Math.sin(phi1)
    : (m1 * m1 - m2 * m2) / (q2 - q1);
  const C = m1 * m1 + n * q1;
  const rho0 = a * Math.sqrt(C - n * q0) / n;

  return { a, e, e2, n, C, rho0, lambda0,
           fe: geo.falseEasting || 0, fn: geo.falseNorthing || 0 };
}

function albersForward(lat, lon, geo) {
  const c = albersConstants(geo);
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const s = Math.sin(phi);
  const q = (1 - c.e2) * (s / (1 - c.e2 * s * s)
            - (1 / (2 * c.e)) * Math.log((1 - c.e * s) / (1 + c.e * s)));
  const rho = c.a * Math.sqrt(c.C - c.n * q) / c.n;
  const theta = c.n * (lambda - c.lambda0);
  return {
    x: c.fe + rho * Math.sin(theta),
    y: c.fn + c.rho0 - rho * Math.cos(theta),
  };
}

function albersInverse(x, y, geo) {
  const c = albersConstants(geo);
  const xx = x - c.fe;
  const yy = c.rho0 - (y - c.fn);
  const sgn = c.n >= 0 ? 1 : -1;
  const rho = sgn * Math.sqrt(xx * xx + yy * yy);
  const theta = Math.atan2(sgn * xx, sgn * yy);
  const q = (c.C - (rho * c.n / c.a) ** 2) / c.n;
  // Solve q for phi (Snyder eq 3-16). Iterate from initial guess asin(q/2).
  let phi = Math.asin(q / 2);
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(phi);
    const denom = 1 - c.e2 * s * s;
    const delta = (denom * denom / (2 * Math.cos(phi))) *
      (q / (1 - c.e2) - s / denom + (1 / (2 * c.e)) * Math.log((1 - c.e * s) / (1 + c.e * s)));
    phi += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  const lambda = theta / c.n + c.lambda0;
  return { lat: phi / DEG, lon: lambda / DEG };
}

function sinusoidalForward(lat, lon, geo) {
  const phi    = lat * DEG;
  const lambda = lon * DEG;
  const lambda0 = (geo.centralMeridianDeg || 0) * DEG;
  const R = geo.earthRadiusM;
  const x = R * (lambda - lambda0) * Math.cos(phi) + (geo.falseEasting || 0);
  const y = R * phi + (geo.falseNorthing || 0);
  return { x, y };
}

function sinusoidalInverse(x, y, geo) {
  const lambda0 = (geo.centralMeridianDeg || 0) * DEG;
  const R = geo.earthRadiusM;
  const phi = (y - (geo.falseNorthing || 0)) / R;
  const lambda = lambda0 + (x - (geo.falseEasting || 0)) / (R * Math.cos(phi));
  return { lat: phi / DEG, lon: lambda / DEG };
}

export function latLonToNative({ lat, lon }, geo) {
  switch (geo.kind) {
    case 'geographic': return { x: lon, y: lat };
    case 'utm':        return utmForward(lat, lon, geo);
    case 'tmerc':      return tmForward(lat, lon, geo);
    case 'sinusoidal': return sinusoidalForward(lat, lon, geo);
    case 'lcc':        return lccForward(lat, lon, geo);
    case 'polar-stereo': return polarStereoForward(lat, lon, geo);
    case 'albers':       return albersForward(lat, lon, geo);
    default: throw new Error(`projections: unknown kind ${geo.kind}`);
  }
}

export function nativeToLatLon({ x, y }, geo) {
  switch (geo.kind) {
    case 'geographic': return { lat: y, lon: x };
    case 'utm':        return utmInverse(x, y, geo);
    case 'tmerc':      return tmInverse(x, y, geo);
    case 'sinusoidal': return sinusoidalInverse(x, y, geo);
    case 'lcc':        return lccInverse(x, y, geo);
    case 'polar-stereo': return polarStereoInverse(x, y, geo);
    case 'albers':       return albersInverse(x, y, geo);
    default: throw new Error(`projections: unknown kind ${geo.kind}`);
  }
}

export function nativeBboxToWgs84([minX, minY, maxX, maxY], geo) {
  if (geo.kind === 'geographic') return [minX, minY, maxX, maxY];
  const corners = [
    nativeToLatLon({ x: minX, y: minY }, geo),
    nativeToLatLon({ x: minX, y: maxY }, geo),
    nativeToLatLon({ x: maxX, y: minY }, geo),
    nativeToLatLon({ x: maxX, y: maxY }, geo),
  ];
  return [
    Math.min(...corners.map(c => c.lon)),
    Math.min(...corners.map(c => c.lat)),
    Math.max(...corners.map(c => c.lon)),
    Math.max(...corners.map(c => c.lat)),
  ];
}
