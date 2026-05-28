// examples/map-demo.js — MapLibre demo logic.
//
// Drop any supported file, pick a variable + ramp, see it overlaid on a real
// basemap, and click to read the underlying value. The heavy extractGrid call
// runs inline here (Phase 5); Phase 6 moves it into a Web Worker so pan/zoom
// stays smooth.

import { scan, extractGrid, extract, gridToImageData } from '../index.js';
import { resolveRamp, sampleRamp, autoRange } from '../lib/render/index.js';

const $ = (id) => document.getElementById(id);

let map;
let lastScan   = null;
let lastSource = null;
let renderToken = 0;   // bumped each refresh; stale renders are discarded

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
  setStatus('Rendering…', 'busy');
  try {
    const grid = await extractGrid(lastSource, { variable, bbox, width: px, height: py });
    if (token !== renderToken) return; // a newer refresh superseded us

    const range = autoRange(grid.data);
    const img = gridToImageData(grid, { ramp });

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
    if (!lastScan.bbox) {
      // Some readers expose bbox on variables; fall back to a sensible default.
      lastScan.bbox = lastScan.bbox || [-180, -90, 180, 90];
    }
    populateVariablePicker(lastScan.variable_names || []);
    fitMapToBbox(lastScan.bbox);
    await refreshLayer();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    console.error(err);
  }
});

$('variable').addEventListener('change', refreshLayer);
$('ramp').addEventListener('change', refreshLayer);

/* ── click-to-query ─────────────────────────────────────────────────────── */
function attachClickQuery() {
  map.on('click', async (e) => {
    if (!lastSource) return;
    const variable = $('variable').value;
    if (!variable) return;
    try {
      const r = await extract(lastSource, { variable, lat: e.lngLat.lat, lon: e.lngLat.lng });
      const val = r && r.value;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`<strong>${variable}</strong><br>${val == null ? 'out of bounds' : Number(val).toFixed(4)}`)
        .addTo(map);
    } catch (err) {
      console.error(err);
    }
  });
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
