import { readFileSync, writeFileSync } from 'node:fs';
import { scan, extractGrid, gridToPNG } from './index.js';

const buf = new Uint8Array(readFileSync('C:/Users/Khoa Le/Downloads/gfs_timeseries_slim.grb2'));
await scan(buf);
const variable = 'Temperature';
const full = await extractGrid(buf, { variable, bbox: [-180,-90,180,90], width: 720, height: 360, workers: 0 });
writeFileSync('./_full.png', await gridToPNG(full, { ramp: 'RdBu' }));
console.log('full rendered: 720x360, bbox', JSON.stringify(full.bbox));
const W=full.width,H=full.height,d=full.data;
let mn=Infinity,mx=-Infinity; for(const x of d){if(Number.isFinite(x)){if(x<mn)mn=x;if(x>mx)mx=x;}}
const cols=18, rows=9;
console.log('value range:', mn.toFixed(1), '..', mx.toFixed(1), '(K)');
console.log('temp map (#=warm .=cold), rows=lat 90..-90, cols=lon -180..180:');
for(let r=0;r<rows;r++){let line='';for(let c=0;c<cols;c++){const x=Math.floor((c+0.5)/cols*W),y=Math.floor((r+0.5)/rows*H);const v=d[y*W+x];const t=(v-mn)/(mx-mn);line+= !Number.isFinite(v)?' ':t>0.66?'#':t>0.33?'+':'.';}console.log('  '+line);}
