#ifndef DP_ABI_VERSION_H
#define DP_ABI_VERSION_H

#define DP_ABI_VERSION_MAJOR 1
#define DP_ABI_VERSION_MINOR 0

static inline unsigned dp_abi_version(void) {
  return (DP_ABI_VERSION_MAJOR << 16) | DP_ABI_VERSION_MINOR;
}

#endif
