#include "grib2_metadata.h"
#include <string.h>
#include <stdio.h>

/* Get human-readable variable name from parameter category/number */
const char* grib2_get_variable_name(uint16_t category, uint16_t number) {
  /* Category 0: Temperature */
  if (category == 0) {
    switch (number) {
      case 0: return "Temperature";
      case 2: return "Temperature anomaly";
      case 5: return "Temperature gradient";
      case 6: return "Maximum temperature";
      case 7: return "Minimum temperature";
      case 8: return "Dew point temperature";
      case 11: return "Wet bulb temperature";
      case 13: return "Potential temperature";
      case 14: return "Virtual potential temperature";
      case 15: return "Saturated equivalent potential temperature";
      default: return "Temperature (unknown)";
    }
  }
  
  /* Category 1: Moisture (WMO standard) */
  if (category == 1) {
    switch (number) {
      case 0:  return "Specific humidity";
      case 1:  return "Relative humidity";
      case 2:  return "Humidity mixing ratio";
      case 3:  return "Precipitable water";
      case 4:  return "Vapor pressure";
      case 7:  return "Precipitation rate";
      case 8:  return "Total precipitation";
      case 9:  return "Large scale precipitation";
      case 10: return "Convective precipitation";
      case 11: return "Snowfall rate";
      case 12: return "Snow depth";
      case 22: return "Precipitable water category";
      case 23: return "Hail";
      case 24: return "Graupel";
      case 25: return "Freezing rain";
      case 32: return "Percent frozen precipitation";
      case 52: return "Total snowfall";
      default: return "Moisture (unknown)";
    }
  }

  /* Category 2: Momentum */
  if (category == 2) {
    switch (number) {
      case 2: return "U-component of wind";
      case 3: return "V-component of wind";
      case 8: return "Vertical velocity";
      case 32: return "Wind speed";
      case 33: return "Wind direction";
      default: return "Wind (unknown)";
    }
  }
  
  /* Category 3: Mass */
  if (category == 3) {
    switch (number) {
      case 0: return "Pressure";
      case 1: return "Pressure reduced to MSL";
      case 4: return "Pressure anomaly";
      case 5: return "Geopotential height";
      case 6: return "Geopotential height anomaly";
      case 7: return "Geometric height";
      case 8: return "Standard deviation of height";
      case 9: return "Pressure tendency";
      default: return "Pressure/Height (unknown)";
    }
  }
  
  /* Category 6: Cloud */
  if (category == 6) {
    switch (number) {
      case 0: return "Cloud cover";
      case 1: return "Cloud ice";
      case 2: return "Cloud liquid water";
      case 3: return "Cloud water";
      case 4: return "Cloud rain";
      case 5: return "Cloud snow";
      case 6: return "Cloud ice mixing ratio";
      case 7: return "Cloud water mixing ratio";
      default: return "Cloud (unknown)";
    }
  }
  
  /* Category 7: Thermodynamic */
  if (category == 7) {
    switch (number) {
      case 0: return "Relative humidity";
      case 1: return "Specific humidity";
      case 2: return "Humidity mixing ratio";
      case 3: return "Precipitable water";
      case 4: return "Vapor pressure";
      case 5: return "Saturation deficit";
      case 6: return "Evaporation";
      case 7: return "Precipitation rate";
      case 8: return "Total precipitation";
      case 9: return "Large scale precipitation";
      case 10: return "Convective precipitation";
      case 11: return "Snowfall rate";
      case 12: return "Snow depth";
      default: return "Moisture (unknown)";
    }
  }
  
  /* Category 19: Geophysical */
  if (category == 19) {
    switch (number) {
      case 0: return "Wave height";
      case 1: return "Wave direction";
      case 2: return "Wave period";
      case 3: return "Wave spectrum width";
      case 4: return "Significant wave height";
      case 5: return "Significant wave period";
      default: return "Wave (unknown)";
    }
  }
  
  /* Unknown category/number */
  static char unknown[64];
  snprintf(unknown, sizeof(unknown), "Variable (cat=%u, num=%u)", category, number);
  return unknown;
}

