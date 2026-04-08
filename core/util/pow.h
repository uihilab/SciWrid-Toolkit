#ifndef DP_POW_H
#define DP_POW_H

static inline double dp_pow10(int e) {
  double r = 1.0;
  if (e > 0) {
    while (e--) r *= 10.0;
  } else {
    while (e++) r /= 10.0;
  }
  return r;
}

#endif
