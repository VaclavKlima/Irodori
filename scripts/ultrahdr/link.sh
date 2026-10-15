#!/bin/bash
set -eu
LUMA_EXPORT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$LUMA_EXPORT_ROOT/artifacts/ultrahdr-build"
em++ "$LUMA_EXPORT_ROOT/scripts/ultrahdr/bridge.cpp" -O3 -fexceptions -Ilibultrahdr-2.0.2 build/libuhdr.a jpeg-build/libjpeg.a \
  -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
  -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=1048576 -sABORTING_MALLOC=0 \
  -sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","UTF8ToString"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_luma_encode","_luma_output","_luma_size","_luma_error","_luma_release","_luma_probe","_luma_info","_luma_map","_luma_map_size","_luma_decode","_luma_pixels","_luma_stride","_luma_gamut"]' \
  -o "$LUMA_EXPORT_ROOT/vendor/ultrahdr/luma-ultrahdr.mjs"
cp libultrahdr-2.0.2/LICENSE "$LUMA_EXPORT_ROOT/vendor/ultrahdr/LICENSE"
mkdir -p "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses"
cp libjpeg-turbo-3.1.0/LICENSE.md "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses/libjpeg-turbo.md"
cp libjpeg-turbo-3.1.0/README.ijg "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses/README.ijg"
cp libultrahdr-2.0.2/LICENSE-MIT "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses/ultrahdr-MIT"
cp libultrahdr-2.0.2/LICENSE-APACHE "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses/ultrahdr-Apache"
cp libultrahdr-2.0.2/adobe-hdr-gain-map-license/NOTICE "$LUMA_EXPORT_ROOT/vendor/ultrahdr/licenses/Adobe-NOTICE"
chmod 644 "$LUMA_EXPORT_ROOT/vendor/ultrahdr/luma-ultrahdr.wasm"
cd "$LUMA_EXPORT_ROOT/vendor/ultrahdr"
shasum -a 256 luma-ultrahdr.mjs luma-ultrahdr.wasm > SHA256SUMS
