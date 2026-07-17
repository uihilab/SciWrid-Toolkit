// examples/map-demo.js — MapLibre demo logic.
//
// Drop any supported file, pick a variable + ramp, see it overlaid on a real
// basemap, and click to read the underlying value. The heavy extractGrid call
// runs inline here (Phase 5); Phase 6 moves it into a Web Worker so pan/zoom
// stays smooth.

import { scan, extract } from '../index.js';
import { resolveRamp, sampleRamp } from '../lib/render/index.js';
import { validateBbox, resolutionBucket } from './map-demo-bbox.js';
import { computeStats, seriesFromGrid, seriesFromTimeseries, renderChartSVG, chartScale, nearestIndex, resolveUnit, convertSeries, sameUnit, nativeGridSize } from './map-demo-analysis.js';

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
// Exactly two files compared, A vs B. A drives the raster; B is chart-only.
const MAX_SOURCES = 2;
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

worker.onmessage = (e) => {
  const { requestId, image, range, grid, error } = e.data;
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
  gridCache.clear();  // bbox/size/time changed — cached non-primary grids are stale
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
    rm.setAttribute('aria-label', `Remove ${s.name}`);
    rm.addEventListener('click', () => removeSource(s.slot));
    li.append(rm);
    ul.append(li);
  });
  updateAddFileUI();
}

// Make the 4-file ceiling visible rather than something you discover by hitting it.
function updateAddFileUI() { const row=$('add-file-row'),btn=$('add-file-btn'),full=sources.length>=MAX_SOURCES; row.hidden=sources.length===0;btn.disabled=full;btn.textContent=full?'Two files loaded':'+ Add a file to compare';btn.title=full?'Remove a file to swap it (comparing two at a time).':'Add a second file; pick a column of each in Show analysis.';$('file-count').textContent=`${sources.length} / ${MAX_SOURCES}`; }

// Add a file to the comparison. Rejects only when it shares NO variable name with
// what is already loaded — identical sets is the wrong rule, since GFS f000 is a
// strict subset of f003 (accumulated fields do not exist at forecast hour 0).
async function addFile(file) { if(!file)return false;if(sources.length>=MAX_SOURCES){setStatus(`Comparing two files at a time — "${file.name}" not added.`,'error');return false;}setStatus(`Scanning ${file.name}…`,'busy');let scanResult;try{scanResult=await scan(file);}catch(err){setStatus(`Error scanning ${file.name}: ${err.message}`,'error');console.error(err);return false;}const names=scanResult.variable_names||[],hasBbox=Array.isArray(scanResult.bbox)&&scanResult.bbox.length===4;if(!hasBbox)scanResult.bbox=[-180,-90,180,90];sources.push({file,scan:scanResult,name:file.name,slot:firstFreeSlot(),boundsAssumed:!hasBbox,chartVar:names[0]??''});applyPrimary();setStatus(sources.length>1?`${file.name} added — pick a column of each in Show analysis.`:`${file.name} loaded.`,'ok');return true;}

function removeSource(slot) { const i=sources.findIndex(s=>s.slot===slot);if(i===-1)return;sources.splice(i,1);gridCache.clear();if(!sources.length){lastSource=null;lastScan=null;lastGrid=null;closeAnalysis();$('analyze-btn').hidden=true;$('extract').hidden=true;$('query').hidden=true;if(map.getLayer('data-layer')){map.removeLayer('data-layer');map.removeSource('data-source');}renderFileList();setStatus('Drop a file to begin.','');return;}applyPrimary();lastBucket=null;if(extractBbox)refreshLayer({force:true});if(!$('analysis-panel').hidden){populateCompareControls();refreshAnalysis();} }

// Point the single-file globals at sources[0] so refreshLayer / doPointQuery /
// updateQueryUI keep working unchanged.
function applyPrimary() { const p=sources[0];if(!p)return;const prevVar=$('variable').value;lastSource=p.file;lastScan=p.scan;boundsAssumed=p.boundsAssumed;const names=p.scan.variable_names||[];populateVariablePicker(names);if(names.includes(prevVar))$('variable').value=prevVar;populateTimePicker(lastScan,$('variable').value);updateQueryUI();renderFileList(); }

// Loading via the file input REPLACES the comparison set; addFile() appends.
async function loadSource(file) {
  if (!file) return null;
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
    title: 'Add up to 4 files to compare',
    body: 'Use "+ Add file to compare" to load up to 4 files at once — the sidebar shows how many you have. A file can only join if it shares a variable name with the ones already loaded, so you are always comparing like with like; anything that shares nothing is refused with a message. The first file is the PRIMARY: it draws the map layer, and the rest are charted alongside it.',
  },
  {
    title: 'Scan the data',
    body: 'The toolkit scans each file locally and fills in the variables and time steps it contains. With several files loaded, the variable list narrows to the ones they all share.',
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
    body: 'With a point picked, choose "Show analysis" to chart the value along an axis through it: over time when the file has a time axis, or across space when it does not. Every loaded file becomes its own line, so you can compare them directly. The window floats — drag it by its title bar to keep the map clickable, and resize it from its corner.',
  },
  {
    title: 'Try the bundled example',
    body: 'Load the included GFS forecast — four timesteps, three hours apart — to scan and render it automatically. Then click the map and choose "Show analysis" to chart how the value changes over time.',
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
// The bundled example joins four forecast hours into one 4-timestep GRIB2 file.
const EXAMPLE_PARTS = [
  './timeseries/gfs.t06z.pgrb2.1p00.f000',
  './timeseries/gfs.t06z.pgrb2.1p00.f003',
  './timeseries/gfs.t06z.pgrb2.1p00.f006',
  './timeseries/gfs.t06z.pgrb2.1p00.f009',
];

async function runExample() {
  let file;
  try {
    const blobs = [];
    for (const [i, url] of EXAMPLE_PARTS.entries()) {
      setStatus(`Loading example? (172 MB, ${i + 1}/${EXAMPLE_PARTS.length})`, 'busy');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url.split('/').pop()}: HTTP ${response.status}`);
      blobs.push(await response.blob());
    }
    file = new File([new Blob(blobs)], 'gfs_timeseries.grb2');
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
/* ── analysis panel ─────────────────────────────────────────────────────── */
// One chart, two x-axes: "value along an axis through the point you picked".
//   time mode  — value over time at (lat, lon); needs a real time axis
//   space mode — value along a lon/lat line through (lat, lon); always available
//                once a grid has rendered, because it is one row/column of it
// With several files loaded, every file becomes one series on the same frame.
let analysisMode = 'time', analysisAxis = 'lon';
let lastSeriesList = [];  // the series currently charted; the hover crosshair reads these

// Time mode is available when ANY loaded file has a real multi-step axis. A
// 1-step file among 4-step files renders as a single dot — honest, not a bug.
function stepsFor(src, variable) {
  return variableTimes(src.scan, variable).length;
}
function hasTimeAxis() {
  const v = $('variable').value;
  return sources.some((s) => stepsFor(s, v) > 1);
}

function setPressed(id, on) { $(id).setAttribute('aria-pressed', String(on)); }

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Text wears ink tokens, never the series colour: the swatch carries identity.
function renderLegend(entries) {
  $('analysis-legend').innerHTML = entries.length < 2 ? '' : entries.map((e) =>
    `<span class="lg"><span class="lg-swatch" style="background:var(--series-${e.slot + 1})"></span>${escHtml(e.name)}</span>`
  ).join('');
}

// The per-file stats table IS the accessibility table view required by the
// palette's light-mode contrast warning — it is not decoration.
function renderStatsTable(rows, extraLabel) {
  const head = `<thead><tr><th>file</th><th>n</th><th>min</th><th>max</th><th>mean</th><th>std</th>${extraLabel ? `<th>${escHtml(extraLabel)}</th>` : ''}</tr></thead>`;
  const body = rows.map((r) => {
    const s = r.stats;
    const cells = s.n === 0
      ? `<td>0</td><td>–</td><td>–</td><td>–</td><td>–</td>`
      : `<td>${s.n}</td><td>${fmtNum(s.min)}</td><td>${fmtNum(s.max)}</td><td>${fmtNum(s.mean)}</td><td>${fmtNum(s.std)}</td>`;
    return `<tr><td>${escHtml(r.name)}</td>${cells}${extraLabel ? `<td>${r.extra ?? '–'}</td>` : ''}</tr>`;
  }).join('');
  $('analysis-stats-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

// Space mode needs a grid per file, but only the primary is rendered. Sample every
// file on the PRIMARY's bbox/size/time so the transects are directly comparable.
async function gridForSource(src, variable, bbox, px, py, time) {
  if (src.slot === sources[0].slot && lastGrid) return lastGrid;
  const key = `${src.slot}|${variable}|${bbox.join(',')}|${px}x${py}|${time}`;
  if (gridCache.has(key)) return gridCache.get(key);
  const token = ++renderToken;
  const { grid } = await renderInWorker(token, {
    source: src.file, variable, bbox, width: px, height: py, ramp: $('ramp').value, time,
  });
  if (grid) gridCache.set(key, grid);
  return grid ?? null;
}

const fmtX = (x) => (typeof x === 'number' ? fmtNum(x) : String(x).replace('T', ' ').replace(':00Z', 'Z'));

async function refreshAnalysis() {
  const variable = $('variable').value;
  const lat = parseFloat($('q-lat').value);
  const lon = parseFloat($('q-lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !sources.length) return;

  $('analysis-title').textContent = `${variable} @ ${fmtNum(lat)}, ${fmtNum(lon)}`;
  $('analysis-axis').hidden = analysisMode !== 'space';
  setPressed('analysis-mode-time', analysisMode === 'time');
  setPressed('analysis-mode-space', analysisMode === 'space');
  setPressed('analysis-axis-lon', analysisAxis === 'lon');
  setPressed('analysis-axis-lat', analysisAxis === 'lat');
  renderLegend(sources.map((s) => ({ slot: s.slot, name: s.name })));

  const list = [], rows = [];
  const time = parseInt($('time').value, 10) || 0;

  if (analysisMode === 'space') {
    if (!lastGrid || !extractBbox) { $('analysis-chart').innerHTML = ''; return; }
    if (sources.length > 1) setStatus('Sampling files…', 'busy');
    const { w: px, h: py } = bboxPixelSize(extractBbox);
    for (const s of sources) {
      let grid = null;
      try { grid = await gridForSource(s, variable, extractBbox, px, py, time); }
      catch (err) { console.error(err); }
      // One unreadable file must not blank the comparison.
      if (!grid) { rows.push({ name: `${s.name} (unavailable)`, stats: computeStats([]) }); continue; }
      const ser = seriesFromGrid(grid, { lat, lon, axis: analysisAxis });
      list.push({ ...ser, slot: s.slot });
      rows.push({ name: s.name, stats: computeStats(ser.ys) });
    }
    if (sources.length > 1) setStatus(`${variable} — ${sources.length} files`, 'ok');
  } else {
    $('analysis-chart').innerHTML = '<p class="muted">Reading time series…</p>';
    for (const s of sources) {
      // t2 is NOT clamped by the library and each file has its OWN axis — a shared
      // t2 would overrun the shorter file and append a phantom duplicate point.
      const t2 = Math.max(0, stepsFor(s, variable) - 1);
      let points = null;
      try {
        const r = await extract(s.file, { variable, lat, lon, t1: 0, t2 });
        points = r?.timeseries ?? [];
      } catch (err) { console.error(err); }
      if (!points) { rows.push({ name: `${s.name} (failed)`, stats: computeStats([]) }); continue; }
      const ser = seriesFromTimeseries(points);
      list.push({ ...ser, slot: s.slot });
      const finite = ser.ys.filter(Number.isFinite);
      rows.push({
        name: s.name,
        stats: computeStats(ser.ys),
        extra: finite.length > 1 ? fmtNum(finite[finite.length - 1] - finite[0]) : '–',
      });
    }
  }

  lastSeriesList = list;
  $('analysis-chart').innerHTML = renderChartSVG(list, { formatY: fmtNum, formatX: fmtX });
  renderStatsTable(rows, analysisMode === 'time' ? 'Δ' : null);
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
$('analysis-mode-time').addEventListener('click', () => { analysisMode = 'time'; refreshAnalysis(); });
$('analysis-mode-space').addEventListener('click', () => { analysisMode = 'space'; refreshAnalysis(); });
$('analysis-axis-lon').addEventListener('click', () => { analysisAxis = 'lon'; refreshAnalysis(); });
$('analysis-axis-lat').addEventListener('click', () => { analysisAxis = 'lat'; refreshAnalysis(); });

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
  const sc = chartScale(lastSeriesList, {});
  if (!sc.ok) return;

  // Map client x → viewBox x. The SVG scales to fit its box, so go through the
  // rendered rect rather than assuming a 1:1 pixel mapping.
  const vbX = ((event.clientX - r.left) / r.width) * sc.width;
  const frac = Math.max(0, Math.min(1, (vbX - sc.plot.left) / sc.plot.w));
  const target = sc.xmin + frac * (sc.xmax - sc.xmin);

  // Snap to a real sample on the first series: the crosshair should land on data,
  // not float between points.
  const i0 = nearestIndex(sc.nxs[0], target);
  if (i0 < 0) return;
  const snappedX = sc.nxs[0][i0];
  const cx = sc.px(snappedX);

  const marks = [svgEl('line', {
    x1: cx.toFixed(2), y1: sc.plot.top, x2: cx.toFixed(2), y2: sc.plot.top + sc.plot.h, class: 'ac-cross',
  })];

  const parts = lastSeriesList.map((s, si) => {
    // Each series snaps to its OWN nearest sample: with different sampling the
    // honest answer is the closest value that file actually has.
    const i = nearestIndex(sc.nxs[si], snappedX);
    if (i < 0) return '';
    const v = s.ys[i];
    const slot = s.slot ?? si;
    if (Number.isFinite(v)) {
      marks.push(svgEl('circle', {
        cx: sc.px(sc.nxs[si][i]).toFixed(2), cy: sc.py(v).toFixed(2), r: 4,
        class: `ac-hot ac-s${slot}`,
      }));
    }
    return `<span class="lg"><span class="lg-swatch" style="background:var(--series-${slot + 1})"></span>` +
           `<b>${Number.isFinite(v) ? fmtNum(v) : '–'}</b></span>`;
  }).filter(Boolean);

  g.replaceChildren(...marks);
  $('analysis-readout').innerHTML =
    `<span>@ ${escHtml(fmtX(lastSeriesList[0].xs[i0]))}</span>` + parts.join('');
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
    map.on('moveend', () => { if (extractBbox) refreshLayer(); });
  });
}

init();
