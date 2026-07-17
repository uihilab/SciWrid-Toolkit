#!/usr/bin/env node
let passed = 0, failed = 0;
async function test(name, fn) { process.stdout.write(`  ${name} ... `); try { await fn(); passed++; console.log('OK'); } catch (e) { failed++; console.log('FAIL'); console.error('    ->', e.stack || e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`); }
function assertClose(a, b, msg, eps = 1e-6) { if (!(Math.abs(a - b) < eps)) throw new Error(`${msg}: got ${a}, want ~${b}`); }
const GRID = { width: 4, height: 3, bbox: [-180, -90, 180, 90], data: Float32Array.from([0,1,2,3,10,11,12,13,20,21,22,23]) };

console.log('[computeStats]');
await test('computes n/min/max/mean/std over finite values', async () => { const { computeStats } = await import('../examples/map-demo-analysis.js'); const s = computeStats([2,4,4,4,5,5,7,9]); assertEq(s.n,8,'n'); assertEq(s.min,2,'min'); assertEq(s.max,9,'max'); assertClose(s.mean,5,'mean'); assertClose(s.std,2,'std'); });
await test('ignores NaN and null', async () => { const { computeStats } = await import('../examples/map-demo-analysis.js'); const s = computeStats([1,NaN,3,null,undefined,5]); assertEq(s.n,3,'n'); assertEq(s.min,1,'min'); assertEq(s.max,5,'max'); assertClose(s.mean,3,'mean'); });
await test('all-NaN input yields n=0 and null stats', async () => { const { computeStats } = await import('../examples/map-demo-analysis.js'); const s = computeStats([NaN,NaN]); assertEq(s.n,0,'n'); assertEq(s.min,null,'min'); assertEq(s.mean,null,'mean'); assertEq(s.std,null,'std'); });
await test('single value yields std 0', async () => { const { computeStats } = await import('../examples/map-demo-analysis.js'); const s = computeStats([42]); assertEq(s.n,1,'n'); assertEq(s.min,42,'min'); assertEq(s.max,42,'max'); assertClose(s.std,0,'std'); });
await test('empty input yields n=0', async () => { const { computeStats } = await import('../examples/map-demo-analysis.js'); assertEq(computeStats([]).n,0,'n'); });

console.log('[seriesFromGrid - lon]');
await test('lon sweep walks one row west to east at the clicked lat', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); const s=seriesFromGrid(GRID,{lat:0,lon:0,axis:'lon'}); assertEq(JSON.stringify(s.ys),JSON.stringify([10,11,12,13]),'ys'); assertEq(JSON.stringify(s.xs),JSON.stringify([-180,-60,60,180]),'xs'); assert(/lon/i.test(s.xLabel),'label'); });
await test('lon sweep at north edge reads row 0 (north-up)', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); assertEq(JSON.stringify(seriesFromGrid(GRID,{lat:90,lon:0,axis:'lon'}).ys),JSON.stringify([0,1,2,3]),'ys'); });
await test('lon sweep at south edge reads the last row', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); assertEq(JSON.stringify(seriesFromGrid(GRID,{lat:-90,lon:0,axis:'lon'}).ys),JSON.stringify([20,21,22,23]),'ys'); });

console.log('[seriesFromGrid - lat]');
await test('lat sweep is oriented south to north, not inverted', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); const s=seriesFromGrid(GRID,{lat:0,lon:-180,axis:'lat'}); assertEq(JSON.stringify(s.xs),JSON.stringify([-90,0,90]),'xs'); assertEq(JSON.stringify(s.ys),JSON.stringify([20,10,0]),'ys'); assert(/lat/i.test(s.xLabel),'label'); });
await test('lat sweep picks the column nearest the clicked lon', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); assertEq(JSON.stringify(seriesFromGrid(GRID,{lat:0,lon:180,axis:'lat'}).ys),JSON.stringify([23,13,3]),'ys'); });
await test('out-of-range point is clamped into the grid', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); assertEq(JSON.stringify(seriesFromGrid(GRID,{lat:999,lon:999,axis:'lon'}).ys),JSON.stringify([0,1,2,3]),'ys'); });
await test('NaN cells survive into ys as NaN', async () => { const { seriesFromGrid } = await import('../examples/map-demo-analysis.js'); const g={...GRID,data:Float32Array.from([0,NaN,2,3,10,11,12,13,20,21,22,23])}; assert(Number.isNaN(seriesFromGrid(g,{lat:90,lon:0,axis:'lon'}).ys[1]),'NaN'); });

console.log('[seriesFromTimeseries]');
await test('maps points to xs/ys preserving order', async () => { const { seriesFromTimeseries } = await import('../examples/map-demo-analysis.js'); const s=seriesFromTimeseries([{time:'2026-04-14T06:00:00Z',value:100407},{time:'2026-04-14T09:00:00Z',value:100359}]); assertEq(JSON.stringify(s.xs),JSON.stringify(['2026-04-14T06:00:00Z','2026-04-14T09:00:00Z']),'xs'); assertEq(JSON.stringify(s.ys),JSON.stringify([100407,100359]),'ys'); assert(/time/i.test(s.xLabel),'label'); });
await test('null values become NaN so the line breaks', async () => { const { seriesFromTimeseries } = await import('../examples/map-demo-analysis.js'); const s=seriesFromTimeseries([{time:'a',value:null},{time:'b',value:5}]); assert(Number.isNaN(s.ys[0]),'NaN'); assertEq(s.ys[1],5,'ys'); });
await test('empty input yields empty series', async () => { const { seriesFromTimeseries } = await import('../examples/map-demo-analysis.js'); const s=seriesFromTimeseries([]); assertEq(s.xs.length,0,'xs'); assertEq(s.ys.length,0,'ys'); });

console.log('[renderChartSVG]');
await test('returns an svg element sized to the requested viewBox', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); const svg=renderChartSVG({xs:[0,1,2],ys:[1,2,3],xLabel:'X'},{width:480,height:180}); assert(svg.startsWith('<svg'),'start'); assert(svg.includes('viewBox="0 0 480 180"'),'viewBox'); assert(svg.trim().endsWith('</svg>'),'closed'); });
await test('draws a single polyline for a gap-free series', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); assertEq((renderChartSVG({xs:[0,1,2],ys:[1,2,3],xLabel:'X'},{}).match(/<polyline/g)||[]).length,1,'count'); });
await test('breaks the line into segments across missing data', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); assertEq((renderChartSVG({xs:[0,1,2,3,4],ys:[1,2,NaN,4,5],xLabel:'X'},{}).match(/<polyline/g)||[]).length,2,'count'); });
await test('renders a lone point as a circle, not a polyline', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); assert(renderChartSVG({xs:[0],ys:[5],xLabel:'X'},{}).includes('<circle'),'circle'); });
await test('an isolated point between gaps becomes a dot, not an invisible line', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); const svg=renderChartSVG({xs:[0,1,2],ys:[NaN,7,NaN],xLabel:'X'},{}); assertEq((svg.match(/<polyline/g)||[]).length,0,'lines'); assertEq((svg.match(/<circle/g)||[]).length,1,'dots'); });
await test('a flat series still renders inside the plot area', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); const svg=renderChartSVG({xs:[0,1,2],ys:[7,7,7],xLabel:'X'},{height:180}); assert(svg.includes('<polyline'),'line'); assert(!/NaN|Infinity/.test(svg),'finite'); });
await test('an all-missing series renders a no-data message and no polyline', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); const svg=renderChartSVG({xs:[0,1],ys:[NaN,NaN],xLabel:'X'},{}); assert(/no data/i.test(svg),'message'); assertEq((svg.match(/<polyline/g)||[]).length,0,'lines'); });
await test('an empty series renders a no-data message', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); assert(/no data/i.test(renderChartSVG({xs:[],ys:[],xLabel:'X'},{})),'message'); });
await test('escapes markup in labels', async () => { const { renderChartSVG }=await import('../examples/map-demo-analysis.js'); const svg=renderChartSVG({xs:[0,1],ys:[1,2],xLabel:'<script>x</script>'},{}); assert(!svg.includes('<script>'),'raw'); assert(svg.includes('&lt;script&gt;'),'escaped'); });
console.log('[numericXs]');

await test('passes numbers through unchanged', async () => {
  const { numericXs } = await import('../examples/map-demo-analysis.js');
  assertEq(JSON.stringify(numericXs([0, 5, 10])), JSON.stringify([0, 5, 10]), 'numbers');
});

await test('parses ISO time strings to epoch ms', async () => {
  const { numericXs } = await import('../examples/map-demo-analysis.js');
  const r = numericXs(['2026-04-14T06:00:00Z', '2026-04-14T09:00:00Z']);
  assertEq(r[1] - r[0], 3 * 3600 * 1000, 'three hours apart in ms');
});

// Regression guard for a real trap: Date.parse('step 0') returns 946706400000
// (year 2000), NOT NaN - V8's fallback parser scavenges digits out of any string.
// Relying on Date.parse alone would plot these at hallucinated dates years apart.
await test('falls back to index for unparseable labels', async () => {
  const { numericXs } = await import('../examples/map-demo-analysis.js');
  assertEq(JSON.stringify(numericXs(['step 0', 'step 1', 'step 2'])), JSON.stringify([0, 1, 2]), 'index fallback');
});

await test('does not mistake arbitrary text for a date', async () => {
  const { numericXs } = await import('../examples/map-demo-analysis.js');
  assertEq(JSON.stringify(numericXs(['run 3', 'run 4'])), JSON.stringify([0, 1]), 'index fallback');
});

await test('accepts a bare ISO date', async () => {
  const { numericXs } = await import('../examples/map-demo-analysis.js');
  const r = numericXs(['2026-04-14', '2026-04-15']);
  assertEq(r[1] - r[0], 24 * 3600 * 1000, 'one day apart in ms');
});

console.log('[renderChartSVG - x scale]');

// PAD.left = 46, PAD.right = 12 => plotW = 480 - 46 - 12 = 422.
// x=1 on a 0..10 domain must land at 46 + (1/10)*422 = 88.20 - NOT the index
// answer of 46 + (1/2)*422 = 257.00.
await test('positions points by x value, not by array index', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG({ xs: [0, 1, 10], ys: [1, 2, 3], xLabel: 'X' }, { width: 480, height: 180 });
  assert(svg.includes('88.20'), 'x=1 sits at 10% of the plot width');
  assert(!svg.includes('257.00'), 'x=1 is NOT at the index-based midpoint');
});

await test('positions ISO times on a real time scale', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  // 06:00, 09:00, 15:00 -> 09:00 is 3h into a 9h span = 33.3% => 46 + 0.3333*422 = 186.67
  const svg = renderChartSVG({
    xs: ['2026-04-14T06:00:00Z', '2026-04-14T09:00:00Z', '2026-04-14T15:00:00Z'],
    ys: [1, 2, 3], xLabel: 'T',
  }, { width: 480, height: 180 });
  assert(svg.includes('186.67'), 'uneven time sampling is honoured');
  assert(!svg.includes('257.00'), 'not index-positioned');
});

await test('index fallback still positions unparseable labels evenly', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG({ xs: ['a', 'b', 'c'], ys: [1, 2, 3], xLabel: 'X' }, { width: 480, height: 180 });
  assert(svg.includes('257.00'), 'middle label at the midpoint');
});

await test('a single point still centres in the plot area', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG({ xs: [7], ys: [5], xLabel: 'X' }, { width: 480, height: 180 });
  assert(svg.includes('<circle'), 'renders a dot');
  assert(svg.includes('257.00'), 'centred at PAD.left + plotW/2');
});

console.log('[renderChartSVG - multi-series]');

await test('accepts an array and draws one polyline per series', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([
    { xs: [0, 1, 2], ys: [1, 2, 3], xLabel: 'X', slot: 0 },
    { xs: [0, 1, 2], ys: [3, 2, 1], xLabel: 'X', slot: 1 },
  ], { width: 480, height: 180 });
  assertEq((svg.match(/<polyline/g) || []).length, 2, 'two lines');
});

await test('tags each series with its slot class', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([
    { xs: [0, 1], ys: [1, 2], slot: 0 },
    { xs: [0, 1], ys: [2, 3], slot: 3 },
  ], {});
  assert(svg.includes('ac-s0'), 'slot 0 class');
  assert(svg.includes('ac-s3'), 'slot 3 class');
});

// The whole point of the x-scale work: series sampled differently must align on a
// shared domain rather than each being stretched to the full width.
await test('series with different sampling share one x domain', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([
    { xs: [0, 10], ys: [1, 1], slot: 0 },
    { xs: [0, 1, 10], ys: [2, 2, 2], slot: 1 },
  ], { width: 480, height: 180 });
  assert(svg.includes('88.20'), 'x=1 lands at the shared-domain position');
  assert(svg.includes('468.00'), 'x=10 lands at the right edge');
});

await test('y domain spans every series, not just the first', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([
    { xs: [0, 1], ys: [0, 0], slot: 0 },
    { xs: [0, 1], ys: [100, 100], slot: 1 },
  ], {});
  const ys = [...svg.matchAll(/<polyline points="[\d.]+,([\d.]+)/g)].map((m) => m[1]);
  assert(ys.length === 2 && ys[0] !== ys[1], 'flat series separate under a shared y domain');
});

await test('a single series object still works unchanged', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG({ xs: [0, 1, 2], ys: [1, 2, 3], xLabel: 'X' }, {});
  assertEq((svg.match(/<polyline/g) || []).length, 1, 'one line');
});

await test('an empty list renders the no-data note', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  assert(/no data/i.test(renderChartSVG([], {})), 'says no data');
});

await test('a series with no finite values is skipped, others still draw', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([
    { xs: [0, 1], ys: [NaN, NaN], slot: 0 },
    { xs: [0, 1], ys: [1, 2], slot: 1 },
  ], {});
  assertEq((svg.match(/<polyline/g) || []).length, 1, 'the good series still draws');
});

console.log('[nearestIndex]');

await test('finds the closest value', async () => {
  const { nearestIndex } = await import('../examples/map-demo-analysis.js');
  assertEq(nearestIndex([0, 10, 20], 12), 1, 'closest to 12 is 10');
  assertEq(nearestIndex([0, 10, 20], 16), 2, 'closest to 16 is 20');
});

await test('handles exact hits and out-of-range', async () => {
  const { nearestIndex } = await import('../examples/map-demo-analysis.js');
  assertEq(nearestIndex([0, 10, 20], 10), 1, 'exact');
  assertEq(nearestIndex([0, 10, 20], -99), 0, 'below range');
  assertEq(nearestIndex([0, 10, 20], 999), 2, 'above range');
});

await test('empty array yields -1', async () => {
  const { nearestIndex } = await import('../examples/map-demo-analysis.js');
  assertEq(nearestIndex([], 5), -1, '-1');
});

console.log('[chartScale]');

await test('projects x the same way the renderer draws it', async () => {
  const { chartScale, renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const series = { xs: [0, 1, 10], ys: [1, 2, 3], xLabel: 'X' };
  const sc = chartScale(series, { width: 480, height: 180 });
  const svg = renderChartSVG(series, { width: 480, height: 180 });
  // The tracking dot rides on chartScale; the line comes from renderChartSVG. If
  // these ever disagree the dot floats off the line, so pin them together.
  const first = svg.match(/<polyline points="([\d.]+),([\d.]+)/);
  assertEq(sc.px(0).toFixed(2), first[1], 'x of first point');
  assertEq(sc.py(1).toFixed(2), first[2], 'y of first point');
});

await test('reports ok=false for an unplottable series', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  assertEq(chartScale({ xs: [0, 1], ys: [NaN, NaN] }, {}).ok, false, 'ok');
  assertEq(chartScale([], {}).ok, false, 'ok');
});

await test('exposes the shared domain across every series', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([
    { xs: [0, 5], ys: [1, 1], slot: 0 },
    { xs: [2, 20], ys: [9, 9], slot: 1 },
  ], {});
  assertEq(sc.xmin, 0, 'xmin');
  assertEq(sc.xmax, 20, 'xmax');
  assert(sc.vmin < 1 && sc.vmax > 9, 'y domain covers both series');
});

await test('exposes numeric xs per series for hover snapping', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: ['2026-04-14T06:00:00Z', '2026-04-14T09:00:00Z'], ys: [1, 2] }], {});
  assertEq(sc.nxs[0][0], Date.parse('2026-04-14T06:00:00Z'), 'nxs parsed');
});

await test('exposes plot geometry for the crosshair', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale({ xs: [0, 1], ys: [1, 2] }, { width: 480, height: 180 });
  assertEq(sc.plot.left, 46, 'plot.left');
  assertEq(sc.plot.w, 422, 'plot.w');
  assertEq(sc.plot.top, 10, 'plot.top');
  assertEq(sc.plot.h, 144, 'plot.h');
});

await test('renderChartSVG emits a hover layer for the tracking marks', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG({ xs: [0, 1], ys: [1, 2] }, {});
  assert(svg.includes('class="ac-hover"'), 'hover group present');
});


console.log('[units]');
await test('resolves declared and GRIB2 units',async()=>{const{resolveUnit}=await import('../examples/map-demo-analysis.js');assertEq(resolveUnit({name:'temp',units:'K'}),'K','declared');assertEq(resolveUnit({name:'Temperature'}),'K','table');assertEq(resolveUnit({name:'Wind (unknown)',units:''}),null,'unknown');});
await test('converts temperature and pressure',async()=>{const{convertToMetric}=await import('../examples/map-demo-analysis.js');const k=convertToMetric(280,'K'),p=convertToMetric(100000,'Pa');assertEq(k.unit,'°C','C');assertClose(k.value,6.85,'K');assertEq(p.unit,'hPa','hPa');assertClose(p.value,1000,'Pa');});
await test('preserves precip rates and converts speed/F',async()=>{const{convertToMetric}=await import('../examples/map-demo-analysis.js');assertEq(convertToMetric(5,'kg/m^2/day').unit,'mm/day','rate');assertClose(convertToMetric(10,'knots').value,5.14444,'knots',1e-4);assertClose(convertToMetric(32,'°F').value,0,'F');});
await test('unknown units pass through and NaN stays NaN',async()=>{const{convertToMetric}=await import('../examples/map-demo-analysis.js');const r=convertToMetric(.42,'kg/kg');assertEq(r.unit,'kg/kg','unit');assert(!r.known,'unknown');assert(Number.isNaN(convertToMetric(NaN,'K').value),'NaN');});
await test('convertSeries preserves gaps',async()=>{const{convertSeries}=await import('../examples/map-demo-analysis.js');const r=convertSeries([273.15,NaN,283.15],'K');assertEq(r.unit,'°C','unit');assertClose(r.ys[0],0,'zero');assertClose(r.ys[2],10,'ten');assert(Number.isNaN(r.ys[1]),'gap');});
await test('sameUnit requires equal known canonical units',async()=>{const{sameUnit}=await import('../examples/map-demo-analysis.js');assert(sameUnit('K','°C'),'same');assert(!sameUnit('K','Pa'),'different');assert(!sameUnit('kg/kg','kg/kg'),'unknown');});


console.log('[nativeGridSize]');
await test('scales known shape to target density',async()=>{const{nativeGridSize}=await import('../examples/map-demo-analysis.js');const r=nativeGridSize('1x1500x3300',[-106.49,25.01,-79,37.5],[-100,28,-90,34]);assertEq(r.w,1024,'width');assert(r.native,'native');});
await test('assumes one degree for unknown shape',async()=>{const{nativeGridSize}=await import('../examples/map-demo-analysis.js');const r=nativeGridSize(undefined,undefined,[-100,28,-90,34]);assertEq(r.w,10,'w');assertEq(r.h,8,'h floor');assert(!r.native,'assumed');});
await test('keeps at least eight samples',async()=>{const{nativeGridSize}=await import('../examples/map-demo-analysis.js');const r=nativeGridSize(undefined,undefined,[-100,30,-98,31]);assertEq(r.w,8,'w');assertEq(r.h,8,'h');});
await test('parses array shape trailing dimensions',async()=>{const{nativeGridSize}=await import('../examples/map-demo-analysis.js');const r=nativeGridSize([1,20,40],[-180,-90,180,90],[-90,-45,90,45]);assertEq(r.w,20,'w');assertEq(r.h,10,'h');});


console.log('[renderChartSVG - dual axis]');
await test('dual axis scales independently and labels units',async()=>{const{renderChartSVG}=await import('../examples/map-demo-analysis.js');const svg=renderChartSVG([{xs:[0,1],ys:[0,10]},{xs:[0,1],ys:[1000,2000]}],{dualAxis:true,unitLeft:'°C',unitRight:'hPa'});assertEq((svg.match(/<polyline/g)||[]).length,2,'lines');assert(svg.includes('°C')&&svg.includes('hPa'),'units');assert(svg.includes('ac-axis-r'),'right');});
await test('chartScale uses per-series domains in dual mode',async()=>{const{chartScale}=await import('../examples/map-demo-analysis.js');const sc=chartScale([{xs:[0,1],ys:[0,10]},{xs:[0,1],ys:[1000,2000]}],{dualAxis:true});assert(sc.dual,'dual');assert(sc.py(1000,0)!==sc.py(1000,1),'projection');});
await test('shared mode remains one domain',async()=>{const{chartScale}=await import('../examples/map-demo-analysis.js');const sc=chartScale([{xs:[0,1],ys:[0,0]},{xs:[0,1],ys:[100,100]}],{});assert(!sc.dual,'shared');assertEq(sc.domains.length,1,'domains');});

console.log('[chartScale - view window]');

await test('a view window maps its bounds to the plot edges', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: [0, 25, 50, 75, 100], ys: [1, 2, 3, 4, 5], slot: 0 }],
    { width: 480, height: 180, view: { min: 25, max: 75 } });
  assert(sc.ok, 'ok');
  assertEq(sc.fullMin, 0, 'full min preserved');
  assertEq(sc.fullMax, 100, 'full max preserved');
  assert(Math.abs(sc.px(25) - sc.plot.left) < 0.01, 'view min at the left edge');
  assert(Math.abs(sc.px(75) - (sc.plot.left + sc.plot.w)) < 0.01, 'view max at the right edge');
});

await test('y auto-rescales to the values inside the window', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: [0, 40, 50, 60, 100], ys: [1000, 10, 11, 12, 1000], slot: 0 }],
    { width: 480, height: 180, view: { min: 40, max: 60 } });
  assert(sc.domains[0].vmax < 20, `in-view vmax ~12, got ${sc.domains[0].vmax}`);
  assert(sc.domains[0].vmin > 5, `in-view vmin ~10, got ${sc.domains[0].vmin}`);
});

await test('no view means the full domain (regression)', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: [0, 10], ys: [1, 2], slot: 0 }], { width: 480, height: 180 });
  assertEq(sc.xmin, 0, 'xmin full');
  assertEq(sc.xmax, 10, 'xmax full');
  assertEq(sc.fullMin, 0, 'fullMin');
  assertEq(sc.fullMax, 10, 'fullMax');
});

await test('a degenerate/out-of-range view falls back to the full domain', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: [0, 10], ys: [1, 2], slot: 0 }],
    { width: 480, height: 180, view: { min: 5, max: 5 } });
  assertEq(sc.xmin, 0, 'fell back to full min');
  assertEq(sc.xmax, 10, 'fell back to full max');
});

await test('a window with no samples reports not-ok but keeps the full domain', async () => {
  const { chartScale } = await import('../examples/map-demo-analysis.js');
  const sc = chartScale([{ xs: [0, 1, 100, 101], ys: [1, 2, 3, 4], slot: 0 }],
    { width: 480, height: 180, view: { min: 40, max: 60 } });
  assert(!sc.ok, 'no data in the window');
  assertEq(sc.fullMax, 101, 'full domain still reported for the scrollbar');
});

console.log('[renderChartSVG - clip + view]');

await test('renders a clipPath and clips the marks to the plot area', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([{ xs: [0, 1, 2], ys: [1, 2, 3], slot: 0 }], { width: 480, height: 180 });
  assert(svg.includes('<clipPath'), 'clipPath defined');
  assert(/clip-path="url\(#ac-clip\)"/.test(svg), 'a group is clipped to the plot rect');
});

await test('x tick end labels follow the visible window', async () => {
  const { renderChartSVG } = await import('../examples/map-demo-analysis.js');
  const svg = renderChartSVG([{ xs: [0, 25, 50, 75, 100], ys: [1, 2, 3, 4, 5], slot: 0, xLabel: 'X' }],
    { width: 480, height: 180, view: { min: 25, max: 75 }, formatX: (x) => String(x) });
  assert(svg.includes('>25<'), 'low tick is the window start sample');
  assert(svg.includes('>75<'), 'high tick is the window end sample');
  assert(!svg.includes('>100<'), 'the out-of-window sample is not a tick');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);