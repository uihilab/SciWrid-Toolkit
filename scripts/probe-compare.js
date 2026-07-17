#!/usr/bin/env node
// Verify unit conversion and native sizing against the real AORC/GFS pair.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../index.js';
import { resolveUnit, convertToMetric, nativeGridSize } from '../examples/map-demo-analysis.js';
const dir=process.argv[2]||join(process.env.USERPROFILE||process.env.HOME||'.','Downloads');
const load=async(name)=>scan(new File([readFileSync(join(dir,name))],name));
const aorc=await load('aorc_20010101_south_states.nc'),gfs=await load('gfs_timeseries_slim.grb2');
const aTemp=(aorc.variables||[]).find(v=>v.name==='temp'),gTemp=(gfs.variables||[]).find(v=>v.name==='Temperature');
console.log('[probe] AORC temp:',resolveUnit(aTemp),convertToMetric(280,resolveUnit(aTemp)));
console.log('[probe] GFS Temperature:',resolveUnit(gTemp),convertToMetric(280,resolveUnit(gTemp)));
const target=[-100,28,-90,34],aSize=nativeGridSize(aTemp?.shape,aorc.bbox,target),gSize=nativeGridSize(gTemp?.shape,gfs.bbox,target);
console.log('[probe] AORC size:',aSize);console.log('[probe] GFS size:',gSize);
const ok=resolveUnit(aTemp)==='K'&&convertToMetric(280,resolveUnit(aTemp)).unit==='°C'&&resolveUnit(gTemp)==='K'&&aSize.native&&!gSize.native&&aSize.w>gSize.w;
console.log(ok?'\nPROBE PASS':'\nPROBE FAIL');process.exit(ok?0:1);
