// examples/map-demo.js — MapLibre demo logic.
//
// Drop any supported file, pick a variable + ramp, see it overlaid on a real
// basemap, and click to read the underlying value. The heavy extractGrid call
// runs inline here (Phase 5); Phase 6 moves it into a Web Worker so pan/zoom
// stays smooth.

import { scan, extract } from 'https://cdn.jsdelivr.net/gh/uihilab/SciWrid-Toolkit@main/index.js';
import { resolveRamp, sampleRamp } from 'https://cdn.jsdelivr.net/gh/uihilab/SciWrid-Toolkit@main/lib/render/index.js';
import { validateBbox, resolutionBucket } from './map-demo-bbox.js';
import { notifyStatus } from './notify.js';
import { computeStats, seriesFromGrid, seriesFromTimeseries, renderChartSVG, chartScale, nearestIndex, resolveUnit, convertSeries, sameUnit, nativeGridSize, bboxIntersect, pairGrids, pearson, meanBias, renderScatterSVG } from './map-demo-analysis.js';

const $ = (id) => document.getElementById(id);

let map;
let lastScan   = null;
let lastSource = null;
let boundsAssumed = false; // true when the file exposes no real bbox (GRIB2/NetCDF/Zarr)
let timeAxis = null;   // { kind, values } for the active variable; values are display labels
let renderToken = 0;   // bumped each refresh; stale worker responses are discarded
let extractBbox = null; // [minLon,minLat,maxLon,maxLat] - chosen extract region
let lastBucket = null;  // last rendered resolution bucket; lets pan skip re-extract
let lastGrid = null;    // pre-warp grid from the last successful render
let animFrames = null;  // ImageBitmaps decoded once and reused during playback
let animRange = null;
let animTimes = null;    // actual timestep indices (possibly subsampled)
let animToken = 0;
let animPlaying = false;
let animSpeed = 1;
let animLoop = true;
let animIndex = 0;
let animTimer = null;
let animRequestId = null;
let animSize = null;
let animBbox = null;
// Exactly two files compared, A vs B. A drives the raster; B is chart-only.
const MAX_SOURCES = 3;
let sources = [];        // [{ file, scan, name, slot, boundsAssumed, chartVar }]
// Non-primary grids for space-mode comparison, keyed by slot|variable|bbox|size|time.
const gridCache = new Map();
const MERCATOR_MAX_LAT = 85.05112878;

/* ── render worker ──────────────────────────────────────────────────────── */
// extractGrid + gridToImageData run off the main thread so pan/zoom stays
// smooth. Each request carries the current renderToken; responses with a stale
// token are ignored (cancellation).
const worker = new Worker(new URL('./map-demo.worker.js', import.meta.url), { type: 'module' });
const pending = new Map(); // token → { resolve, reject }
const animPending = new Map();

worker.onmessage = (e) => {
  const message = e.data;
  const { requestId, image, range, grid, error, type } = message;
  if (type?.startsWith('anim-')) {
    const slot = animPending.get(requestId);
    if (!slot) {
      // A stale completed job still transfers ownership; close it immediately.
      for (const bitmap of message.bitmaps || []) bitmap.close();
      return;
    }
    if (type === 'anim-progress') { slot.progress(message.done, message.total); return; }
    animPending.delete(requestId);
    if (type === 'anim-done') slot.resolve(message);
    else if (type === 'anim-cancelled') slot.reject(new Error('animation cancelled'));
    else slot.reject(new Error(error || 'animation worker failed'));
    return;
  }
  const slot = pending.get(requestId);
  if (!slot) return;            // already superseded / unknown
  pending.delete(requestId);
  if (error) slot.reject(new Error(error));
  else slot.resolve({ image, range, grid });
};

function renderInWorker(token, payload) {
  return new Promise((resolve, reject) => {
    pending.set(token, { resolve, reject });
    worker.postMessage({ requestId: token, ...payload });
  });
}

function renderAnimationInWorker(requestId, payload, progress) {
  return new Promise((resolve, reject) => {
    animPending.set(requestId, { resolve, reject, progress });
    worker.postMessage({ requestId, type: 'anim', ...payload });
  });
}

/* ── status helpers ─────────────────────────────────────────────────────── */
function setStatus(msg, cls = '') {
  notifyStatus(msg, cls);   // status lives only in the bottom-right toast now
}

/* ── layer opacity ──────────────────────────────────────────────────────── */
// Read the opacity slider (0–100) as a 0–1 raster-opacity, defaulting to 0.75.
function currentOpacity() {
  const v = parseInt($('opacity').value, 10);
  return Number.isFinite(v) ? v / 100 : 0.75;
}
function updateOpacityLabel() {
  $('opacity-val').textContent = `${parseInt($('opacity').value, 10) || 0}%`;
}

/* ── bbox helpers ───────────────────────────────────────────────────────── */
function clampMercatorLat(lat) {
  return Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
}

function normalizeDisplayLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function displayBbox([minLon, minLat, maxLon, maxLat]) {
  let dMinLon = minLon, dMaxLon = maxLon;
  const span = maxLon - minLon;
  if (minLon >= 0 && maxLon > 180 && span > 180) {
    dMinLon = minLon - 180;
    dMaxLon = maxLon - 180;
  } else if (minLon < -180 || maxLon > 180) {
    dMinLon = normalizeDisplayLon(minLon);
    dMaxLon = normalizeDisplayLon(maxLon);
    if (dMaxLon <= dMinLon) {
      dMinLon = Math.max(-180, dMinLon - 360);
      dMaxLon = Math.min(180, dMaxLon);
    }
  }
  dMinLon = Math.max(-180, Math.min(180, dMinLon));
  dMaxLon = Math.max(-180, Math.min(180, dMaxLon));
  if (dMaxLon <= dMinLon) { dMinLon = -180; dMaxLon = 180; }
  return [dMinLon, clampMercatorLat(minLat), dMaxLon, clampMercatorLat(maxLat)];
}

// MapLibre ImageSource wants 4 corner coords, clockwise from top-left.
function bboxToCoords(bbox) {
  const [minLon, minLat, maxLon, maxLat] = displayBbox(bbox);
  return [
    [minLon, maxLat], // top-left
    [maxLon, maxLat], // top-right
    [maxLon, minLat], // bottom-right
    [minLon, minLat], // bottom-left
  ];
}

function fitMapToBbox(bbox) {
  if (!bbox) return;
  const [minLon, minLat, maxLon, maxLat] = displayBbox(bbox);
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 30, duration: 0 });
}

/* ── variable picker ────────────────────────────────────────────────────── */
function populateVariablePicker(names) {
  const sel = $('variable');
  sel.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.disabled = names.length === 0;
}

/* ── time picker ────────────────────────────────────────────────────────── */
// Fill the time <select>. Real CF times → ISO labels; synthetic/none → indices.
function populateTimePicker(meta, variable) {
  const sel = $('time');
  sel.innerHTML = '';
  // File-level date coverage (meta.timeRange spans all axes; present whenever
  // the file has a time axis).
  const tr = meta.timeRange;
  $('time-range').textContent = tr ? `Coverage: ${tr.start} → ${tr.end}` : '';
  const v = (meta.variables || []).find(x => x.name === variable);
  const values = v?.times?.values || meta.times?.values || null;
  if (values && values.length) {
    timeAxis = { kind: 'real', values };
    values.forEach((iso, i) => {
      const o = document.createElement('option'); o.value = String(i); o.textContent = iso;
      sel.appendChild(o);
    });
    sel.disabled = values.length < 2;
  } else {
    // Synthetic/none: expose integer timesteps. Derive count from shape[0] if present.
    const shape = Array.isArray(v?.shape) ? v.shape
      : (typeof v?.shape === 'string' ? v.shape.split(/[,\sx]+/).filter(Boolean).map(Number) : null);
    const nt = (shape && shape.length >= 3 && shape[0] > 0) ? shape[0] : 1;
    timeAxis = { kind: 'index', values: null };
    for (let i = 0; i < nt; i++) {
      const o = document.createElement('option'); o.value = String(i); o.textContent = `step ${i}`;
      sel.appendChild(o);
    }
    sel.disabled = nt < 2;
  }
  sel.value = '0';
  updateAnimAvailability();
}

function updateAnimAvailability() {
  const count = $('time').options.length;
  const disabled = count < 2;
  $('anim-play').disabled = disabled;
  $('anim-play').title = disabled ? 'file has one timestep' : '';
  $('anim-count').textContent = disabled ? `1 / ${Math.max(1, count)}` : `1 / ${count}`;
}

/* ── legend ─────────────────────────────────────────────────────────────── */
/* ── color ramps ──────────────────────────────────────────────────────────
 * Demo-local ramps beyond the four the render library ships. resolveRamp()
 * accepts a raw [t,[r,g,b]] stop array, so these need no library change: the
 * built-ins pass through by name, these by value. Stops are the canonical
 * Matplotlib / ColorBrewer 9-point samples. The "colorblind-safe" sequential
 * set (viridis/magma/inferno/plasma/cividis) is perceptually uniform. */
const DEMO_RAMPS = {
  magma: [
    [0.0, [0, 0, 4]], [0.125, [28, 16, 68]], [0.25, [79, 18, 123]],
    [0.375, [129, 37, 129]], [0.5, [181, 54, 122]], [0.625, [229, 80, 100]],
    [0.75, [251, 135, 97]], [0.875, [254, 194, 135]], [1.0, [252, 253, 191]],
  ],
  inferno: [
    [0.0, [0, 0, 4]], [0.125, [31, 12, 72]], [0.25, [85, 15, 109]],
    [0.375, [136, 34, 106]], [0.5, [186, 54, 85]], [0.625, [227, 89, 51]],
    [0.75, [249, 140, 10]], [0.875, [249, 201, 50]], [1.0, [252, 255, 164]],
  ],
  cividis: [
    [0.0, [0, 34, 78]], [0.125, [0, 51, 104]], [0.25, [64, 71, 107]],
    [0.375, [104, 90, 108]], [0.5, [140, 110, 105]], [0.625, [176, 132, 97]],
    [0.75, [214, 156, 82]], [0.875, [253, 183, 58]], [1.0, [255, 234, 70]],
  ],
  Blues: [
    [0.0, [247, 251, 255]], [0.125, [222, 235, 247]], [0.25, [198, 219, 239]],
    [0.375, [158, 202, 225]], [0.5, [107, 174, 214]], [0.625, [66, 146, 198]],
    [0.75, [33, 113, 181]], [0.875, [8, 81, 156]], [1.0, [8, 48, 107]],
  ],
  YlOrRd: [
    [0.0, [255, 255, 204]], [0.125, [255, 237, 160]], [0.25, [254, 217, 118]],
    [0.375, [254, 178, 76]], [0.5, [253, 141, 60]], [0.625, [252, 78, 42]],
    [0.75, [227, 26, 28]], [0.875, [189, 0, 38]], [1.0, [128, 0, 38]],
  ],
  turbo: [
    [0.0, [48, 18, 59]], [0.125, [64, 124, 226]], [0.25, [30, 185, 220]],
    [0.375, [43, 225, 150]], [0.5, [128, 253, 78]], [0.625, [201, 229, 50]],
    [0.75, [249, 168, 49]], [0.875, [231, 92, 20]], [1.0, [122, 4, 3]],
  ],
  RdYlBu: [
    [0.0, [165, 0, 38]], [0.125, [215, 48, 39]], [0.25, [244, 109, 67]],
    [0.375, [253, 174, 97]], [0.5, [255, 255, 191]], [0.625, [171, 217, 233]],
    [0.75, [116, 173, 209]], [0.875, [69, 117, 180]], [1.0, [49, 54, 149]],
  ],
};

// The selected ramp as the render path wants it: a built-in name (string) or a
// stop array. The Reverse toggle flips the stops (resolving a name first).
function rampValue() {
  const name = $('ramp').value;
  const ramp = DEMO_RAMPS[name] ?? name;
  if (!$('ramp-reverse')?.checked) return ramp;
  return resolveRamp(ramp).map(([t, c]) => [1 - t, c]).reverse();
}

function drawLegend(rampName, vmin, vmax) {
  const wrap = $('legend');
  if (vmin == null || vmax == null) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const canvas = $('legend-canvas');
  const ctx = canvas.getContext('2d');
  const ramp = resolveRamp(rampName);
  const w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const [r, g, b] = sampleRamp(ramp, x / (w - 1));
    for (let y = 0; y < h; y++) {
      const off = (y * w + x) * 4;
      img.data[off] = r; img.data[off + 1] = g; img.data[off + 2] = b; img.data[off + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  $('legend-min').textContent = fmtNum(vmin);
  $('legend-max').textContent = fmtNum(vmax);
}

function fmtNum(v) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return v.toFixed(2);
}

/* --- extract-area bbox selection ---------------------------------------- */
function prefillExtractInputs(coverage) {
  const [minLon, minLat, maxLon, maxLat] = coverage;
  $('ext-coverage').textContent =
    `Coverage: Lat ${fmtNum(minLat)} ... ${fmtNum(maxLat)}  /  Lon ${fmtNum(minLon)} ... ${fmtNum(maxLon)}` +
    (boundsAssumed ? '  (assumed - file exposes no bounds)' : '');
  const set = (id, val, lo, hi) => {
    const el = $(id);
    el.value = val;
    el.min = lo;
    el.max = hi;
  };
  set('ext-min-lat', minLat, minLat, maxLat);
  set('ext-max-lat', maxLat, minLat, maxLat);
  set('ext-min-lon', minLon, minLon, maxLon);
  set('ext-max-lon', maxLon, minLon, maxLon);
}

function readExtractInputs() {
  return {
    minLat: parseFloat($('ext-min-lat').value),
    maxLat: parseFloat($('ext-max-lat').value),
    minLon: parseFloat($('ext-min-lon').value),
    maxLon: parseFloat($('ext-max-lon').value),
  };
}

function validateAndSketch() {
  if (!lastScan) return null;
  const { bbox, error } = validateBbox(readExtractInputs(), lastScan.bbox);
  const msg = $('ext-msg');
  if (error) {
    $('ext-btn').disabled = true;
    msg.textContent = error;
    msg.className = 'muted';
    clearBboxSketch();
    return null;
  }
  $('ext-btn').disabled = false;
  msg.textContent = 'Box ready - click Render area.';
  msg.className = 'muted';
  drawBboxSketch(bbox);
  return bbox;
}

function drawBboxSketch(bbox) {
  if (!map || !map.isStyleLoaded()) return;
  const [minLon, minLat, maxLon, maxLat] = displayBbox(bbox);
  const ring = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
  const data = { type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} };
  if (map.getSource('bbox-sketch')) {
    map.getSource('bbox-sketch').setData(data);
  } else {
    map.addSource('bbox-sketch', { type: 'geojson', data });
    map.addLayer({
      id: 'bbox-sketch-line', type: 'line', source: 'bbox-sketch',
      paint: { 'line-color': '#e23', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    });
  }
}

function clearBboxSketch() {
  if (map && map.getLayer('bbox-sketch-line')) {
    map.removeLayer('bbox-sketch-line');
    map.removeSource('bbox-sketch');
  }
}

function bboxPixelSize(bbox) {
  const [minLon, minLat, maxLon, maxLat] = displayBbox(bbox);
  const clampDim = (px, fallback) => {
    const n = Math.round(Math.abs(px));
    return Number.isFinite(n) && n > 0
      ? Math.min(1024, Math.max(64, n))
      : Math.min(1024, Math.max(64, Math.round(fallback) || 512));
  };
  const tl = map.project([minLon, maxLat]);
  const br = map.project([maxLon, minLat]);
  const canvas = map.getCanvas();
  const w = clampDim(br.x - tl.x, canvas?.clientWidth);
  const h = clampDim(br.y - tl.y, canvas?.clientHeight);
  return { w, h };
}

// A 1024² RGBA frame is 4 MB; retaining 365 of them would approach 1.5 GB.
function animFrameBudget(w, h) {
  return Math.max(2, Math.floor((256 * 1024 * 1024) / (w * h * 4)));
}

function chooseAnimTimes(total, budget) {
  if (total <= 0) return [];
  if (total <= budget) return Array.from({ length: total }, (_, i) => i);
  const count = Math.max(2, budget);
  const times = [];
  for (let i = 0; i < count; i++) times.push(Math.round((i * (total - 1)) / (count - 1)));
  return times;
}

// Exposed only as demo diagnostics for the browser-console verification steps.
Object.assign(window, { animFrameBudget, chooseAnimTimes });

function removeAnimLayer() {
  if (!map) return;
  if (map.getLayer('anim-layer')) map.removeLayer('anim-layer');
  if (map.getSource('anim-source')) map.removeSource('anim-source');
}

function pauseAnimation() {
  animPlaying = false;
  clearTimeout(animTimer);
  animTimer = null;
  $('anim-play').textContent = '▶';
  map?.getSource('anim-source')?.pause();
}

function releaseAnimation() {
  ++animToken;
  if (animRequestId) {
    worker.postMessage({ type: 'anim-cancel', requestId: animRequestId });
    const slot = animPending.get(animRequestId);
    if (slot) { animPending.delete(animRequestId); slot.reject(new Error('animation invalidated')); }
    animRequestId = null;
  }
  pauseAnimation();
  for (const bitmap of animFrames || []) bitmap.close();
  animFrames = null; animRange = null; animTimes = null;
  animIndex = 0; animSize = null; animBbox = null;
  removeAnimLayer();
  if (map?.getLayer('data-layer')) map.setLayoutProperty('data-layer', 'visibility', 'visible');
  $('anim-count').textContent = `1 / ${Math.max(1, $('time').options.length)}`;
}

async function prepareAnimation() {
  const variable = $('variable').value;
  const total = $('time').options.length;
  if (!lastSource || !lastScan || !extractBbox || !variable || total < 2) return false;

  releaseAnimation();
  const { w, h } = bboxPixelSize(extractBbox); // fixed for this animation, even after zoom
  const times = chooseAnimTimes(total, animFrameBudget(w, h));
  const token = ++animToken;
  const requestId = `anim:${token}`;
  animRequestId = requestId;
  const bbox = extractBbox.slice();
  setStatus(`Decoding 0/${times.length}…`, 'busy');
  try {
    const result = await renderAnimationInWorker(requestId, {
      source: lastSource, variable, bbox, width: w, height: h,
      ramp: rampValue(), times,
    }, (done, count) => {
      if (token === animToken) setStatus(`Decoding ${done}/${count}…`, 'busy');
    });
    animRequestId = null;
    if (token !== animToken) {
      for (const bitmap of result.bitmaps) bitmap.close();
      return false;
    }
    animFrames = result.bitmaps;
    animRange = result.range;
    animTimes = times;
    animSize = { w: result.width, h: result.height };
    animBbox = bbox;
    animIndex = 0;
    const canvas = $('anim-canvas');
    canvas.width = result.width; canvas.height = result.height;
    drawLegend(rampValue(), animRange.vmin, animRange.vmax);
    setStatus(times.length < total
      ? `animating ${times.length} of ${total} steps`
      : `animation ready — ${times.length} steps`, 'ok');
    return true;
  } catch (error) {
    animRequestId = null;
    if (token === animToken && !/invalidated|cancelled/.test(error.message)) {
      setStatus(`Error: ${error.message}`, 'error');
      console.error(error);
    }
    return false;
  }
}

function ensureAnimLayer() {
  if (map.getSource('anim-source')) return;
  map.addSource('anim-source', {
    type: 'canvas', canvas: 'anim-canvas', coordinates: bboxToCoords(animBbox), animate: false,
  });
  map.addLayer({
    id: 'anim-layer', type: 'raster', source: 'anim-source',
    paint: { 'raster-opacity': currentOpacity() },
  });
}

function drawAnimFrame(index) {
  if (!animFrames?.[index] || !animSize) return;
  const canvas = $('anim-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, animSize.w, animSize.h);
  ctx.drawImage(animFrames[index], 0, 0);
  // Programmatic select assignment does not dispatch `change`, so playback
  // never re-enters refreshLayer and never decodes an individual still frame.
  $('time').value = String(animTimes[index]);
  $('anim-count').textContent = `${index + 1} / ${animFrames.length}`;
}

// Reaching the last frame with loop off is not an invalidation: the frames stay
// decoded so pressing play again replays from memory instead of re-reading the
// whole time axis. Only the layers swap back to the still raster. (Contrast
// releaseAnimation(), which frees the bitmaps when the bbox/variable/ramp change
// makes them genuinely stale.)
async function finishAnimation() {
  pauseAnimation();
  await refreshLayer({ force: true, preserveAnimation: true });
  removeAnimLayer();
  if (map?.getLayer('data-layer')) map.setLayoutProperty('data-layer', 'visibility', 'visible');
}

function scheduleAnimTick() {
  clearTimeout(animTimer);
  animTimer = setTimeout(() => {
    if (!animPlaying || !animFrames) return;
    if (animIndex >= animFrames.length - 1) {
      if (!animLoop) { finishAnimation(); return; }
      animIndex = 0;
    } else animIndex += 1;
    drawAnimFrame(animIndex);
    scheduleAnimTick();
  }, 500 / animSpeed);
}

async function startAnimation() {
  if (!animFrames && !(await prepareAnimation())) return;
  // Parked on the last frame after a non-looping run — start over rather than
  // immediately re-triggering the end-of-run branch on the first tick.
  if (animIndex >= animFrames.length - 1) animIndex = 0;
  ensureAnimLayer();
  drawAnimFrame(animIndex);
  if (map.getLayer('data-layer')) map.setLayoutProperty('data-layer', 'visibility', 'none');
  map.setLayoutProperty('anim-layer', 'visibility', 'visible');
  map.getSource('anim-source').play();
  animPlaying = true;
  $('anim-play').textContent = '⏸';
  scheduleAnimTick();
}

/* --- render the chosen bbox into a MapLibre ImageSource ----------------- */
async function refreshLayer({ force = false, preserveAnimation = false } = {}) {
  if (!lastSource || !lastScan || !extractBbox) return;
  const variable = $('variable').value;
  const ramp     = rampValue();
  if (!variable) return;

  const bbox = extractBbox;
  const { w: px, h: py } = bboxPixelSize(bbox);
  const bucket = `${resolutionBucket(px)}x${resolutionBucket(py)}`;
  if (!force && bucket === lastBucket) return;
  lastBucket = bucket;
  gridCache.clear();  // bbox/size/time changed — cached non-primary grids are stale
  if (!preserveAnimation) releaseAnimation();
  const token = ++renderToken;
  // Drop any earlier in-flight request — its response will be ignored.
  for (const [id, slot] of pending) {
    if (id !== token) { pending.delete(id); slot.reject(new Error('superseded')); }
  }
  setStatus('Rendering…', 'busy');
  try {
    const time = parseInt($('time').value, 10) || 0;
    const { image: img, range, grid } = await renderInWorker(token, {
      source: lastSource, variable, bbox, width: px, height: py, ramp, time,
    });
    if (token !== renderToken) return; // a newer refresh superseded us
    lastGrid = grid ?? null;

    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const url = canvas.toDataURL('image/png');

    if (map.getSource('data-source')) {
      map.getSource('data-source').updateImage({ url, coordinates: bboxToCoords(bbox) });
    } else {
      map.addSource('data-source', { type: 'image', url, coordinates: bboxToCoords(bbox) });
      map.addLayer({ id: 'data-layer', type: 'raster', source: 'data-source',
                     paint: { 'raster-opacity': currentOpacity() } });
    }
    drawLegend(ramp, range?.vmin, range?.vmax);
    $('analyze-btn').hidden = !lastGrid;
    setStatus(`${variable} — ${img.width}×${img.height}`, 'ok');
  } catch (e) {
    if (token !== renderToken) return;
    setStatus('Error: ' + e.message, 'error');
    console.error(e);
  }
}

/* ── file handling / multi-file sources ─────────────────────────────────── */
function firstFreeSlot() {
  const used = new Set(sources.map((s) => s.slot));
  for (let i = 0; i < MAX_SOURCES; i++) if (!used.has(i)) return i;
  return 0;
}

// A variable's timesteps in a given scan. GRIB2 reports shape: undefined, so this
// must key off times.values and never off shape.
function variableTimes(scanResult, variable) {
  const v = (scanResult?.variables || []).find((x) => x.name === variable);
  return v?.times?.values || scanResult?.times?.values || [];
}

function renderFileList() {
  const ul = $('file-list');
  ul.innerHTML = '';
  sources.forEach((s, i) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.dataset.idx = String(i);
    li.setAttribute('aria-label',
      `${s.name}, file ${i + 1} of ${sources.length}${i === 0 ? ', primary' : ''}. ` +
      `Alt plus Arrow Up or Arrow Down to move it. The top file is primary.`);
    li.addEventListener('keydown', onFileRowKey);
    li.draggable = true;
    li.addEventListener('dragstart', onFileRowDragStart);
    li.addEventListener('dragover',  onFileRowDragOver);
    li.addEventListener('dragleave', onFileRowDragLeave);
    li.addEventListener('drop',      onFileRowDrop);
    li.addEventListener('dragend',   onFileRowDragEnd);
    const sw = document.createElement('span');
    sw.className = 'fl-swatch';
    sw.style.background = `var(--series-${s.slot + 1})`;
    const nm = document.createElement('span');
    nm.className = 'fl-name'; nm.textContent = s.name; nm.title = s.name;
    li.append(sw, nm);
    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'fl-primary'; tag.textContent = 'PRIMARY';
      li.append(tag);
    }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.textContent = '×';
    rm.draggable = false;   // else a mousedown here drags the whole row
    rm.setAttribute('aria-label', `Remove ${s.name}`);
    rm.addEventListener('click', () => removeSource(s.slot));
    li.append(rm);
    ul.append(li);
  });
  updateAddFileUI();
}

// Make the 4-file ceiling visible rather than something you discover by hitting it.
function updateAddFileUI() { const row=$('add-file-row'),btn=$('add-file-btn'),full=sources.length>=MAX_SOURCES; row.hidden=sources.length===0;btn.disabled=full;btn.textContent=full?`${MAX_SOURCES} files loaded`:'+ Add a file to compare';btn.title=full?'Remove a file to swap it.':`Add another file (up to ${MAX_SOURCES}); pick a column of each in Show analysis.`;$('file-count').textContent=`${sources.length} / ${MAX_SOURCES}`; }

// Add a file to the comparison. Rejects only when it shares NO variable name with
// what is already loaded — identical sets is the wrong rule, since GFS f000 is a
// strict subset of f003 (accumulated fields do not exist at forecast hour 0).
async function addFile(file) { if(!file)return false;releaseAnimation();if(sources.length>=MAX_SOURCES){setStatus(`Comparing up to ${MAX_SOURCES} files — "${file.name}" not added.`,'error');return false;}setStatus(`Scanning ${file.name}…`,'busy');let scanResult;try{scanResult=await scan(file);}catch(err){setStatus(`Error scanning ${file.name}: ${err.message}`,'error');console.error(err);return false;}const names=scanResult.variable_names||[],hasBbox=Array.isArray(scanResult.bbox)&&scanResult.bbox.length===4;if(!hasBbox)scanResult.bbox=[-180,-90,180,90];sources.push({file,scan:scanResult,name:file.name,slot:firstFreeSlot(),boundsAssumed:!hasBbox,chartVar:names[0]??''});applyPrimary();setStatus(sources.length>1?`${file.name} added — pick a column of each in Show analysis.`:`${file.name} loaded.`,'ok');return true;}

function removeSource(slot) { const i=sources.findIndex(s=>s.slot===slot);if(i===-1)return;releaseAnimation();sources.splice(i,1);gridCache.clear();if(!sources.length){lastSource=null;lastScan=null;lastGrid=null;closeAnalysis();$('analyze-btn').hidden=true;$('extract').hidden=true;$('query').hidden=true;if(map.getLayer('data-layer')){map.removeLayer('data-layer');map.removeSource('data-source');}renderFileList();setStatus('Drop a file to begin.','');return;}applyPrimary();lastBucket=null;if(extractBbox)refreshLayer({force:true});if(!$('analysis-panel').hidden){populateCompareControls();refreshAnalysis();} }

// Point the single-file globals at sources[0] so refreshLayer / doPointQuery /
// updateQueryUI keep working unchanged.
function applyPrimary() { const p=sources[0];if(!p)return;const prevVar=$('variable').value;lastSource=p.file;lastScan=p.scan;boundsAssumed=p.boundsAssumed;const names=p.scan.variable_names||[];populateVariablePicker(names);if(names.includes(prevVar))$('variable').value=prevVar;populateTimePicker(lastScan,$('variable').value);updateQueryUI();renderFileList(); }

/* Reorder the comparison set. `from` and `to` are indices into `sources` as it
 * stands right now, before the move.
 *
 * Primary is not a label. sources[0] draws the map layer, and in space mode
 * every other file is resampled onto ITS bbox and resolution so the transects
 * are directly comparable -- so the top row decides the basis the whole
 * comparison is measured on. Order below the top matters too: picksOf() maps
 * list order onto the analysis series, and scatter mode pairs sources[0]
 * against sources[1]. Dragging is therefore how you choose which two files the
 * scatter compares, which the old rotate button could only reach by cycling.
 *
 * `slot` travels with the source, so a file keeps its series colour AND its
 * gridCache entries across a move; only the order changes. */
function moveSource(from, to) {
  if (from < 0 || from >= sources.length) return;
  const dest = Math.max(0, Math.min(to, sources.length - 1));
  if (from === dest) return;

  const wasPrimary = sources[0];
  const [moved] = sources.splice(from, 1);
  sources.splice(dest, 0, moved);

  if (sources[0] !== wasPrimary) {
    releaseAnimation();
    lastGrid = null;              // that grid belonged to the file that stepped down
    lastBucket = null;            // and so did the colour bucketing of the layer
    applyPrimary();               // repaints the list for us
    if (extractBbox) refreshLayer({ force: true });
    setStatus(`${sources[0].name} is now primary.`, 'ok');
  } else {
    // Nothing about the map layer changed -- only the order of the panel series.
    renderFileList();
    setStatus(`${moved.name} moved to #${dest + 1}.`, 'ok');
  }

  if (!$('analysis-panel').hidden) { populateCompareControls(); refreshAnalysis(); }
  focusFileRow(dest);
}

/* renderFileList() rebuilds every row, so a move destroys the node that had
 * focus. Put focus on the row that moved, or each Alt+Arrow press would need a
 * fresh Tab back into the list before the next one could land. */
function focusFileRow(i) { $('file-list').children[i]?.focus(); }

/* Alt is required: bare arrows belong to the page, and on Windows and Linux a
 * bare Arrow inside a focused list is how you scroll it. */
function onFileRowKey(e) {
  if (!e.altKey) return;
  const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();   // Alt+Arrow is history back/forward on some platforms
  const from = Number(e.currentTarget.dataset.idx);
  moveSource(from, from + dir);
}

/* Drag state is module-scope because dragover fires on the row being CROSSED,
 * not the row being dragged, so the two handlers need a shared reference.
 * dataTransfer cannot be read during dragover (spec: protected mode), so it
 * carries the payload only to satisfy Firefox, which refuses to start a drag
 * when nothing is written. */
let dragFrom = null;

function onFileRowDragStart(e) {
  dragFrom = Number(e.currentTarget.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
  e.currentTarget.classList.add('fl-dragging');
}

function onFileRowDragOver(e) {
  if (dragFrom === null) return;
  e.preventDefault();                 // without this the row is not a drop target at all
  e.dataTransfer.dropEffect = 'move';
  const li = e.currentTarget, r = li.getBoundingClientRect();
  const below = e.clientY > r.top + r.height / 2;
  li.classList.toggle('fl-over-bottom', below);
  li.classList.toggle('fl-over-top', !below);
}

function onFileRowDragLeave(e) {
  e.currentTarget.classList.remove('fl-over-top', 'fl-over-bottom');
}

function onFileRowDrop(e) {
  if (dragFrom === null) return;
  e.preventDefault();
  const li = e.currentTarget, r = li.getBoundingClientRect();
  const over = Number(li.dataset.idx);
  const below = e.clientY > r.top + r.height / 2;
  li.classList.remove('fl-over-top', 'fl-over-bottom');
  /* `to` is the gap the row was dropped into, numbered in the array as it
   * stands BEFORE the dragged row is lifted out. Lifting it shifts every later
   * index down by one, so a downward move has to compensate. */
  let to = below ? over + 1 : over;
  if (dragFrom < to) to -= 1;
  const from = dragFrom;
  dragFrom = null;                    // clear before moveSource: it repaints the list
  moveSource(from, to);
}

function onFileRowDragEnd(e) {
  dragFrom = null;
  e.currentTarget.classList.remove('fl-dragging');
  for (const li of $('file-list').children) li.classList.remove('fl-over-top', 'fl-over-bottom');
}

// Loading via the file input REPLACES the comparison set; addFile() appends.
async function loadSource(file) {
  if (!file) return null;
  releaseAnimation();
  sources = [];
  gridCache.clear();
  lastGrid = null;
  closeAnalysis();
  $('analyze-btn').hidden = true;
  if (map.getLayer('data-layer')) { map.removeLayer('data-layer'); map.removeSource('data-source'); }
  extractBbox = null;
  lastBucket = null;
  // Clear the list now: if the new file fails to scan we return early, and a stale
  // list would still advertise files that are no longer loaded.
  renderFileList();

  if (!(await addFile(file))) return null;

  fitMapToBbox(lastScan.bbox);
  $('extract').hidden = false;
  prefillExtractInputs(lastScan.bbox);
  validateAndSketch();
  setStatus('Set an area and click "Render area".', '');
  return lastScan;
}

$('file').addEventListener('change', async (e) => {
  const picked = [...e.target.files];
  if (!picked.length) return;
  // First file replaces the set; the rest join it.
  const first = await loadSource(picked[0]);
  if (!first) return;
  for (const f of picked.slice(1)) await addFile(f);
});

// "Add file" APPENDS to the comparison instead of replacing it.
$('add-file-btn').addEventListener('click', () => $('add-file').click());

$('add-file').addEventListener('change', async (e) => {
  for (const f of [...e.target.files]) await addFile(f);
  // Reset so re-picking the same file fires `change` again.
  e.target.value = '';
  if (!$('analysis-panel').hidden) refreshAnalysis();
});

$('variable').addEventListener('change', () => {
  releaseAnimation();
  populateTimePicker(lastScan, $('variable').value);
  updateQueryUI();
  refreshLayer({ force: true });
});
$('time').addEventListener('change', () => refreshLayer({ force: true }));
$('ramp').addEventListener('change', () => { releaseAnimation(); refreshLayer({ force: true }); });
$('ramp-reverse').addEventListener('change', () => { releaseAnimation(); refreshLayer({ force: true }); });
$('anim-play').addEventListener('click', () => {
  if (animPlaying) pauseAnimation(); else startAnimation();
});
$('anim-speed').querySelectorAll('button').forEach((button) => {
  button.addEventListener('click', () => {
    animSpeed = Number(button.dataset.speed);
    $('anim-speed').querySelectorAll('button').forEach((item) =>
      item.setAttribute('aria-pressed', String(item === button)));
    if (animPlaying) scheduleAnimTick();
  });
});
$('anim-loop').addEventListener('click', () => {
  animLoop = !animLoop;
  $('anim-loop').setAttribute('aria-pressed', String(animLoop));
});

for (const id of ['ext-min-lat', 'ext-max-lat', 'ext-min-lon', 'ext-max-lon']) {
  $(id).addEventListener('input', validateAndSketch);
}
$('ext-btn').addEventListener('click', () => {
  const bbox = validateAndSketch();
  if (!bbox) return;
  extractBbox = bbox;
  lastBucket = null;
  fitMapToBbox(bbox);
  refreshLayer({ force: true });
});

// Layer opacity — live-update the existing raster without re-rendering the grid.
$('opacity').addEventListener('input', () => {
  updateOpacityLabel();
  if (map && map.getLayer('data-layer'))
    map.setPaintProperty('data-layer', 'raster-opacity', currentOpacity());
  if (map && map.getLayer('anim-layer'))
    map.setPaintProperty('anim-layer', 'raster-opacity', currentOpacity());
});

/* ── point query (lat/lon inputs bounded by the variable's extent) ──────── */
// bbox is [minLon, minLat, maxLon, maxLat]. For TIFF these are real file
// bounds (in the file CRS); for other formats they're the assumed global box.
function variableBounds() {
  const b = lastScan?.bbox ?? [-180, -90, 180, 90];
  return { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3], assumed: boundsAssumed };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Populate the bounds readout and constrain the lat/lon inputs to the extent.
function updateQueryUI() {
  if (!lastScan) return;
  const { minLon, minLat, maxLon, maxLat, assumed } = variableBounds();
  $('query').hidden = false;
  $('q-bounds').textContent =
    `Lat ${fmtNum(minLat)} … ${fmtNum(maxLat)}  ·  Lon ${fmtNum(minLon)} … ${fmtNum(maxLon)}` +
    (assumed ? '  (assumed — file exposes no bounds)' : '');
  const latIn = $('q-lat'), lonIn = $('q-lon');
  latIn.min = minLat; latIn.max = maxLat;
  lonIn.min = minLon; lonIn.max = maxLon;
  // Default to the center of the extent if empty / now out of range.
  if (latIn.value === '' || +latIn.value < minLat || +latIn.value > maxLat)
    latIn.value = ((minLat + maxLat) / 2).toFixed(3);
  if (lonIn.value === '' || +lonIn.value < minLon || +lonIn.value > maxLon)
    lonIn.value = ((minLon + maxLon) / 2).toFixed(3);
  $('q-result').textContent = '–';
  $('q-result').className = 'qr qr-empty';
}

/* ── point-query readout formatting ─────────────────────────────────────── */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Value + unit, using the same unit resolution as the analysis chart so the two
// always agree. Falls back to the raw value if the unit can't be resolved.
function formatPointValue(variable, value) {
  try {
    const sv = (lastScan?.variables || []).find((v) => v.name === variable);
    const conv = convertSeries([value], resolveUnit(sv));
    const out = conv?.ys?.[0];
    return { text: fmtNum(out == null ? value : out),
             unit: conv?.known ? (conv.unit || '') : '' };
  } catch {
    return { text: fmtNum(value), unit: '' };
  }
}

function fmtLatLon(lat, lon) {
  const la = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la}, ${lo}`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
       + ` · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// Run a point query and show the value in the sidebar (+ optional map popup).
async function doPointQuery(lat, lon, { popup = false } = {}) {
  const variable = $('variable').value;
  if (!lastSource || !variable) return;
  const b = variableBounds();
  lat = clamp(lat, b.minLat, b.maxLat);
  lon = clamp(lon, b.minLon, b.maxLon);
  $('q-lat').value = lat; $('q-lon').value = lon;
  const res = $('q-result');
  res.textContent = 'Querying…'; res.className = 'qr qr-empty';
  try {
    const time = parseInt($('time').value, 10) || 0;
    const r = await extract(lastSource, { variable, lat, lon, t1: time, t2: time });
    const { value, when } = pickValue(r);
    if (value == null) {
      res.textContent = 'No data at this location'; res.className = 'qr qr-empty';
    } else {
      const { text: valTxt, unit } = formatPointValue(variable, value);
      res.className = 'qr';
      res.innerHTML =
        `<div class="qr-val">${valTxt}`
          + (unit ? `<span class="qr-unit">${escapeHtml(unit)}</span>` : '') + '</div>'
        + `<div class="qr-name">${escapeHtml(variable)}</div>`
        + `<div class="qr-sub">${fmtLatLon(lat, lon)}`
          + (when ? ` · ${fmtWhen(when)}` : '') + '</div>';
    }
    if (popup) {
      const fmt = value == null ? null : formatPointValue(variable, value);
      const body = value == null
        ? '<span style="opacity:.7">no data here</span>'
        : `<span style="font-size:15px;font-weight:700">${fmt.text}`
          + (fmt.unit ? ` ${escapeHtml(fmt.unit)}` : '') + '</span>'
          + (when ? `<br><span style="opacity:.7;font-size:11px">${fmtWhen(when)}</span>` : '');
      new maplibregl.Popup().setLngLat([lon, lat])
        .setHTML(`<strong>${escapeHtml(variable)}</strong><br>${body}`).addTo(map);
    }
  } catch (err) {
    res.textContent = 'Error: ' + err.message; res.className = 'qr qr-error';
    console.error(err);
  }
  if (!$('analysis-panel').hidden) refreshAnalysis();
}

$('q-btn').addEventListener('click', () => {
  doPointQuery(parseFloat($('q-lat').value), parseFloat($('q-lon').value), { popup: true });
});

/* Normalize an extract() result to a single representative value.
 * Point queries return a top-level `value`; multi-timestep files return a
 * `timeseries` array — we show time index 0 to match the rendered layer. */
function pickValue(r) {
  if (!r) return { value: null, when: '' };
  if (r.value != null) return { value: r.value, when: '' };
  if (Array.isArray(r.timeseries) && r.timeseries.length) {
    const first = r.timeseries[0];
    return { value: first.value, when: first.time ?? '' };
  }
  return { value: null, when: '' };
}

/* ── click-to-query ─────────────────────────────────────────────────────── */
// Clicking the map fills the lat/lon inputs and runs the same point query.
function attachClickQuery() {
  map.on('click', (e) => doPointQuery(e.lngLat.lat, e.lngLat.lng, { popup: true }));
}

/* Instructions walkthrough. */
const HELP_STEPS = [
  {
    title: 'Upload a file',
    body: 'Choose a supported GRIB2, NetCDF, Zarr-zip, or TIFF file from the File picker in the sidebar. Everything is read locally in your browser — nothing is uploaded anywhere.',
  },
  {
    title: 'Add a second file to compare',
    body: 'Use "+ Add a file to compare" to load a second file. Files are never matched automatically, so any file is accepted \u2014 choose which column of each to compare in the analysis window. The first file is PRIMARY and draws the map layer.',
  },
  {
    title: 'Scan the data',
    body: 'The toolkit scans each file locally and lists its variables and time steps. Each file keeps its own full variable list \u2014 there is no shared-variable restriction.',
  },
  {
    title: 'Choose what to display',
    body: 'Select a variable, time step, color ramp, and layer opacity for the map.',
  },
  {
    title: 'Set the map area',
    body: 'Enter a bounding box and choose Render area. Moving the map refreshes the visible data at an appropriate resolution.',
  },
  {
    title: 'Inspect values',
    body: 'Click the map or enter latitude and longitude values to query the underlying data point.',
  },
  {
    title: 'Open the analysis window',
    body: 'With a point picked, choose "Show analysis" and pick a column of File A and File B at the top of the window. Values convert to metric units and each file is sampled at its own resolution. The window floats \u2014 drag its title bar and resize it from the corner.',
  },
  {
    title: 'Try it on real data',
    body: 'Load the bundled GFS forecast \u2014 four timesteps, three hours apart \u2014 or load Hurricane Idalia (2023) as three real products in three formats: NCEP Stage IV radar QPE (GRIB2), NOAA AORC (Zarr) and NLDAS-2 (NetCDF). The NLDAS file also carries 10 m wind: make it primary (\u21bb), pick \u201cWind speed\u201d, and press play to watch the storm\u2019s wind field animate. Click the map and choose "Show analysis" to chart how the products compare at that point.',
  },
];

let helpIndex = 0;
let helpReturnFocus = null;

function renderHelpStep() {
  const step = HELP_STEPS[helpIndex];
  $('help-step-counter').textContent = `Step ${helpIndex + 1} / ${HELP_STEPS.length}`;
  $('help-title').textContent = step.title;
  $('help-body').textContent = step.body;
  $('help-back').disabled = helpIndex === 0;
  $('help-next').hidden = helpIndex === HELP_STEPS.length - 1;
  $('help-example').hidden = helpIndex !== HELP_STEPS.length - 1;
}

function openHelp() {
  helpIndex = 0;
  helpReturnFocus = document.activeElement;
  renderHelpStep();
  $('help-overlay').hidden = false;
  $('help-close').focus();
}

function closeHelp() {
  $('help-overlay').hidden = true;
  helpReturnFocus?.focus();
}

$('help-btn').addEventListener('click', openHelp);
$('help-close').addEventListener('click', closeHelp);
function helpNext() { if (helpIndex < HELP_STEPS.length - 1) { helpIndex += 1; renderHelpStep(); } }
function helpBack() { if (helpIndex > 0) { helpIndex -= 1; renderHelpStep(); } }
$('help-back').addEventListener('click', helpBack);
$('help-next').addEventListener('click', helpNext);
$('help-overlay').addEventListener('click', (event) => { if (event.target === $('help-overlay')) closeHelp(); });
document.addEventListener('keydown', (event) => {
  if (!$('help-overlay').hidden) {
    if (event.key === 'Escape') closeHelp(); else if (event.key === 'ArrowRight') helpNext(); else if (event.key === 'ArrowLeft') helpBack();
    return;
  }
  if (event.key === 'Escape' && !$('analysis-panel').hidden) closeAnalysis();
});
/* Canned datasets behind the instruction-overlay buttons.
 *
 *   parts  — fetched in order and concatenated into ONE File. GRIB2 messages
 *            concatenate natively; the single-part entries are already whole
 *            files built by the prep scripts.
 *   bbox   — REQUIRED when scan() reports none. Stage IV is polar-stereographic
 *            (grid template 20) and scan() returns no bbox for it, so without
 *            this the demo would fit the map to the whole globe.
 *   variable — the three Idalia products name precipitation differently, so the
 *            chart series is pinned here rather than defaulting to the first
 *            variable in the scan.
 */
const DEMO_DATASETS = [
  {
    id: 'gfs-bundled',
    label: 'GFS forecast',
    sizeNote: '172 MB',
    bbox: null,
    files: [{
      name: 'gfs_timeseries.grb2',
      primary: true,
      parts: [
        './timeseries/gfs.t06z.pgrb2.1p00.f000',
        './timeseries/gfs.t06z.pgrb2.1p00.f003',
        './timeseries/gfs.t06z.pgrb2.1p00.f006',
        './timeseries/gfs.t06z.pgrb2.1p00.f009',
      ],
    }],
  },
  {
    id: 'idalia-2023',
    label: 'Hurricane Idalia (2023)',
    sizeNote: 'about 170 MB',
    bbox: [-88, 24, -75, 37],
    files: [
      { name: 'idalia-stage4.grb2',   primary: true, variable: 'Total precipitation',
        parts: ['./idalia/idalia-stage4.grb2'] },
      { name: 'idalia-aorc.zarr.zip', variable: 'APCP_surface',
        parts: ['./idalia/idalia-aorc.zarr.zip'] },
      { name: 'idalia-nldas2.nc',     variable: 'Rainf',
        parts: ['./idalia/idalia-nldas2.nc'] },
    ],
  },
];

async function fetchAsFile(entry, datasetLabel) {
  const blobs = [];
  for (const [i, url] of entry.parts.entries()) {
    const suffix = entry.parts.length > 1 ? ` (${i + 1}/${entry.parts.length})` : '';
    setStatus(`Loading ${datasetLabel} \u2014 ${entry.name}${suffix}\u2026`, 'busy');
    const response = await fetch(url);
    if (!response.ok) {
      const what = url.split('/').pop();
      throw new Error(response.status === 404
        ? `${what} is missing \u2014 see examples/timeseries/method.txt for how to fetch it`
        : `${what}: HTTP ${response.status}`);
    }
    blobs.push(await response.blob());
  }
  return new File([new Blob(blobs)], entry.name);
}

async function loadDataset(id) {
  const ds = DEMO_DATASETS.find((d) => d.id === id);
  if (!ds) { setStatus(`Unknown dataset "${id}".`, 'error'); return; }

  const buttons = [$('help-view-example'), $('help-view-real-event')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; });

  const failures = [];
  try {
    let first = true;
    for (const entry of ds.files) {
      let file;
      try {
        file = await fetchAsFile(entry, ds.label);
      } catch (err) {
        failures.push(`${entry.name}: ${err.message}`);
        console.error(err);
        continue;
      }
      /* The primary file replaces the set; the rest join it. */
      const ok = first ? await loadSource(file) : await addFile(file);
      if (!ok) { failures.push(`${entry.name}: could not be read`); continue; }
      first = false;

      const src = sources[sources.length - 1];
      if (entry.variable && src) {
        const names = src.scan.variable_names || [];
        if (names.includes(entry.variable)) src.chartVar = entry.variable;
        else failures.push(`${entry.name}: variable "${entry.variable}" not found`);
      }
      if (ds.bbox && src) { src.scan.bbox = ds.bbox.slice(); src.boundsAssumed = false; }
    }

    if (!sources.length) {
      setStatus(`Could not load ${ds.label}. ${failures.join('; ')}`, 'error');
      return;
    }

    if (ds.bbox) { lastScan.bbox = ds.bbox.slice(); prefillExtractInputs(ds.bbox); }
    extractBbox = lastScan.bbox;
    lastBucket = null;
    fitMapToBbox(extractBbox);
    renderFileList();
    if (!$('analysis-panel').hidden) populateCompareControls();
    await refreshLayer({ force: true });

    setStatus(failures.length
      ? `${ds.label} loaded without ${failures.length} file(s): ${failures.join('; ')}`
      : `${ds.label} loaded.`, failures.length ? 'warn' : 'ok');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

$('help-view-example').addEventListener('click', () => {
  closeHelp();
  loadDataset('gfs-bundled');
});
$('help-view-real-event').addEventListener('click', () => {
  closeHelp();
  loadDataset('idalia-2023');
});
/* ── analysis panel ─────────────────────────────────────────────────────── */
// One chart, two x-axes: "value along an axis through the point you picked".
//   time mode  — value over time at (lat, lon); needs a real time axis
//   space mode — value along a lon/lat line through (lat, lon); always available
//                once a grid has rendered, because it is one row/column of it
// With several files loaded, every file becomes one series on the same frame.
let analysisMode = 'time', analysisAxis = 'lon';
let lastSeriesList = [];  // the series currently charted; the hover crosshair reads these
let lastDual = false;
let lastUnits = [];        // [unitLeft, unitRight] of the current chart, for redraws
// x-axis zoom/scroll: a view window inside the full domain. zoom>1 narrows it,
// center (0..1) slides it. Reset by Reset, on open, and on a mode/axis switch.
let viewZoom = 1, viewCenter = 0.5;
let lastViewDomain = null; // {min,max} data-x currently shown; the hover reads it

// Time mode is available when ANY loaded file has a real multi-step axis. A
// 1-step file among 4-step files renders as a single dot — honest, not a bug.
function varOf(src,idx){return src.chartVar||(idx===0?$('variable').value:(src.scan.variable_names?.[0]??''));}
function scanVarOf(src,idx){return(src.scan.variables||[]).find(v=>v.name===varOf(src,idx))||{name:varOf(src,idx)};}

/* A PICK is what one charted series comes from: a file, plus one variable of it.
 *
 * Series used to be one-per-file, which left a single file un-analysable: you
 * saw one of its variables and had nothing to compare it against, even though
 * every variable was already scanned and sitting in the same file. A pick
 * separates "which file" from "which column", so:
 *   several files -> one pick each  (compare a quantity across products)
 *   a single file -> several picks  (compare its variables against each other)
 *
 * Capped at MAX_SERIES because `slot` indexes the --series-N colours; past them
 * two series share a colour and the legend stops distinguishing anything. */
const MAX_SERIES = 4;
function picksOf() {
  if (sources.length > 1)
    return sources.map((src, i) => ({ src, idx: i, variable: varOf(src, i), slot: src.slot }));
  const src = sources[0];
  if (!src) return [];
  const names = src.scan?.variable_names || [];
  const chosen = (src.chartVars?.length ? src.chartVars : [varOf(src, 0)])
    .filter((v) => names.includes(v)).slice(0, MAX_SERIES);
  if (!chosen.length) chosen.push(varOf(src, 0));
  return chosen.map((variable, k) => ({ src, idx: 0, variable, slot: k }));
}
function scanVarOfPick(p){return(p.src.scan.variables||[]).find(v=>v.name===p.variable)||{name:p.variable};}
function stepsForPick(p){return variableTimes(p.src.scan,p.variable).length;}
/* Charting several variables of ONE file puts the same file name on every row,
 * so there the variable is what tells the series apart. */
function labelOfPick(p){return sources.length>1?p.src.name:p.variable;}
function resLabel(size){return size.native?`${size.w}\u00d7${size.h}`:`\u22481\u00b0 ${size.w}\u00d7${size.h}`;}
function stepsFor(src,idx){return variableTimes(src.scan,varOf(src,idx)).length;}
function hasTimeAxis(){return picksOf().some((p)=>stepsForPick(p)>1);}

function setPressed(id, on) { $(id).setAttribute('aria-pressed', String(on)); }

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Text wears ink tokens, never the series colour: the swatch carries identity.
function renderLegend(entries) { $('analysis-legend').innerHTML=entries.length<2?'':entries.map(e=>`<span class="lg"><span class="lg-swatch" style="background:var(--series-${e.slot+1})"></span>${escHtml(e.name)}${e.meta?` \u00b7 ${escHtml(e.meta)}`:``}</span>`).join(''); }

// The per-file stats table IS the accessibility table view required by the
// palette's light-mode contrast warning — it is not decoration.
function renderStatsTable(rows,extraLabel) { const head=`<thead><tr><th>file</th><th>n</th><th>min</th><th>max</th><th>mean</th><th>std</th>${extraLabel?`<th>${escHtml(extraLabel)}</th>`:``}</tr></thead>`;const body=rows.map(r=>{const st=r.stats,label=r.unit?`${r.name} (${r.unit})`:r.name;const cells=st.n===0?'<td>0</td><td>\u2013</td><td>\u2013</td><td>\u2013</td><td>\u2013</td>':`<td>${st.n}</td><td>${fmtNum(st.min)}</td><td>${fmtNum(st.max)}</td><td>${fmtNum(st.mean)}</td><td>${fmtNum(st.std)}</td>`;return`<tr><td>${escHtml(label)}</td>${cells}${extraLabel?`<td>${r.extra??`\u2013`}</td>`:``}</tr>`;}).join('');$('analysis-stats-table').innerHTML=head+`<tbody>${body}</tbody>`; }

// Space mode needs a grid per file, but only the primary is rendered. Sample every
// file on the PRIMARY's bbox/size/time so the transects are directly comparable.
async function gridForSource(src,idx,variable,bbox,time) { const size=nativeGridSize(scanVarOf(src,idx).shape,src.scan.bbox,bbox);const key=`${src.slot}|${variable}|${bbox.join(`,`)}|${size.w}x${size.h}|${time}`;if(gridCache.has(key))return{grid:gridCache.get(key),size};const token=++renderToken;const{grid}=await renderInWorker(token,{source:src.file,variable,bbox,width:size.w,height:size.h,ramp:$('ramp').value,time});if(grid)gridCache.set(key,grid);return{grid:grid??null,size}; }

// Whole-file scatter needs both files on one identical grid so matching array
// indices represent the same location.
async function scatterGrid(src, variable, bbox, w, h, time) {
  const key = `${src.slot}|${variable}|${bbox.join(',')}|${w}x${h}|${time}|scatter`;
  if (gridCache.has(key)) return gridCache.get(key);
  const token = ++renderToken;
  const { grid } = await renderInWorker(token, { source: src.file, variable, bbox, width: w, height: h, ramp: $('ramp').value, time });
  if (grid) gridCache.set(key, grid);
  return grid ?? null;
}

const fmtX = (x) => (typeof x === 'number' ? fmtNum(x) : String(x).replace('T', ' ').replace(':00Z', 'Z'));

function populateCompareControls() {
  const setup=$('compare-setup');
  if(!sources.length){setup.hidden=true;setup.innerHTML='';return;}
  setup.hidden=false;setup.innerHTML='';
  const names=sources[0]?.scan?.variable_names||[];

  /* Several files: one column picker each, as before -- the comparison is
   * across products, so the file is the identity and the variable is a detail. */
  if(sources.length>1){
    sources.forEach((src,i)=>{
      const vs=src?.scan?.variable_names||[];
      if(!vs.includes(src.chartVar))src.chartVar=vs[0]??'';
      const label=document.createElement('label');label.className='cmp-side';
      const tag=document.createElement('span');
      tag.className=`cmp-tag cmp-s${src.slot}`;
      tag.textContent=String.fromCharCode(65+i);          // A, B, C
      const sel=document.createElement('select');
      sel.id=`compare-${i}`;sel.setAttribute('aria-label',`${src.name} column`);
      for(const n of vs){const o=document.createElement('option');o.value=n;o.textContent=n;sel.appendChild(o);}
      sel.value=src.chartVar;
      sel.addEventListener('change',()=>onCompareChange(i,sel.id));
      label.appendChild(tag);label.appendChild(sel);setup.appendChild(label);
    });
    return;
  }

  /* One file: pick as many of ITS variables as there are series colours. The
   * file is already scanned, so every variable here costs nothing to offer --
   * what was missing was somewhere to say "and also chart this one". */
  const src=sources[0];
  if(!src.chartVars?.length)src.chartVars=[varOf(src,0)].filter(Boolean);
  src.chartVars=src.chartVars.filter((v)=>names.includes(v));
  if(!src.chartVars.length&&names.length)src.chartVars=[names[0]];

  src.chartVars.forEach((variable,k)=>{
    const label=document.createElement('label');label.className='cmp-side';
    const tag=document.createElement('span');
    tag.className=`cmp-tag cmp-s${k}`;
    tag.textContent=String(k+1);
    const sel=document.createElement('select');
    sel.id=`compare-var-${k}`;sel.setAttribute('aria-label',`Series ${k+1} variable`);
    for(const n of names){const o=document.createElement('option');o.value=n;o.textContent=n;sel.appendChild(o);}
    sel.value=variable;
    sel.addEventListener('change',()=>{src.chartVars[k]=sel.value;src.chartVar=src.chartVars[0];gridCache.clear();populateCompareControls();refreshAnalysis();});
    label.appendChild(tag);label.appendChild(sel);
    /* Only offer removal down to one series -- an empty chart is not a state
     * worth being able to reach by clicking. */
    if(src.chartVars.length>1){
      const rm=document.createElement('button');
      rm.type='button';rm.className='cmp-rm';rm.textContent='×';
      rm.title=`Remove ${variable}`;rm.setAttribute('aria-label',`Remove ${variable}`);
      rm.addEventListener('click',()=>{src.chartVars.splice(k,1);src.chartVar=src.chartVars[0];gridCache.clear();populateCompareControls();refreshAnalysis();});
      label.appendChild(rm);
    }
    setup.appendChild(label);
  });

  const unused=names.filter((n)=>!src.chartVars.includes(n));
  if(unused.length&&src.chartVars.length<MAX_SERIES){
    const add=document.createElement('button');
    add.type='button';add.className='cmp-add';add.textContent='+ variable';
    add.title=`Chart another variable of ${src.name}`;
    add.addEventListener('click',()=>{src.chartVars.push(unused[0]);gridCache.clear();populateCompareControls();refreshAnalysis();});
    setup.appendChild(add);
  }
}
function onCompareChange(i,id){const src=sources[i];if(!src)return;src.chartVar=$(id).value;gridCache.clear();refreshAnalysis();}

async function refreshAnalysis() {
  const lat=parseFloat($('q-lat').value),lon=parseFloat($('q-lon').value);if(!sources.length)return;if(analysisMode!=='whole'&&(!Number.isFinite(lat)||!Number.isFinite(lon)))return;
  $('analysis-axis').hidden=analysisMode!=='space';setPressed('analysis-mode-time',analysisMode==='time');setPressed('analysis-mode-space',analysisMode==='space');setPressed('analysis-mode-whole',analysisMode==='whole');setPressed('analysis-axis-lon',analysisAxis==='lon');setPressed('analysis-axis-lat',analysisAxis==='lat');
  if(analysisMode==='whole'){
    const time=parseInt($('time').value,10)||0;lastSeriesList=[];updateNavUI(false);
    const rows=[];if(sources.length>1)setStatus('Sampling files\u2026','busy');
    for(const[idx,src]of sources.entries()){
      const variable=varOf(src,idx);let grid=null;
      try{({grid}=await gridForSource(src,idx,variable,src.scan.bbox,time));}catch(err){console.error(err);}
      if(!grid){rows.push({name:`${src.name} (unavailable)`,stats:computeStats([]),unit:''});continue;}
      const conv=convertSeries(grid.data,resolveUnit(scanVarOf(src,idx)));
      rows.push({name:`${src.name} \u2014 ${variable}${conv.known?'':' (units unknown)'}`,stats:computeStats(conv.ys),unit:conv.unit||''});
    }
    if(sources.length<2){
      $('analysis-chart').innerHTML=`<p class='muted'>Add a second file to compare (A vs B).</p>`;
    }else{
      const ov=bboxIntersect(sources[0].scan.bbox,sources[1].scan.bbox);
      if(!ov){$('analysis-chart').innerHTML=`<p class='muted'>Files do not overlap spatially.</p>`;}
      else{
        const raw=nativeGridSize(scanVarOf(sources[0],0).shape,sources[0].scan.bbox,ov);
        const w=Math.min(96,raw.w),h=Math.min(96,raw.h);
        const unitA=resolveUnit(scanVarOf(sources[0],0)),unitB=resolveUnit(scanVarOf(sources[1],1));
        let gA=null,gB=null;
        try{gA=await scatterGrid(sources[0],varOf(sources[0],0),ov,w,h,time);gB=await scatterGrid(sources[1],varOf(sources[1],1),ov,w,h,time);}catch(err){console.error(err);}
        const convA=gA?convertSeries(gA.data,unitA):{ys:[],unit:unitA};
        const convB=gB?convertSeries(gB.data,unitB):{ys:[],unit:unitB};
        const pairs=pairGrids(convA.ys,convB.ys,{cap:4000});
        $('analysis-chart').innerHTML=pairs.length
          ?renderScatterSVG(pairs,{xLabel:varOf(sources[0],0),yLabel:varOf(sources[1],1),unitX:convA.unit||'',unitY:convB.unit||'',oneToOne:sameUnit(unitA,unitB),stats:{r:pearson(pairs),bias:meanBias(pairs)}})
          :`<p class='muted'>Files do not overlap spatially.</p>`;
      }
    }
    if(sources.length>1)setStatus(`Comparing ${sources.length} files`,'ok');
    $('analysis-title').textContent=sources.length>1?`${sources.map((s,i)=>varOf(s,i)).join(' vs ')} \u2014 whole file`:`${varOf(sources[0],0)} \u2014 whole file`;
    renderLegend(sources.length>1?sources.map((s)=>({slot:s.slot,name:s.name,meta:''})):[]);
    renderStatsTable(rows,null);
    return;
  }
  const time=parseInt($('time').value,10)||0,list=[],rows=[],legend=[],units=[],series=picksOf();
  const pushSeries=(p,n,ser,size)=>{const resolved=resolveUnit(scanVarOfPick(p)),conv=convertSeries(ser.ys,resolved);units[n]=conv.unit??'';list.push({xs:ser.xs,ys:conv.ys,xLabel:ser.xLabel,slot:p.slot,unit:conv.unit??''});const meta=[p.variable,conv.unit||(conv.known?'':'units unknown'),size?resLabel(size):null].filter(Boolean).join(' · ');legend.push({slot:p.slot,name:labelOfPick(p),meta});rows.push({name:`${labelOfPick(p)} — ${p.variable}${conv.known?``:` (units unknown)`}`,stats:computeStats(conv.ys),unit:conv.unit||''});};
  if(analysisMode==='space'){if(!lastGrid||!extractBbox){$('analysis-chart').innerHTML='';return;}if(series.length>1)setStatus('Sampling…','busy');for(const[n,p]of series.entries()){let grid=null,size=null;try{({grid,size}=await gridForSource(p.src,p.idx,p.variable,extractBbox,time));}catch(err){console.error(err);}if(!grid){rows.push({name:`${labelOfPick(p)} (unavailable)`,stats:computeStats([]),unit:''});continue;}pushSeries(p,n,seriesFromGrid(grid,{lat,lon,axis:analysisAxis}),size);}if(series.length>1)setStatus(`Comparing ${series.length} series`,'ok');}
  else{$('analysis-chart').innerHTML='<p class="muted">Reading time series…</p>';for(const[n,p]of series.entries()){const t2=Math.max(0,stepsForPick(p)-1);let points=null;try{const r=await extract(p.src.file,{variable:p.variable,lat,lon,t1:0,t2});points=r?.timeseries??[];}catch(err){console.error(err);}if(!points){rows.push({name:`${labelOfPick(p)} (failed)`,stats:computeStats([]),unit:''});continue;}pushSeries(p,n,seriesFromTimeseries(points),null);}}
  const titleVar=series.map((p)=>p.variable).join(' vs ');$('analysis-title').textContent=`${titleVar} @ ${fmtNum(lat)}, ${fmtNum(lon)}`;renderLegend(legend);
  /* Dual axis is only meaningful for a single pair. With three or more series a
   * second axis has no unambiguous owner, so require a shared unit and fall back
   * to one axis. All three Idalia products are in mm, so this never fires there. */
  const sourceUnits=series.map((p)=>resolveUnit(scanVarOfPick(p)));
  const dual=list.length===2&&!sameUnit(sourceUnits[0],sourceUnits[1]);lastSeriesList=list;lastDual=dual;lastUnits=units;drawChart();renderStatsTable(rows,analysisMode==='time'?'\u0394':null);
}

/* ── chart zoom / scroll ────────────────────────────────────────────────── */
// The data-x window for the current zoom/center; null at zoom 1 (whole range).
function currentViewOpt(fullMin, fullMax) {
  if (viewZoom <= 1 || !Number.isFinite(fullMin) || !(fullMax > fullMin)) return null;
  const span = (fullMax - fullMin) / viewZoom;
  const center = fullMin + viewCenter * (fullMax - fullMin);
  const min = Math.max(fullMin, Math.min(center - span / 2, fullMax - span));
  return { min, max: min + span };
}

function updateNavUI(enabled) {
  const nav = $('analysis-nav');
  if (!nav) return;
  nav.hidden = !enabled;
  const zoomed = viewZoom > 1;
  $('an-scroll').disabled = !zoomed;
  $('an-scroll').value = String(viewCenter);
  $('an-zoom-out').disabled = !zoomed;
  $('an-zoom-reset').disabled = !zoomed;
}

// Redraw the chart SVG from the cached series at the current zoom/scroll. Kept
// separate from refreshAnalysis so zooming/scrolling never re-extracts data.
function drawChart() {
  const probe = chartScale(lastSeriesList, { dualAxis: lastDual });
  const fullMin = probe.fullMin, fullMax = probe.fullMax;
  lastViewDomain = currentViewOpt(fullMin, fullMax);
  $('analysis-chart').innerHTML = renderChartSVG(lastSeriesList, {
    formatY: fmtNum, formatX: fmtX, dualAxis: lastDual,
    unitLeft: lastUnits[0] || '', unitRight: lastUnits[1] || '', view: lastViewDomain,
  });
  updateNavUI(Number.isFinite(fullMin) && fullMax > fullMin && lastSeriesList.length > 0);
}

function resetView() { viewZoom = 1; viewCenter = 0.5; }

function setZoom(z) {
  viewZoom = Math.max(1, Math.min(64, z));
  if (viewZoom === 1) viewCenter = 0.5;
  drawChart();
}

function openAnalysis() {
  if (!lastGrid) { setStatus('Render an area first.', 'error'); return; }
  if (!Number.isFinite(parseFloat($('q-lat').value)) || !Number.isFinite(parseFloat($('q-lon').value))) {
    setStatus('Click the map to pick a point first.', 'error');
    return;
  }
  // Prefer the time axis when any file has one; fall back to space otherwise.
  analysisMode = hasTimeAxis() ? 'time' : 'space';
  $('analysis-mode-time').disabled = !hasTimeAxis();
  $('analysis-mode-time').title = hasTimeAxis() ? '' : 'file has one timestep';
  populateCompareControls();
  resetView();
  $('analysis-panel').hidden = false;
  refreshAnalysis();
}

function closeAnalysis() {
  const panel = $('analysis-panel');
  if (panel) panel.hidden = true;
  lastSeriesList = [];
  const ro = $('analysis-readout');
  if (ro) ro.innerHTML = '';
}

$('analyze-btn').addEventListener('click', openAnalysis);
$('analysis-close').addEventListener('click', closeAnalysis);
$('analysis-mode-time').addEventListener('click', () => { analysisMode = 'time'; resetView(); refreshAnalysis(); });
$('analysis-mode-space').addEventListener('click', () => { analysisMode = 'space'; resetView(); refreshAnalysis(); });
$('analysis-mode-whole').addEventListener('click', () => { analysisMode = 'whole'; resetView(); refreshAnalysis(); });
$('analysis-axis-lon').addEventListener('click', () => { analysisAxis = 'lon'; resetView(); refreshAnalysis(); });
$('analysis-axis-lat').addEventListener('click', () => { analysisAxis = 'lat'; resetView(); refreshAnalysis(); });
$('an-zoom-in').addEventListener('click', () => setZoom(viewZoom * 1.6));
$('an-zoom-out').addEventListener('click', () => setZoom(viewZoom / 1.6));
$('an-zoom-reset').addEventListener('click', () => { resetView(); drawChart(); });
$('an-scroll').addEventListener('input', () => { viewCenter = parseFloat($('an-scroll').value); drawChart(); });

/* Drag the window by its title bar. Non-modal on purpose: the map stays live
   underneath, so you can shove the window aside, click a new point, and watch the
   chart refresh — which is why this is not a modal dialog. */
let apDrag = null;

$('analysis-head').addEventListener('mousedown', (event) => {
  // Let the mode/axis/close buttons keep their clicks.
  if (event.target.closest('button')) return;
  const r = $('analysis-panel').getBoundingClientRect();
  apDrag = { dx: event.clientX - r.left, dy: event.clientY - r.top };
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!apDrag) return;
  const p = $('analysis-panel');
  // Clamp so the window can never be dragged fully off-screen and stranded.
  const x = Math.max(0, Math.min(window.innerWidth - p.offsetWidth, event.clientX - apDrag.dx));
  const y = Math.max(0, Math.min(window.innerHeight - p.offsetHeight, event.clientY - apDrag.dy));
  p.style.left = `${x}px`;
  p.style.top = `${y}px`;
});

window.addEventListener('mouseup', () => { apDrag = null; });

/* Hover: track a point along the graph — a crosshair at the snapped sample, a dot
   on every series, and the values read out beside the legend. Marks are written
   into the SVG's <g class="ac-hover"> by DOM rather than re-rendering the chart:
   a 4-series transect is thousands of points and rebuilding that on every
   mousemove janks. */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function clearHoverMarks() {
  const g = $('analysis-chart').querySelector('.ac-hover');
  if (g) g.replaceChildren();
}

$('analysis-chart').addEventListener('mousemove', (event) => {
  if (!lastSeriesList.length) return;
  const svg = $('analysis-chart').querySelector('svg');
  const g = svg?.querySelector('.ac-hover');
  if (!svg || !g) return;
  const r = svg.getBoundingClientRect();
  if (!r.width) return;

  // Same scale the renderer drew with — never recompute it here, or the dot drifts.
  const sc = chartScale(lastSeriesList, { dualAxis: lastDual, view: lastViewDomain });
  if (!sc.ok) return;

  // Map client x → viewBox x. The SVG scales to fit its box, so go through the
  // rendered rect rather than assuming a 1:1 pixel mapping.
  const vbX = ((event.clientX - r.left) / r.width) * sc.width;
  const frac = Math.max(0, Math.min(1, (vbX - sc.plot.left) / sc.plot.w));
  const target = sc.xmin + frac * (sc.xmax - sc.xmin);

  // Snap to the closest VISIBLE sample across either series. A far-apart overlay
  // may have no file-A samples in file B's current window.
  let anchorSeries = -1, i0 = -1, snapDistance = Infinity;
  sc.nxs.forEach((nx, si) => {
    const i = nearestIndex(nx, target, lastViewDomain);
    const d = i < 0 ? Infinity : Math.abs(nx[i] - target);
    if (d < snapDistance) { anchorSeries = si; i0 = i; snapDistance = d; }
  });
  if (i0 < 0) return;
  const snappedX = sc.nxs[anchorSeries][i0];
  const cx = sc.px(snappedX);

  const marks = [svgEl('line', {
    x1: cx.toFixed(2), y1: sc.plot.top, x2: cx.toFixed(2), y2: sc.plot.top + sc.plot.h, class: 'ac-cross',
  })];

  const parts = lastSeriesList.map((s, si) => {
    // Each series snaps to its OWN nearest sample: with different sampling the
    // honest answer is the closest value that file actually has.
    const i = nearestIndex(sc.nxs[si], snappedX, lastViewDomain);
    if (i < 0) return '';
    const v = s.ys[i];
    const slot = s.slot ?? si;
    if (Number.isFinite(v)) {
      marks.push(svgEl('circle', {
        cx: sc.px(sc.nxs[si][i]).toFixed(2), cy: sc.py(v, si).toFixed(2), r: 4,
        class: `ac-hot ac-s${slot}`,
      }));
    }
    return `<span class="lg"><span class="lg-swatch" style="background:var(--series-${slot + 1})"></span>` +
           `<b>${Number.isFinite(v) ? fmtNum(v) : '–'}</b></span>`;
  }).filter(Boolean);

  g.replaceChildren(...marks);
  $('analysis-readout').innerHTML =
    `<span>@ ${escHtml(fmtX(lastSeriesList[anchorSeries].xs[i0]))}</span>` + parts.join('');
});

$('analysis-chart').addEventListener('mouseleave', () => {
  $('analysis-readout').innerHTML = '';
  clearHoverMarks();
});

/* ── boot ───────────────────────────────────────────────────────────────── */
function init() {
  map = new maplibregl.Map({
    container: 'map',
    // Minimal near-blank basemap: pale background + faint country outlines only,
    // so the data color ramp stays easy to read. Reuses the demotiles vector
    // source (no API key, no extra CDN dependency).
    style: {
      version: 8,
      sources: {
        countries: {
          type: 'vector',
          url: 'https://demotiles.maplibre.org/tiles/tiles.json',
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#f4f4f2' } },
        {
          id: 'country-borders',
          type: 'line',
          source: 'countries',
          'source-layer': 'countries',
          paint: { 'line-color': '#c8c8c8', 'line-width': 0.6 },
        },
      ],
    },
    center: [0, 20],
    zoom: 1,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('load', () => {
    attachClickQuery();
    // Prepared CanvasSource frames retain their original resolution on zoom;
    // geographic coordinates keep them aligned, intentionally trading sharpness
    // for zero re-decode during playback.
    map.on('moveend', () => { if (extractBbox && !animFrames) refreshLayer(); });
  });
}

init();
