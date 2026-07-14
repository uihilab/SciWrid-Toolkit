// examples/map-demo.js — MapLibre demo logic.
//
// Drop any supported file, pick a variable + ramp, see it overlaid on a real
// basemap, and click to read the underlying value. The heavy extractGrid call
// runs inline here (Phase 5); Phase 6 moves it into a Web Worker so pan/zoom
// stays smooth.

import { scan, extract } from '../index.js';
import { resolveRamp, sampleRamp } from '../lib/render/index.js';
import { validateBbox, resolutionBucket } from './map-demo-bbox.js';

const $ = (id) => document.getElementById(id);

let map;
let lastScan   = null;
let lastSource = null;
let boundsAssumed = false; // true when the file exposes no real bbox (GRIB2/NetCDF/Zarr)
let timeAxis = null;   // { kind, values } for the active variable; values are display labels
let renderToken = 0;   // bumped each refresh; stale worker responses are discarded
let extractBbox = null; // [minLon,minLat,maxLon,maxLat] - chosen extract region
let lastBucket = null;  // last rendered resolution bucket; lets pan skip re-extract
const MERCATOR_MAX_LAT = 85.05112878;

/* ── render worker ──────────────────────────────────────────────────────── */
// extractGrid + gridToImageData run off the main thread so pan/zoom stays
// smooth. Each request carries the current renderToken; responses with a stale
// token are ignored (cancellation).
const worker = new Worker(new URL('./map-demo.worker.js', import.meta.url), { type: 'module' });
const pending = new Map(); // token → { resolve, reject }

worker.onmessage = (e) => {
  const { requestId, image, range, error } = e.data;
  const slot = pending.get(requestId);
  if (!slot) return;            // already superseded / unknown
  pending.delete(requestId);
  if (error) slot.reject(new Error(error));
  else slot.resolve({ image, range });
};

function renderInWorker(token, payload) {
  return new Promise((resolve, reject) => {
    pending.set(token, { resolve, reject });
    worker.postMessage({ requestId: token, ...payload });
  });
}

/* ── status helpers ─────────────────────────────────────────────────────── */
function setStatus(msg, cls = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = cls;
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
}

/* ── legend ─────────────────────────────────────────────────────────────── */
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

/* --- render the chosen bbox into a MapLibre ImageSource ----------------- */
async function refreshLayer({ force = false } = {}) {
  if (!lastSource || !lastScan || !extractBbox) return;
  const variable = $('variable').value;
  const ramp     = $('ramp').value;
  if (!variable) return;

  const bbox = extractBbox;
  const { w: px, h: py } = bboxPixelSize(bbox);
  const bucket = `${resolutionBucket(px)}x${resolutionBucket(py)}`;
  if (!force && bucket === lastBucket) return;
  lastBucket = bucket;
  const token = ++renderToken;
  // Drop any earlier in-flight request — its response will be ignored.
  for (const [id, slot] of pending) {
    if (id !== token) { pending.delete(id); slot.reject(new Error('superseded')); }
  }
  setStatus('Rendering…', 'busy');
  try {
    const time = parseInt($('time').value, 10) || 0;
    const { image: img, range } = await renderInWorker(token, {
      source: lastSource, variable, bbox, width: px, height: py, ramp, time,
    });
    if (token !== renderToken) return; // a newer refresh superseded us

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
    setStatus(`${variable} — ${img.width}×${img.height}`, 'ok');
  } catch (e) {
    if (token !== renderToken) return;
    setStatus('Error: ' + e.message, 'error');
    console.error(e);
  }
}

/* ── file handling ──────────────────────────────────────────────────────── */
async function loadSource(file) {
  if (!file) return null;
  lastSource = file;
  setStatus('Scanning…', 'busy');
  try {
    lastScan = await scan(file);
    // TIFF exposes a real bbox from the file's geokeys. GRIB2/NetCDF/Zarr do
    // not surface geographic bounds to JS, so we fall back to global and flag
    // the bounds as assumed.
    const hasBbox = Array.isArray(lastScan.bbox) && lastScan.bbox.length === 4;
    boundsAssumed = !hasBbox;
    if (!hasBbox) lastScan.bbox = [-180, -90, 180, 90];
    populateVariablePicker(lastScan.variable_names || []);
    populateTimePicker(lastScan, $('variable').value);
    updateQueryUI();

    extractBbox = null;
    lastBucket = null;
    if (map.getLayer('data-layer')) { map.removeLayer('data-layer'); map.removeSource('data-source'); }

    fitMapToBbox(lastScan.bbox);

    $('extract').hidden = false;
    prefillExtractInputs(lastScan.bbox);
    validateAndSketch();
    setStatus('Set an area and click "Render area".', '');
    return lastScan;
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    console.error(err);
    return null;
  }
}

$('file').addEventListener('change', (e) => loadSource(e.target.files[0]));

$('variable').addEventListener('change', () => {
  populateTimePicker(lastScan, $('variable').value);
  updateQueryUI();
  refreshLayer({ force: true });
});
$('time').addEventListener('change', () => refreshLayer({ force: true }));
$('ramp').addEventListener('change', () => refreshLayer({ force: true }));

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
  $('q-result').className = 'muted';
  drawBboxDebug();
}

// Debug readout: print the raw bbox min/max so the data extent can be
// eyeballed against the map. Shows whether bounds are real or assumed.
function drawBboxDebug() {
  const el = $('q-bbox-debug');
  if (!el) return;
  const b = lastScan?.bbox;
  if (!Array.isArray(b) || b.length !== 4) { el.textContent = '–'; return; }
  const [minLon, minLat, maxLon, maxLat] = b;
  el.textContent =
    `bbox ${boundsAssumed ? '(ASSUMED global)' : '(from file)'}\n` +
    `  lon min ${minLon.toFixed(4)}   max ${maxLon.toFixed(4)}\n` +
    `  lat min ${minLat.toFixed(4)}   max ${maxLat.toFixed(4)}\n` +
    `  span  ${(maxLon - minLon).toFixed(4)}° × ${(maxLat - minLat).toFixed(4)}°`;
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
  res.textContent = 'Querying…'; res.className = 'muted';
  try {
    const time = parseInt($('time').value, 10) || 0;
    const r = await extract(lastSource, { variable, lat, lon, t1: time, t2: time });
    const { value, when } = pickValue(r);
    if (value == null) {
      res.textContent = 'no data at this location'; res.className = 'muted';
    } else {
      res.textContent = `${variable} = ${fmtNum(value)}` + (when ? `  @ ${when}` : '');
      res.className = 'ok';
    }
    if (popup) {
      const body = value == null ? 'no data here'
        : `${fmtNum(value)}${when ? `<br><span style="opacity:.7;font-size:11px">@ ${when}</span>` : ''}`;
      new maplibregl.Popup().setLngLat([lon, lat])
        .setHTML(`<strong>${variable}</strong><br>${body}`).addTo(map);
    }
  } catch (err) {
    res.textContent = 'Error: ' + err.message; res.className = 'error';
    console.error(err);
  }
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
    body: 'Choose a supported GRIB2, NetCDF, Zarr-zip, or TIFF file from the File picker in the sidebar.',
  },
  {
    title: 'Scan the data',
    body: 'The toolkit scans the file locally and fills in the variables and time steps it contains.',
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
    title: 'Try the bundled example',
    body: 'Load the included GFS forecast file to scan it and render its first variable automatically.',
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
$('help-back').addEventListener('click', () => {
  if (helpIndex > 0) { helpIndex -= 1; renderHelpStep(); }
});
$('help-next').addEventListener('click', () => {
  if (helpIndex < HELP_STEPS.length - 1) { helpIndex += 1; renderHelpStep(); }
});
$('help-overlay').addEventListener('click', (event) => {
  if (event.target === $('help-overlay')) closeHelp();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('help-overlay').hidden) closeHelp();
});
async function runExample() {
  setStatus('Loading example... (40 MB)', 'busy');
  let file;
  try {
    const response = await fetch('./timeseries/gfs.t06z.pgrb2.1p00.f000');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    file = new File([blob], 'gfs.t06z.pgrb2.1p00.f000', { type: blob.type });
  } catch (err) {
    setStatus('Error loading example: ' + err.message, 'error');
    console.error(err);
    return;
  }

  const scanResult = await loadSource(file);
  if (!scanResult) return;
  extractBbox = scanResult.bbox;
  lastBucket = null;
  fitMapToBbox(extractBbox);
  await refreshLayer({ force: true });
}

$('help-view-example').addEventListener('click', () => {
  closeHelp();
  runExample();
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
    map.on('moveend', () => { if (extractBbox) refreshLayer(); });
  });
}

init();
