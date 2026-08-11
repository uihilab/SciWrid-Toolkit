const DEFAULT_TOL = 1e-9;

function asNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return Math.round(v.getTime() / 1000);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.round(ms / 1000) : NaN;
  }
  return Number(v);
}

export function normalizeTimeValue(v) {
  const n = asNumber(v);
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) > 1e17) return Math.round(n / 1e9);
  if (Math.abs(n) > 1e14) return Math.round(n / 1e6);
  if (Math.abs(n) > 1e11) return Math.round(n / 1e3);
  return Math.round(n);
}

export function isoTimes(seconds) {
  return {
    values: seconds.map(s => new Date(s * 1000).toISOString().replace('.000Z', 'Z')),
    unitsRaw: 'seconds since 1970-01-01',
    calendar: 'standard',
  };
}

export function groupTimes(rawTimes, rowCount) {
  const values = rawTimes ? rawTimes.map(normalizeTimeValue) : new Array(rowCount).fill(0);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  const index = new Map(unique.map((v, i) => [v, i]));
  const frames = values.map(v => index.get(v));
  return { times: unique, frames };
}

function uniqueSorted(values, desc = false, tol = DEFAULT_TOL) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  if (desc) out.reverse();
  return out;
}

function nearestAxisIndex(axis, value, tol = DEFAULT_TOL) {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - value);
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

export function classifyGrid(lat, lon, frames, nt, tol = DEFAULT_TOL, occupancyThreshold = 0.5) {
  const lats = uniqueSorted(lat, true, tol);
  const lons = uniqueSorted(lon, false, tol);
  const nx = lons.length;
  const ny = lats.length;
  if (!nx || !ny) return { gridType: 'point', lats, lons, occupancy: 0 };
  const pairs = new Set();
  const byFrame = Array.from({ length: nt }, () => new Set());
  let duplicate = false;
  for (let i = 0; i < lat.length; i++) {
    const iy = nearestAxisIndex(lats, Number(lat[i]), tol);
    const ix = nearestAxisIndex(lons, Number(lon[i]), tol);
    const key = iy + ',' + ix;
    pairs.add(key);
    const f = frames[i] ?? 0;
    if (byFrame[f].has(key)) duplicate = true;
    byFrame[f].add(key);
  }
  const occupancy = pairs.size / (nx * ny);
  const gridType = !duplicate && occupancy >= occupancyThreshold ? 'mesh' : 'point';
  return { gridType, lats, lons, occupancy, duplicate };
}

export function pivotMesh(lat, lon, values, frames, nt, lats, lons, tol = DEFAULT_TOL) {
  const ny = lats.length;
  const nx = lons.length;
  const out = new Float32Array(nt * ny * nx);
  out.fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const f = frames[i] ?? 0;
    const iy = nearestAxisIndex(lats, Number(lat[i]), tol);
    const ix = nearestAxisIndex(lons, Number(lon[i]), tol);
    out[f * ny * nx + iy * nx + ix] = Number(values[i]);
  }
  return out;
}

export function rasterizeMeanBin(lat, lon, values, frames, frameIndex, bbox, width, height) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const sums = new Float64Array(width * height);
  const counts = new Uint32Array(width * height);
  const out = new Float32Array(width * height);
  out.fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if ((frames[i] ?? 0) !== frameIndex) continue;
    const la = Number(lat[i]);
    const lo = Number(lon[i]);
    const v = Number(values[i]);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(v)) continue;
    if (lo < minLon || lo > maxLon || la < minLat || la > maxLat) continue;
    const c = Math.min(width - 1, Math.max(0, Math.floor((lo - minLon) / (maxLon - minLon) * width)));
    const r = Math.min(height - 1, Math.max(0, Math.floor((maxLat - la) / (maxLat - minLat) * height)));
    const k = r * width + c;
    sums[k] += v;
    counts[k]++;
  }
  for (let i = 0; i < out.length; i++) if (counts[i]) out[i] = sums[i] / counts[i];
  return out;
}

export function nearestPointSeries(lat, lon, values, frames, nt, targetLat, targetLon) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lat.length; i++) {
    const dlat = Number(lat[i]) - Number(targetLat);
    const dlon = Number(lon[i]) - Number(targetLon);
    const d = dlat * dlat + dlon * dlon;
    if (d < bestD) { bestD = d; best = i; }
  }
  const out = new Float32Array(nt);
  out.fill(NaN);
  if (best < 0) return out;
  const staLat = Number(lat[best]);
  const staLon = Number(lon[best]);
  for (let i = 0; i < lat.length; i++) {
    if (Math.abs(Number(lat[i]) - staLat) < 1e-9 && Math.abs(Number(lon[i]) - staLon) < 1e-9) {
      out[frames[i] ?? 0] = Number(values[i]);
    }
  }
  return out;
}

export const TOL = DEFAULT_TOL;
export { nearestAxisIndex };
