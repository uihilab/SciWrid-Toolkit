#include "grib2_metadata.h"
#include "grib2_param_table.h"
#include <string.h>
#include <stdio.h>

/* Look up a parameter's name in WMO Code Table 4.2.
 *
 * The table this replaces was written by hand and keyed on (category, number).
 * An audit against WMO found 54 of its 67 entries wrong under EVERY discipline:
 * real parameter names sitting on the wrong numbers, so a dewpoint temperature
 * field (0.0.6) reported itself as "Maximum temperature", which is 0.0.4.
 * Ignoring discipline compounded it -- category 7 held a verbatim copy of the
 * category 1 moisture list, while discipline 0 category 7 is thermodynamic
 * stability indices.
 *
 * The table is now generated from WMO's published tables alongside the JS one
 * (grib2_param_table.h), so the two layers cannot drift and neither can be
 * fixed by hand into disagreeing with the source.
 *
 * `centre` matters because WMO reserves parameter numbers 192-254 for the
 * originating centre: the same numbers mean different things in an NCEP file
 * and an ECMWF one. The centre's own entry is preferred when there is one, and
 * WMO's is used otherwise.
 */
static const char* grib2_lookup(uint8_t discipline, uint16_t category,
                                uint16_t number, uint16_t centre,
                                int want_units) {
  if (category > 255 || number > 255) return NULL;

  /* Binary search to the first row with this (discipline, category, number);
   * rows sharing it differ only by centre and are contiguous. */
  int lo = 0, hi = GRIB2_PARAM_TABLE_LEN - 1, first = -1;
  while (lo <= hi) {
    int mid = lo + (hi - lo) / 2;
    const grib2_param_row_t* r = &GRIB2_PARAM_TABLE[mid];
    int cmp = (r->discipline != discipline) ? (r->discipline < discipline ? -1 : 1)
            : (r->category   != category)   ? (r->category   < category   ? -1 : 1)
            : (r->number     != number)     ? (r->number     < number     ? -1 : 1)
            : 0;
    if (cmp == 0) { first = mid; hi = mid - 1; }      /* keep going left */
    else if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  if (first < 0) return NULL;

  const grib2_param_row_t* wmo = NULL;
  for (int i = first; i < GRIB2_PARAM_TABLE_LEN; i++) {
    const grib2_param_row_t* r = &GRIB2_PARAM_TABLE[i];
    if (r->discipline != discipline || r->category != category ||
        r->number != number) break;
    if (r->centre == centre && centre != 0)
      return want_units ? r->units : r->name;         /* the centre's own */
    if (r->centre == 0) wmo = r;
  }
  return wmo ? (want_units ? wmo->units : wmo->name) : NULL;
}

const char* grib2_get_variable_name(uint8_t discipline, uint16_t category,
                                    uint16_t number, uint16_t centre) {
  const char* name = grib2_lookup(discipline, category, number, centre, 0);
  if (name) return name;

  /* Not in Table 4.2 and not in the centre's table. Report the numbers that
   * were actually read rather than naming a category we would only be
   * assuming -- the old fallback said "Wind (unknown)" for anything in
   * category 2, which reads as a partial identification when it is a miss. */
  static char unknown[64];
  snprintf(unknown, sizeof(unknown), "Variable (discipline=%u, cat=%u, num=%u)",
           (unsigned)discipline, (unsigned)category, (unsigned)number);
  return unknown;
}

/* Units for the same key, or "" when unknown. GRIB2 does not store units; they
 * come from the same table as the name. */
const char* grib2_get_variable_units(uint8_t discipline, uint16_t category,
                                     uint16_t number, uint16_t centre) {
  const char* u = grib2_lookup(discipline, category, number, centre, 1);
  return u ? u : "";
}

