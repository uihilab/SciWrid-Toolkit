// lib/tiff/projections.js
//
// Forward and inverse projection math for v1's supported CRS set.
// Each forward takes ({ lat, lon }, geo) and returns { x, y } in the
// projection's linear/angular units (matching the tiepoint/scale tags).

const DEG = Math.PI / 180;
const A   = 6378137;          // WGS84 semi-major axis (m)
const E2  = 0.00669437999014; // WGS84 first eccentricity squared
const K0  = 0.9996;

function utmForward(lat, lon, geo) {
  const phi    = lat * DEG;
  const lambda = lon * DEG;
  const lambda0 = ((geo.zone - 1) * 6 - 177) * DEG;
  const N  = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const T  = Math.tan(phi) ** 2;
  const C  = (E2 / (1 - E2)) * Math.cos(phi) ** 2;
  const ALo = (lambda - lambda0) * Math.cos(phi);
  const M  = A * (
    (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi)
  );
  const x = K0 * N * (ALo + (1 - T + C) * ALo ** 3 / 6
            + (5 - 18 * T + T ** 2 + 72 * C - 58 * (E2 / (1 - E2))) * ALo ** 5 / 120) + 500000;
  const y = K0 * (M + N * Math.tan(phi) * (ALo ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * ALo ** 4 / 24
            + (61 - 58 * T + T ** 2 + 600 * C - 330 * (E2 / (1 - E2))) * ALo ** 6 / 720))
            + (geo.hemisphere === 'S' ? 10000000 : 0);
  return { x, y };
}

function utmInverse(x, y, geo) {
  const e1   = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const lambda0 = ((geo.zone - 1) * 6 - 177) * DEG;
  const xx = x - 500000;
  const yy = y - (geo.hemisphere === 'S' ? 10000000 : 0);
  const M  = yy / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
                  + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
                  + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const C1  = (E2 / (1 - E2)) * Math.cos(phi1) ** 2;
  const T1  = Math.tan(phi1) ** 2;
  const N1  = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const R1  = A * (1 - E2) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const D   = xx / (N1 * K0);
  const phi = phi1 - (N1 * Math.tan(phi1) / R1) * (
    D ** 2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * (E2 / (1 - E2))) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * (E2 / (1 - E2)) - 3 * C1 ** 2) * D ** 6 / 720
  );
  const lambda = lambda0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * (E2 / (1 - E2)) + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(phi1);
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
    case 'sinusoidal': return sinusoidalForward(lat, lon, geo);
    default: throw new Error(`projections: unknown kind ${geo.kind}`);
  }
}

export function nativeToLatLon({ x, y }, geo) {
  switch (geo.kind) {
    case 'geographic': return { lat: y, lon: x };
    case 'utm':        return utmInverse(x, y, geo);
    case 'sinusoidal': return sinusoidalInverse(x, y, geo);
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
