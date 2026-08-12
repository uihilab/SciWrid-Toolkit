/*
 * scripts/fetch-grib2-tables.js — regenerate lib/grib2/param-table.js.
 *
 * WHY THIS EXISTS
 *
 * A GRIB2 message does not carry the name or the units of what it holds. It
 * carries three numbers -- discipline, parameter category, parameter number --
 * and the meaning lives in WMO Code Table 4.2, published in the Manual on Codes
 * (WMO-No. 306). Any reader has to bring that table with it.
 *
 * Numbers 192-254 in every category are reserved for the originating centre, so
 * they are NOT in Table 4.2 at all: NCEP's own parameters need NCEP's own table,
 * keyed on the centre id in Section 1. On a routine GFS file that is not a
 * detail -- of 50 parameters this library could not name, 32 were in the local
 * range and only 18 in the WMO range.
 *
 * WHY IT IS A SCRIPT AND NOT A RUNTIME FETCH
 *
 * The tables are static reference data. Compressed, all of Table 4.2 plus every
 * centre-local table costs about 36 KB against the ~370 KB the library already
 * ships, so fetching on demand would buy a few kilobytes and cost determinism:
 * the same file would name its variables differently depending on whether the
 * machine had network. For a toolkit whose output ends up in papers, two runs of
 * one analysis disagreeing about variable names is worse than a slightly larger
 * bundle. So the GET happens here, once, and the result is committed.
 *
 * Run:  node scripts/fetch-grib2-tables.js [--ref <git-ref>] [--check]
 *
 *   --check   report what WOULD change and exit non-zero if anything does,
 *             without writing. For refreshing deliberately rather than by
 *             accident.
 *
 * The report is the point. A refresh prints added/removed/renamed counts and
 * every changed name, so updating the table is a reviewable diff rather than a
 * silent overwrite.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'lib/grib2/param-table.js');

const REPO = 'ecmwf/eccodes';
/* eccodes publishes WMO's tables as plain text, one file per
 * discipline+category, versioned by WMO master table number. 37 is the newest
 * present; tables are additive across versions, so the newest is a superset for
 * everything we care about. */
const MASTER_TABLE = 37;

/* Centres with parameters of their own. Derived, not guessed: these are the
 * localConcepts directories that actually define entries in the 192-254 range.
 * egrr (UK Met Office), lfpw (Meteo-France) and eswi (SMHI) ship concept files
 * but define ZERO local parameters, so their data is already covered by Table
 * 4.2 and including them would add nothing. */
const LOCAL_CENTRES = ['kwbc', 'ecmf', 'edzw', 'cnmc', 'efkl'];

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const refArg = args.indexOf('--ref');
const REF = refArg >= 0 ? args[refArg + 1] : 'develop';

const raw = (p, sha) =>
  `https://raw.githubusercontent.com/${REPO}/${sha}/definitions/${p}`;

async function fetchText(url, { optional = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sciwrid-toolkit-build' } });
      if (res.status === 404 && optional) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) {
        if (optional) return null;
        throw new Error(`fetch failed for ${url}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

async function fetchJson(url) {
  const txt = await fetchText(url);
  return JSON.parse(txt);
}

/* Pin the moving ref to the commit it points at, so a regenerated table records
 * exactly what it was built from and two runs a month apart are comparable. */
async function resolveSha(ref) {
  const j = await fetchJson(`https://api.github.com/repos/${REPO}/commits/${ref}`);
  return j.sha;
}

/* ---------------------------------------------------------------- units ---
 * The two sources disagree on spelling. The WMO .table files write "kg m-2";
 * the localConcepts .def files write Fortran-style "kg m**-2". Both are valid
 * udunits and a human reads either, but a GRIB2 file draws on BOTH tables at
 * once, so leaving them alone makes one file report `kg m-2` for some variables
 * and `kg m**-2` for others -- and scan() publishes a DEDUPLICATED unit list,
 * which then lists one unit twice. Normalising to the CF-style spelling is what
 * keeps that list honest, and matches what the NetCDF and Zarr paths report for
 * the same quantity. */
/* The solidus forms, mapped by hand rather than by regex.
 *
 * Only 17 distinct units in the whole corpus use "/", so an explicit table is
 * both auditable and safer than a rule -- because one of them is not a division
 * at all. "m2/3 s-1" is metres to the power two-thirds (Manning-style roughness
 * in the runoff parameters); a naive A/B -> A B-1 rewrite turns it into
 * nonsense. That single case is why this is a reviewed list and not three lines
 * of replace().
 *
 * "Joule/m2" folds to "J m-2" so it matches the "J kg-1" the rest of the table
 * uses -- it is the only place the unit is spelled out. */
const SOLIDUS_UNITS = {
  'K/m': 'K m-1',
  'm2/s': 'm2 s-1',
  'kg/kg': 'kg kg-1',
  'm/s': 'm s-1',
  'J/kg': 'J kg-1',
  'Pa/s': 'Pa s-1',
  'mol/mol': 'mol mol-1',
  'mol/s': 'mol s-1',
  'm3/s': 'm3 s-1',
  'N/m': 'N m-1',
  's/m': 's m-1',
  '/s': 's-1',
  '/kg': 'kg-1',
  '/m': 'm-1',
  'Joule/m2': 'J m-2',
  'TECU/min': 'TECU min-1',
  'm2/3 s-1': 'm2/3 s-1',        // NOT a division: m^(2/3). Left exactly as published.
};

/* Upstream spells a few units two ways. Mapped by hand, for the same reason as
 * SOLIDUS_UNITS: the obvious rule is wrong.
 *
 * Case-folding cannot be automatic -- "mm" and "Mm" are millimetre and
 * megametre, and "m" and "M" likewise -- so lowercasing to merge "Bq m-3" with
 * "bq m-3" would corrupt units it was never aimed at. Nor can whitespace be
 * stripped: "ms-1" reads as per-millisecond, not metres per second, and it is
 * only context that says which was meant here.
 *
 * Each entry resolves to the SI-correct spelling: Bq is the becquerel symbol,
 * and metres per second is "m s-1" with the space. */
const UNIT_ALIASES = {
  'ms-1': 'm s-1',
  'bq m-3': 'Bq m-3',
  'bq m-2': 'Bq m-2',
  /* Descriptive pseudo-units, not SI symbols. Upstream prints them both ways;
   * capitalised is the more common form in Table 4.2, so that is the one kept. */
  'numeric': 'Numeric',
  'proportion': 'Proportion',
  'fraction': 'Fraction',
  'degree': 'Degree',
  'degree true': 'Degree true',
};

/* Pairs that LOOK like one unit written two ways and are not.
 *
 * "s m-1" is seconds per metre; "S m-1" is siemens per metre, electrical
 * conductivity. Same letters, different quantity. Merging them would put a
 * conductivity in seconds, which is the exact failure the case-folding rule was
 * rejected to avoid -- so the pair is recorded here as deliberate, and the
 * near-duplicate report stays quiet about it instead of crying wolf. */
const DISTINCT_LOOKALIKES = [['s m-1', 'S m-1']];

const unmappedSolidus = new Set();

/* Normalise to one spelling of one unit.
 *
 * Three upstream inconsistencies land in this field, and all three break the
 * SAME thing. scan() publishes `units` as a DEDUPLICATED list
 * (lib/sciwrid-lib.js), and a single GRIB2 file draws parameters from both the
 * WMO table and its centre's local table:
 *
 *   - localConcepts writes Fortran exponents:  "kg m**-2"  vs  "kg m-2"
 *   - Table 4.2 itself mixes solidus and exponent forms, so 8 units appear
 *     BOTH ways within WMO's own data:  "m/s" and "m s-1", "J/kg" and "J kg-1"
 *   - stray whitespace
 *
 * Left alone, one file reports two spellings of one unit and the dedup lists it
 * twice. Normalising here also makes GRIB2 agree with what the NetCDF and Zarr
 * paths report for the same quantity, since those read CF-style units directly
 * from the file. */
function normaliseUnits(u) {
  if (!u) return '';
  let s = u.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (/^(unknown|undefined|-|n\/a)$/i.test(s)) return '';
  if (s.includes('/')) {
    if (Object.prototype.hasOwnProperty.call(SOLIDUS_UNITS, s)) return SOLIDUS_UNITS[s];
    /* Do not guess. A new solidus unit gets reported at the end of the run so
     * it can be added deliberately, and passes through unchanged meanwhile --
     * an unnormalised unit is a cosmetic problem, a wrongly rewritten one is a
     * wrong number's worth of trouble. */
    unmappedSolidus.add(s);
  }
  if (Object.prototype.hasOwnProperty.call(UNIT_ALIASES, s)) return UNIT_ALIASES[s];
  return s;
}

/* Catch the NEXT pair of spellings before it ships.
 *
 * Two strings that differ only by case or spacing are almost always one unit
 * written twice, and scan() publishes a deduplicated unit list that would then
 * carry it twice. This cannot fix them -- see UNIT_ALIASES for why the obvious
 * rule is unsafe -- so it reports them for a human to resolve. */
function reportNearDuplicates(wmo, local) {
  const all = [...Object.values(wmo), ...Object.values(local).flatMap((t) => Object.values(t))];
  const byShape = new Map();
  for (const [, u] of all) {
    if (!u) continue;
    const k = u.replace(/[\s/]/g, '').toLowerCase();
    if (!byShape.has(k)) byShape.set(k, new Set());
    byShape.get(k).add(u);
  }
  const known = new Set(DISTINCT_LOOKALIKES.map((p) => [...p].sort().join('|')));
  const dupes = [...byShape.values()]
    .filter((s) => s.size > 1)
    .map((s) => [...s])
    .filter((p) => !known.has([...p].sort().join('|')));
  if (!dupes.length) return;
  console.log(`\nWARNING: ${dupes.length} unit(s) appear in more than one spelling:`);
  for (const d of dupes) console.log(`    ${JSON.stringify(d)}`);
  console.log('  Add the wrong spelling to UNIT_ALIASES in this script, mapping it to');
  console.log('  the SI-correct form. Do NOT case-fold or strip spaces wholesale:');
  console.log('  "mm" vs "Mm" and "m s-1" vs "ms-1" are different units.');
}

const PLACEHOLDER = /^(reserved|missing|reserved for local use|unknown)/i;

/* --------------------------------------------------------- WMO Table 4.2 ---
 * Line format: "<code> <shortcut> <Name> (<units>)". A few rows carry no
 * parenthesised units at all; those are kept with empty units rather than
 * dropped, because the NAME is still worth having. */
function parseWmoTable(txt, discipline, category, into) {
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(\d+)\s+\S+\s+(.+)$/.exec(t);
    if (!m) continue;
    const number = Number(m[1]);
    let rest = m[2].trim();
    let units = '';
    const um = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(rest);
    if (um) { rest = um[1].trim(); units = um[2].trim(); }
    if (!rest || PLACEHOLDER.test(rest)) continue;
    into[`${discipline}.${category}.${number}`] = [rest, normaliseUnits(units)];
  }
}

/* ------------------------------------------------------- local concepts ---
 * eccodes .def format:
 *
 *   'Snow phase change heat flux' = {
 *        discipline = 0 ;
 *        parameterCategory = 0 ;
 *        parameterNumber = 192 ;
 *   }
 */
function parseConceptDef(txt) {
  const out = new Map();
  const re = /'([^']*)'\s*=\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(txt))) {
    const body = m[2];
    const num = (k) => {
      const r = new RegExp(`${k}\\s*=\\s*(\\d+)`).exec(body);
      return r ? Number(r[1]) : null;
    };
    const d = num('discipline'), c = num('parameterCategory'), n = num('parameterNumber');
    if (d !== null && c !== null && n !== null) out.set(`${d}.${c}.${n}`, m[1]);
  }
  return out;
}

/* WMO Common Code Table C-11 maps the ICAO-ish directory name eccodes uses
 * ("kwbc") to the numeric centre id a GRIB2 file actually carries in Section 1
 * (7). Read from source rather than transcribed, so the key we look up on
 * cannot be wrong. */
function parseCentres(txt) {
  const byAbbrev = new Map();
  for (const line of txt.split('\n')) {
    const m = /^(\d+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, id, abbrev, name] = m;
    if (/^\d+$/.test(abbrev)) continue;                  // no abbreviation
    if (!byAbbrev.has(abbrev)) byAbbrev.set(abbrev, { id: Number(id), name: name.trim() });
  }
  return byAbbrev;
}

/* --------------------------------------------------------------- report ---
 * A regenerated table is only trustworthy if you can see what moved. */
function diffReport(oldMod, wmo, local) {
  if (!oldMod) { console.log('  (no existing table — first generation)'); return true; }
  let changed = false;
  const compare = (label, before = {}, after = {}) => {
    const added = Object.keys(after).filter((k) => !(k in before));
    const removed = Object.keys(before).filter((k) => !(k in after));
    const renamed = Object.keys(after).filter(
      (k) => k in before && before[k][0] !== after[k][0]);
    const reunited = Object.keys(after).filter(
      (k) => k in before && before[k][1] !== after[k][1]);
    if (added.length || removed.length || renamed.length || reunited.length) changed = true;
    console.log(`  ${label}: +${added.length} added, -${removed.length} removed, ` +
                `${renamed.length} renamed, ${reunited.length} units changed`);
    for (const k of renamed.slice(0, 20))
      console.log(`      ${k}  "${before[k][0]}" -> "${after[k][0]}"`);
    for (const k of reunited.slice(0, 20))
      console.log(`      ${k}  units "${before[k][1]}" -> "${after[k][1]}"`);
  };
  compare('WMO', oldMod.WMO, wmo);
  for (const centre of new Set([...Object.keys(oldMod.LOCAL || {}), ...Object.keys(local)]))
    compare(`local centre ${centre}`, (oldMod.LOCAL || {})[centre], local[centre]);
  return changed;
}

/* ----------------------------------------------------------------- main --- */
const sha = await resolveSha(REF);
console.log(`eccodes ${REF} -> ${sha}`);
console.log(`WMO master table version ${MASTER_TABLE}\n`);

/* Discover which discipline/category tables exist rather than assuming. */
const listing = await fetchJson(
  `https://api.github.com/repos/${REPO}/contents/definitions/grib2/tables/${MASTER_TABLE}?ref=${sha}`);
const tableFiles = listing
  .map((x) => x.name)
  .filter((n) => /^4\.2\.\d+\.\d+\.table$/.test(n))
  .sort();

const wmo = {};
for (const file of tableFiles) {
  const [, d, c] = /^4\.2\.(\d+)\.(\d+)\.table$/.exec(file);
  const txt = await fetchText(raw(`grib2/tables/${MASTER_TABLE}/${file}`, sha));
  parseWmoTable(txt, Number(d), Number(c), wmo);
}
console.log(`WMO Table 4.2: ${tableFiles.length} files -> ${Object.keys(wmo).length} parameters`);

const centres = parseCentres(await fetchText(raw('common/c-11.table', sha)));

const local = {};
const centreNames = {};
for (const abbrev of LOCAL_CENTRES) {
  const info = centres.get(abbrev);
  if (!info) { console.log(`  ${abbrev}: not in C-11, skipped`); continue; }
  const nameTxt = await fetchText(raw(`grib2/localConcepts/${abbrev}/name.def`, sha), { optional: true });
  const unitTxt = await fetchText(raw(`grib2/localConcepts/${abbrev}/units.def`, sha), { optional: true });
  if (!nameTxt || !unitTxt) { console.log(`  ${abbrev}: concept files missing, skipped`); continue; }

  const names = parseConceptDef(nameTxt), units = parseConceptDef(unitTxt);
  const table = {};
  for (const [key, name] of names) {
    const [, cat, num] = key.split('.').map(Number);
    /* Only the local range. Everything below 192 is WMO's, and a centre's copy
     * of it would just be a second place for the same answer to drift. */
    if (num < 192 && cat < 192) continue;
    if (PLACEHOLDER.test(name)) continue;
    table[key] = [name, normaliseUnits(units.get(key))];
  }
  if (!Object.keys(table).length) { console.log(`  ${abbrev}: no local parameters, skipped`); continue; }
  local[info.id] = table;
  centreNames[info.id] = info.name;
  console.log(`  centre ${String(info.id).padStart(3)} ${abbrev.padEnd(6)} ` +
              `${Object.keys(table).length} local parameters   (${info.name})`);
}

/* Loud, because silence here means a unit shipped in a spelling nothing else
 * in the table uses -- exactly the inconsistency this normalisation exists to
 * prevent. */
if (unmappedSolidus.size) {
  console.log(`\nWARNING: ${unmappedSolidus.size} unit(s) use "/" and are not in ` +
              'SOLIDUS_UNITS, so they were left as published:');
  for (const u of unmappedSolidus) console.log(`    ${JSON.stringify(u)}`);
  console.log('  Add each to SOLIDUS_UNITS in this script (check for fractional');
  console.log('  exponents like "m2/3" first — those are NOT divisions).');
}

reportNearDuplicates(wmo, local);

console.log('\nchanges:');
const oldMod = existsSync(OUT) ? await import(`file://${OUT}?t=${Date.now()}`) : null;
const changed = diffReport(oldMod, wmo, local);

if (CHECK_ONLY) {
  console.log(changed ? '\nCHANGED — run without --check to write.' : '\nup to date.');
  process.exitCode = changed ? 1 : 0;
} else {
  const body = `/*
 * lib/grib2/param-table.js — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * WMO Code Table 4.2 (parameter name + units by discipline, category and
 * number), plus the centre-local parameters that occupy the 192-254 range
 * Table 4.2 reserves and does not define.
 *
 * A GRIB2 message carries only the numbers; this is what turns them into a
 * name and a unit. Regenerate with:
 *
 *     node scripts/fetch-grib2-tables.js
 *
 * Source:  https://github.com/${REPO}
 *          definitions/grib2/tables/${MASTER_TABLE}  (WMO master table ${MASTER_TABLE})
 *          definitions/grib2/localConcepts/*         (centre-local parameters)
 *          definitions/common/c-11.table             (centre id <- abbreviation)
 * Pinned:  ${sha}
 *
 * eccodes is Apache-2.0; these tables transcribe WMO's published code tables.
 *
 * Units are normalised to CF-style spelling ("kg m-2", not "kg m**-2"): the two
 * upstream sources disagree, and a single GRIB2 file draws on both.
 */
export const MASTER_TABLE_VERSION = ${MASTER_TABLE};
export const SOURCE_COMMIT = ${JSON.stringify(sha)};

/* centre id -> human name, for diagnostics */
export const CENTRES = ${JSON.stringify(centreNames, null, 0)};

/* "<discipline>.<category>.<number>" -> [name, units] */
export const WMO = ${JSON.stringify(wmo)};

/* centre id -> { "<discipline>.<category>.<number>": [name, units] } */
export const LOCAL = ${JSON.stringify(local)};
`;
  writeFileSync(OUT, body);
  const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
  console.log(`\nwrote ${OUT} (${kb} KB, ${Object.keys(wmo).length} WMO + ` +
              `${Object.values(local).reduce((a, t) => a + Object.keys(t).length, 0)} local)`);
}
