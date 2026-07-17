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

export function numericXs(xs) {
  const out = (xs ?? []).map((x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'string' && ISO_LIKE.test(x)) return Date.parse(x);
    return NaN;
  });
  return out.every(Number.isFinite) ? out : (xs ?? []).map((_, i) => i);
}

/* ── chart ─────────────────────────────────────────────────────────────── */
const PAD = { top: 10, right: 12, bottom: 26, left: 46 };
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function defaultFmt(v) { if (!Number.isFinite(v)) return '–'; const a=Math.abs(v); if (a!==0&&(a<1e-3||a>=1e5)) return v.toExponential(2); return v.toFixed(2); }
export function renderChartSVG(series, opts = {}) {
  const width=opts.width??480, height=opts.height??180;
  const formatX=opts.formatX??((x)=>String(x)), formatY=opts.formatY??defaultFmt;
  const { xs=[], ys=[], xLabel='' }=series??{};
  const plotW=width-PAD.left-PAD.right, plotH=height-PAD.top-PAD.bottom;
  const frame=`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top+plotH}" class="ac-axis"/>`+`<line x1="${PAD.left}" y1="${PAD.top+plotH}" x2="${PAD.left+plotW}" y2="${PAD.top+plotH}" class="ac-axis"/>`;
  const open=`<svg viewBox="0 0 ${width} ${height}" class="ac-svg" role="img">`;
  const finite=ys.filter((v)=>Number.isFinite(v));
  if (!finite.length) return open+frame+`<text x="${width/2}" y="${height/2}" class="ac-note" text-anchor="middle">no data to plot</text></svg>`;
  let vmin=Math.min(...finite), vmax=Math.max(...finite);
  if (vmin===vmax) { vmin-=1; vmax+=1; }
  const padY=(vmax-vmin)*0.05; vmin-=padY; vmax+=padY;
  const n=ys.length;
  const nx=numericXs(xs);
  const xmin=Math.min(...nx), xmax=Math.max(...nx);
  const xspan=xmax-xmin;
  // Position by x VALUE, not array index: an overlay of series with different
  // sampling must line up on a shared domain. A degenerate span centres the mark.
  const px=(i)=>xspan===0?PAD.left+plotW/2:PAD.left+((nx[i]-xmin)/xspan)*plotW;
  const py=(v)=>PAD.top+plotH-((v-vmin)/(vmax-vmin))*plotH;
  const runs=[]; let run=[];
  ys.forEach((v,i)=>{ if(Number.isFinite(v)) run.push(`${px(i).toFixed(2)},${py(v).toFixed(2)}`); else { if(run.length) runs.push(run); run=[]; } });
  if(run.length) runs.push(run);
  const marks=runs.map((r)=>r.length===1?`<circle cx="${r[0].split(',')[0]}" cy="${r[0].split(',')[1]}" r="2.5" class="ac-dot"/>`:`<polyline points="${r.join(' ')}" class="ac-line"/>`).join('');
  const yTicks=`<text x="${PAD.left-5}" y="${PAD.top+4}" class="ac-tick" text-anchor="end">${esc(formatY(vmax))}</text>`+`<text x="${PAD.left-5}" y="${PAD.top+plotH}" class="ac-tick" text-anchor="end">${esc(formatY(vmin))}</text>`;
  const xTicks=`<text x="${PAD.left}" y="${height-12}" class="ac-tick" text-anchor="start">${esc(formatX(xs[0]))}</text>`+(n>1?`<text x="${PAD.left+plotW}" y="${height-12}" class="ac-tick" text-anchor="end">${esc(formatX(xs[n-1]))}</text>`:'');
  const axisTitle=`<text x="${PAD.left+plotW/2}" y="${height-1}" class="ac-tick" text-anchor="middle">${esc(xLabel)}</text>`;
  return open+frame+marks+yTicks+xTicks+axisTitle+'</svg>';
}