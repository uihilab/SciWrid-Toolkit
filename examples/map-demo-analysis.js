// examples/map-demo-analysis.js — pure helpers for the "Show analysis" panel.
// DOM-free helpers for stats, spatial transects, and extracted time series.

export function computeStats(values) {
  const finite = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) finite.push(v);
  const n = finite.length;
  if (n === 0) return { n: 0, min: null, max: null, mean: null, std: null };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of finite) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  let sq = 0;
  for (const v of finite) sq += (v - mean) ** 2;
  return { n, min, max, mean, std: Math.sqrt(sq / n) };
}

const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));
function toIndex(frac, n) {
  if (n <= 1) return 0;
  return clampIdx(Math.round(frac * (n - 1)), n);
}

export function seriesFromGrid(grid, { lat, lon, axis = 'lon' } = {}) {
  const { data, width, height, bbox } = grid;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  const at = (iy, ix) => data[iy * width + ix];

  if (axis === 'lat') {
    const ix = toIndex(lonSpan === 0 ? 0 : (lon - minLon) / lonSpan, width);
    const xs = [], ys = [];
    for (let iy = height - 1; iy >= 0; iy--) {
      const frac = height <= 1 ? 0 : iy / (height - 1);
      xs.push(maxLat - frac * latSpan);
      ys.push(at(iy, ix));
    }
    return { xs, ys, xLabel: 'Latitude (°N)' };
  }

  const iy = toIndex(latSpan === 0 ? 0 : (maxLat - lat) / latSpan, height);
  const xs = [], ys = [];
  for (let ix = 0; ix < width; ix++) {
    const frac = width <= 1 ? 0 : ix / (width - 1);
    xs.push(minLon + frac * lonSpan);
    ys.push(at(iy, ix));
  }
  return { xs, ys, xLabel: 'Longitude (°E)' };
}

export function seriesFromTimeseries(points) {
  const xs = [], ys = [];
  for (const p of points ?? []) {
    xs.push(p.time);
    ys.push(typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : NaN);
  }
  return { xs, ys, xLabel: 'Time (UTC)' };
}