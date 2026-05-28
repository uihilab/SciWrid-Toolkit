// lib/time-decoder.js
//
// CF-conventions time decoder. Convert numeric time-coordinate values into
// ISO-8601 strings given the original `units` attribute (and optional
// `calendar` attribute).
//
// Supported unit grammars (the only ones found in real files):
//   "seconds since YYYY-MM-DD[ HH:MM:SS[.fff][ +HH:MM]]"
//   "minutes since ..."
//   "hours since ..."
//   "days since ..."
//
// Supported calendars: standard (a.k.a. gregorian/proleptic_gregorian),
//                      noleap / 365_day,
//                      360_day.
// Any other calendar → throw, caller falls back to raw values.

const SECONDS_PER_UNIT = {
  second:  1,      seconds: 1,      sec: 1, secs: 1, s: 1,
  minute: 60,      minutes: 60,     min: 60, mins: 60,
  hour:  3600,     hours:  3600,    hr: 3600, hrs: 3600, h: 3600,
  day:   86400,    days:  86400,    d: 86400,
};

const STANDARD = new Set(['standard', 'gregorian', 'proleptic_gregorian', '']);
const NOLEAP   = new Set(['noleap', '365_day', '365']);
const D360     = new Set(['360_day', '360']);

export function parseCFUnits(units) {
  // Match "<unit> since <date>[ <time>][ <tz>]"
  const m = /^\s*([a-zA-Z]+)\s+since\s+(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?(?:\s*([+\-]\d{1,2}:?\d{0,2})|\s*Z)?\s*$/.exec(units);
  if (!m) throw new Error(`time-decoder: unrecognised units "${units}"`);
  const unit = m[1].toLowerCase();
  if (!(unit in SECONDS_PER_UNIT))
    throw new Error(`time-decoder: unsupported time unit "${unit}"`);
  const secondsPerUnit = SECONDS_PER_UNIT[unit];
  const year = +m[2], month = +m[3], day = +m[4];
  const hour = m[5] != null ? +m[5] : 0;
  const min  = m[6] != null ? +m[6] : 0;
  const sec  = m[7] != null ? Number(m[7]) : 0;
  // Timezone offset (CF default is UTC if absent or Z). Convert offset to
  // seconds; subtract from the epoch to normalise to UTC.
  let tzOffsetSec = 0;
  if (m[8]) {
    const tz = m[8].replace(':', '');
    const sign = tz[0] === '-' ? -1 : 1;
    const tzh = +tz.slice(1, 3);
    const tzm = +(tz.slice(3, 5) || '0');
    tzOffsetSec = sign * (tzh * 3600 + tzm * 60);
  }
  return { secondsPerUnit, epoch: { year, month, day, hour, min, sec, tzOffsetSec } };
}

export function normalizeCalendar(calendar) {
  const c = String(calendar || '').toLowerCase();
  if (STANDARD.has(c)) return 'standard';
  if (NOLEAP.has(c))   return 'noleap';
  if (D360.has(c))     return '360_day';
  throw new Error(`time-decoder: unsupported calendar "${calendar}"`);
}

// ── Standard (proleptic Gregorian) ──────────────────────────────────────
function standardEpochMs(e) {
  // JS Date.UTC handles proleptic Gregorian with leap years.
  return Date.UTC(e.year, e.month - 1, e.day, e.hour, e.min, Math.floor(e.sec))
       + (e.sec - Math.floor(e.sec)) * 1000
       - e.tzOffsetSec * 1000;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function formatSecs(s) {
  // Format seconds as "SS" or "SS.fff" — match the precision present in the input.
  if (Number.isInteger(s)) return pad2(s);
  const intPart = Math.floor(s);
  const frac = s - intPart;
  // Up to milliseconds, no trailing zeros.
  let fStr = frac.toFixed(3).slice(2).replace(/0+$/, '');
  if (fStr.length === 0) return pad2(intPart);
  return pad2(intPart) + '.' + fStr;
}
function standardToISO(epochMs, deltaSec) {
  const ms = epochMs + deltaSec * 1000;
  const d = new Date(ms);
  // Sub-second precision is carried only when deltaSec has it.
  const frac = ms - Math.floor(ms);
  const sec = d.getUTCSeconds() + frac / 1000;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}T` +
         `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${formatSecs(sec)}Z`;
}

// ── Noleap (365_day): every year has 365 days; no leap years. ────────────
const NOLEAP_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function noleapDayOfYear(month, day) {
  let d = 0;
  for (let m = 0; m < month - 1; m++) d += NOLEAP_MONTH_DAYS[m];
  return d + (day - 1);
}
function noleapToISO(epoch, deltaSec) {
  // Total seconds since (year=epoch.year, day-of-year=0, 00:00:00).
  let totalSec = noleapDayOfYear(epoch.month, epoch.day) * 86400
               + epoch.hour * 3600 + epoch.min * 60 + epoch.sec + deltaSec
               - epoch.tzOffsetSec;
  let dayOfYear = Math.floor(totalSec / 86400);
  let secOfDay  = totalSec - dayOfYear * 86400;
  let year = epoch.year + Math.floor(dayOfYear / 365);
  dayOfYear = ((dayOfYear % 365) + 365) % 365;
  let month = 1, doy = dayOfYear;
  while (month <= 12 && doy >= NOLEAP_MONTH_DAYS[month - 1]) {
    doy -= NOLEAP_MONTH_DAYS[month - 1];
    month++;
  }
  const day = doy + 1;
  const h = Math.floor(secOfDay / 3600); secOfDay -= h * 3600;
  const mi = Math.floor(secOfDay / 60);  secOfDay -= mi * 60;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(h)}:${pad2(mi)}:${formatSecs(secOfDay)}Z`;
}

// ── 360_day: every year has 360 days (12 × 30). ──────────────────────────
function d360ToISO(epoch, deltaSec) {
  let totalSec = ((epoch.month - 1) * 30 + (epoch.day - 1)) * 86400
               + epoch.hour * 3600 + epoch.min * 60 + epoch.sec + deltaSec
               - epoch.tzOffsetSec;
  let dayOfYear = Math.floor(totalSec / 86400);
  let secOfDay  = totalSec - dayOfYear * 86400;
  let year = epoch.year + Math.floor(dayOfYear / 360);
  dayOfYear = ((dayOfYear % 360) + 360) % 360;
  const month = Math.floor(dayOfYear / 30) + 1;
  const day = (dayOfYear % 30) + 1;
  const h = Math.floor(secOfDay / 3600); secOfDay -= h * 3600;
  const mi = Math.floor(secOfDay / 60);  secOfDay -= mi * 60;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(h)}:${pad2(mi)}:${formatSecs(secOfDay)}Z`;
}

/**
 * Decode numeric CF time values into ISO-8601 strings.
 *
 *   decodeTimes([0, 24, 48], 'hours since 2024-01-01', 'standard')
 *   // → ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z']
 *
 * @param {number[]|Float32Array|Float64Array} values
 * @param {string} unitsString
 * @param {string} [calendar='standard']
 * @returns {{ values: string[], unitsRaw: string, calendar: string }}
 */
export function decodeTimes(values, unitsString, calendar = 'standard') {
  const { secondsPerUnit, epoch } = parseCFUnits(unitsString);
  const cal = normalizeCalendar(calendar);

  const out = new Array(values.length);
  if (cal === 'standard') {
    const epochMs = standardEpochMs(epoch);
    for (let i = 0; i < values.length; i++) {
      const deltaSec = Number(values[i]) * secondsPerUnit;
      out[i] = standardToISO(epochMs, deltaSec);
    }
  } else if (cal === 'noleap') {
    for (let i = 0; i < values.length; i++)
      out[i] = noleapToISO(epoch, Number(values[i]) * secondsPerUnit);
  } else {  // 360_day
    for (let i = 0; i < values.length; i++)
      out[i] = d360ToISO(epoch, Number(values[i]) * secondsPerUnit);
  }
  return { values: out, unitsRaw: unitsString, calendar: cal };
}
