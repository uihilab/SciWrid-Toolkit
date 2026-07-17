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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);