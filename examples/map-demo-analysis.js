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
/* ── x scale ────────────────────────────────────────────────────────────── */
// Project x values onto a real number line: numbers pass through, ISO timestamps
// become epoch ms, anything else falls back to array indices for the WHOLE series
// so a chart never mixes two scales.
//
// The ISO guard is load-bearing, NOT belt-and-braces: Date.parse is a lenient
// scavenger, not a validator. Date.parse('step 0') returns 946706400000 (the year
// 2000) rather than NaN, and 'step 1'/'step 2' land in 2001 - so without this
// regex the synthetic "step N" labels that populateTimePicker generates would be
// plotted at hallucinated dates spanning years, producing a plausible-looking
// chart made of fiction.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

const parseX = (x) => {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && ISO_LIKE.test(x)) return Date.parse(x);
  return NaN;
};

export function numericXs(xs) {
  const out = (xs ?? []).map(parseX);
  return out.every(Number.isFinite) ? out : (xs ?? []).map((_, i) => i);
}

/* ── chart ─────────────────────────────────────────────────────────────── */
const PAD = { top: 10, right: 12, bottom: 26, left: 46 };
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function defaultFmt(v) { if (!Number.isFinite(v)) return '–'; const a=Math.abs(v); if (a!==0&&(a<1e-3||a>=1e5)) return v.toExponential(2); return v.toFixed(2); }
// The chart's coordinate system, computed once and shared by the renderer and the
// hover layer. Extracted so the tracking dot rides on EXACTLY the projection that
// drew the line — recomputing it separately is how a dot ends up floating off it.
export function chartScale(seriesOrList, opts = {}) {
  const list = (Array.isArray(seriesOrList) ? seriesOrList : [seriesOrList]).filter(Boolean);
  const width = opts.width ?? 480, height = opts.height ?? 180;
  const plotW = width - PAD.left - PAD.right, plotH = height - PAD.top - PAD.bottom;
  const plot = { left: PAD.left, top: PAD.top, w: plotW, h: plotH };

  // One scale decision for the whole chart: if ANY series has unparseable x, every
  // series falls back to indices, so the chart never mixes two scales.
  const raw = list.map((s) => (s.xs ?? []).map(parseX));
  const allNumeric = raw.length > 0 && raw.every((r) => r.every(Number.isFinite));
  const nxs = allNumeric ? raw : list.map((s) => (s.xs ?? []).map((_, i) => i));

  const allY = list.flatMap((s) => s.ys ?? []).filter(Number.isFinite);
  const allX = nxs.flat().filter(Number.isFinite);
  if (!allY.length || !allX.length) return { ok: false, list, nxs, width, height, plot };

  const xmin = Math.min(...allX), xmax = Math.max(...allX);
  const xspan = xmax - xmin;
  let vmin = Math.min(...allY), vmax = Math.max(...allY);
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  const padY = (vmax - vmin) * 0.05; vmin -= padY; vmax += padY;

  const px = (x) => (xspan === 0 ? PAD.left + plotW / 2 : PAD.left + ((x - xmin) / xspan) * plotW);
  const py = (v) => PAD.top + plotH - ((v - vmin) / (vmax - vmin)) * plotH;

  return { ok: true, list, nxs, xmin, xmax, xspan, vmin, vmax, width, height, plot, px, py };
}

export function renderChartSVG(seriesOrList, opts = {}) {
  const sc = chartScale(seriesOrList, opts);
  const { list, nxs, plot } = sc;
  const width = sc.width, height = sc.height;
  const formatX = opts.formatX ?? ((x) => String(x)), formatY = opts.formatY ?? defaultFmt;
  const plotW = plot.w, plotH = plot.h;
  const frame =
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + plotH}" class="ac-axis"/>` +
    `<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}" class="ac-axis"/>`;
  const open = `<svg viewBox="0 0 ${width} ${height}" class="ac-svg" role="img">`;
  const note = (t) => `<text x="${width / 2}" y="${height / 2}" class="ac-note" text-anchor="middle">${esc(t)}</text>`;

  if (!sc.ok) return open + frame + note('no data to plot') + '</svg>';

  const { xmin, xmax, xspan, vmin, vmax, px, py } = sc;

  const marks = list.map((s, si) => {
    const slot = s.slot ?? si;
    const nx = nxs[si], ys = s.ys ?? [];
    const runs = []; let run = [];
    ys.forEach((v, i) => {
      if (Number.isFinite(v) && Number.isFinite(nx[i])) run.push(`${px(nx[i]).toFixed(2)},${py(v).toFixed(2)}`);
      else { if (run.length) runs.push(run); run = []; }
    });
    if (run.length) runs.push(run);
    return runs.map((r) => (r.length === 1
      ? `<circle cx="${r[0].split(',')[0]}" cy="${r[0].split(',')[1]}" r="2.5" class="ac-dot ac-s${slot}"/>`
      : `<polyline points="${r.join(' ')}" class="ac-line ac-s${slot}"/>`)).join('');
  }).join('');

  // Tick labels come from the ORIGINAL x values at the domain endpoints, which may
  // belong to different series once several are overlaid.
  const pairs = list.flatMap((s, si) => (s.xs ?? []).map((x, i) => ({ x, n: nxs[si][i] })))
                    .filter((p) => Number.isFinite(p.n));
  const loX = pairs.reduce((a, b) => (b.n < a.n ? b : a));
  const hiX = pairs.reduce((a, b) => (b.n > a.n ? b : a));
  const xLabel = list[0]?.xLabel ?? '';

  const yTicks =
    `<text x="${PAD.left - 5}" y="${PAD.top + 4}" class="ac-tick" text-anchor="end">${esc(formatY(vmax))}</text>` +
    `<text x="${PAD.left - 5}" y="${PAD.top + plotH}" class="ac-tick" text-anchor="end">${esc(formatY(vmin))}</text>`;
  const xTicks =
    `<text x="${PAD.left}" y="${height - 12}" class="ac-tick" text-anchor="start">${esc(formatX(loX.x))}</text>` +
    (xspan > 0
      ? `<text x="${PAD.left + plotW}" y="${height - 12}" class="ac-tick" text-anchor="end">${esc(formatX(hiX.x))}</text>`
      : '');
  const axisTitle =
    `<text x="${PAD.left + plotW / 2}" y="${height - 1}" class="ac-tick" text-anchor="middle">${esc(xLabel)}</text>`;

  // Empty hover layer, appended last so its marks sit above the lines. The panel
  // fills it on mousemove by DOM rather than re-rendering: a 4-series transect is
  // thousands of points, and rebuilding that string every mousemove janks.
  return open + frame + marks + yTicks + xTicks + axisTitle + '<g class="ac-hover"></g>' + '</svg>';
}

/* ── multi-file join ────────────────────────────────────────────────────── */
// Files join on a non-empty intersection of EXACT variable names. Identical sets
// is the wrong rule: GFS f000 (37 vars) is a strict subset of f003 (45) because
// accumulated/derived fields do not exist at forecast hour 0, so a set-equality
// rule would reject our own bundled example. `current === null` means nothing is
// loaded yet, so the incoming file establishes the set.
export function intersectNames(current, incoming) {
  const inc = new Set(incoming ?? []);
  if (current == null) return [...inc];
  return [...new Set(current)].filter((n) => inc.has(n));
}

// Index of the value closest to x - used by the hover crosshair to snap to a sample.
export function nearestIndex(nx, x) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < nx.length; i++) {
    const d = Math.abs(nx[i] - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* ?? units ??????????????????????????????????????????????????????????????? */
export const GRIB2_UNITS = {
  'Temperature': 'K', 'Pressure': 'Pa', 'Pressure reduced to MSL': 'Pa',
  'Surface pressure': 'Pa', 'Geopotential height': 'gpm',
  'U-component of wind': 'm/s', 'V-component of wind': 'm/s',
  'Relative humidity': '%', 'Specific humidity': 'kg/kg', 'Precipitable water': 'kg/m^2',
};
export function resolveUnit(v) { if (typeof v?.units === 'string' && v.units.trim()) return v.units; return GRIB2_UNITS[v?.name] || null; }
function normUnit(u) {
  const s=String(u??'').toLowerCase().replace(/\s+/g,'').replace(/\^/g,'');
  const m={k:'K','?c':'degC',degc:'degC',c:'degC',celsius:'degC','?f':'degF',degf:'degF',f:'degF',fahrenheit:'degF',pa:'Pa',pascal:'Pa',pascals:'Pa',hpa:'hPa',mb:'hPa',mbar:'hPa',millibar:'hPa',millibars:'hPa',kpa:'kPa','m/s':'m/s','ms-1':'m/s','meters/second':'m/s','metres/second':'m/s',knot:'knot',knots:'knot',kt:'knot',kn:'knot','km/h':'km/h','km/hr':'km/h',kmh:'km/h',kph:'km/h',mph:'mph','mi/h':'mph','kg/m2':'kg/m2','kgm-2':'kg/m2',mm:'mm','kg/m2/day':'kg/m2/day','kgm-2day-1':'kg/m2/day','mm/day':'mm/day','mmday-1':'mm/day','kg/m2/s':'kg/m2/s','kgm-2s-1':'kg/m2/s',in:'in',inch:'in',inches:'in',m:'m',meter:'m',metre:'m',meters:'m',metres:'m',gpm:'m',ft:'ft',feet:'ft',foot:'ft'};
  return m[s]??s;
}
const CV={K:{to:'?C',mul:1,add:-273.15},degC:{to:'?C',mul:1,add:0},degF:{to:'?C',mul:5/9,add:-32*5/9},Pa:{to:'hPa',mul:.01,add:0},hPa:{to:'hPa',mul:1,add:0},kPa:{to:'hPa',mul:10,add:0},'m/s':{to:'m/s',mul:1,add:0},knot:{to:'m/s',mul:.514444,add:0},'km/h':{to:'m/s',mul:1/3.6,add:0},mph:{to:'m/s',mul:.44704,add:0},'kg/m2':{to:'mm',mul:1,add:0},mm:{to:'mm',mul:1,add:0},in:{to:'mm',mul:25.4,add:0},'kg/m2/day':{to:'mm/day',mul:1,add:0},'mm/day':{to:'mm/day',mul:1,add:0},'kg/m2/s':{to:'mm/s',mul:1,add:0},m:{to:'m',mul:1,add:0},ft:{to:'m',mul:.3048,add:0}};
const conversionFor=(u)=>CV[normUnit(u)]??null;
export function convertToMetric(value,unit){const c=conversionFor(unit);if(!c)return{value,unit:unit??null,known:false};return{value:Number.isFinite(value)?value*c.mul+c.add:value,unit:c.to,known:true};}
export function convertSeries(ys,unit){const c=conversionFor(unit);if(!c)return{ys:(ys??[]).slice(),unit:unit??null,known:false};return{ys:(ys??[]).map(v=>Number.isFinite(v)?v*c.mul+c.add:v),unit:c.to,known:true};}
export function sameUnit(a,b){const ca=conversionFor(a),cb=conversionFor(b);return!!(ca&&cb&&ca.to===cb.to);}

