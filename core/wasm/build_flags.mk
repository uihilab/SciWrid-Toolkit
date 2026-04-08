WASM_CFLAGS = \
  -O3 \
  -nostdlib \
  -ffunction-sections \
  -fdata-sections

WASM_LDFLAGS = \
  -Wl,--gc-sections \
  -Wl,--no-entry
