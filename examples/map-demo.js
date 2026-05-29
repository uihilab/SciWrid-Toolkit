// examples/map-demo.js — MapLibre demo logic.
//
// Drop any supported file, pick a variable + ramp, see it overlaid on a real
// basemap, and click to read the underlying value. The heavy extractGrid call
// runs inline here (Phase 5); Phase 6 moves it into a Web Worker so pan/zoom
// stays smooth.

import { scan, extract } from '../index.js';
import { resolveRamp, sampleRamp } from '../lib/render/index.js';

const $ = (id) => document.getElementById(id);

let map;
let lastScan   = null;
let lastSource = null;
let boundsAssumed = false; // true when the file exposes no real bbox (GRIB2/NetCDF/Zarr)
let timeAxis = null;   // { kind, values } for the active variable; values are display labels
let renderToken = 0;   // bumped each refresh; stale worker responses are discarded

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

/* ── bbox helpers ───────────────────────────────────────────────────────── */
// Intersection of two [minLon, minLat, maxLon, maxLat] boxes, or null.
function intersectBbox(a, b) {
  const minLon = Math.max(a[0], b[0]);
  const minLat = Math.max(a[1], b[1]);
  const maxLon = Math.min(a[2], b[2]);
  const maxLat = Math.min(a[3], b[3]);
  if (maxLon <= minLon || maxLat <= minLat) return null;
  return [minLon, minLat, maxLon, maxLat];
}

// MapLibre ImageSource wants 4 corner coords, clockwise from top-left.
function bboxToCoords([minLon, minLat, maxLon, maxLat]) {
  return [
    [minLon, maxLat], // top-left
    [maxLon, maxLat], // top-right
    [maxLon, minLat], // bottom-right
    [minLon, minLat], // bottom-left
  ];
}

function fitMapToBbox(bbox) {
  if (!bbox) return;
  const [minLon, minLat, maxLon, maxLat] = bbox;
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

/* ── render the current variable into a MapLibre ImageSource ────────────── */
async function refreshLayer() {
  if (!lastSource || !lastScan) return;
  const variable = $('variable').value;
  const ramp     = $('ramp').value;
  if (!variable) return;

  const b = map.getBounds();
  const viewportBbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const bbox = intersectBbox(viewportBbox, lastScan.bbox);
  if (!bbox) {
    setStatus('Viewport is outside the file coverage.', 'busy');
    if (map.getLayer('data-layer')) { map.removeLayer('data-layer'); map.removeSource('data-source'); }
    return;
  }

  // Keep output under 1024² to avoid multi-MB grids.
  const px = Math.min(1024, Math.max(64, Math.round(map.getCanvas().clientWidth)));
  const py = Math.min(1024, Math.max(64, Math.round(map.getCanvas().clientHeight)));

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
                     paint: { 'raster-opacity': 0.75 } });
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
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
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
    fitMapToBbox(lastScan.bbox);
    await refreshLayer();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    console.error(err);
  }
});

$('variable').addEventListener('change', () => {
  populateTimePicker(lastScan, $('variable').value);
  updateQueryUI();
  refreshLayer();
});
$('time').addEventListener('change', refreshLayer);
$('ramp').addEventListener('change', refreshLayer);

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

/* ── boot ───────────────────────────────────────────────────────────────── */
function init() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [0, 20],
    zoom: 1,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('load', () => {
    attachClickQuery();
    map.on('moveend', refreshLayer); // re-render on pan/zoom
  });
}

init();
