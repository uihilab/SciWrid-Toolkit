#ifndef DP_WASM_EXPORTS_H
#define DP_WASM_EXPORTS_H

#if defined(__wasm__)
  #define DP_EXPORT __attribute__((visibility("default")))
#else
  #define DP_EXPORT
#endif

#endif
