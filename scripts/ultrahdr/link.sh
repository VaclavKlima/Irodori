#!/bin/bash
set -eu
IRODORI_EXPORT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$IRODORI_EXPORT_ROOT/artifacts/ultrahdr-build"
em++ "$IRODORI_EXPORT_ROOT/scripts/ultrahdr/bridge.cpp" -O3 -fexceptions -Ilibultrahdr-2.0.2 build/libuhdr.a jpeg-build/libjpeg.a \
  -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 \
  -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=1048576 -sABORTING_MALLOC=0 \
  -sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","UTF8ToString"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_irodori_encode","_irodori_output","_irodori_size","_irodori_error","_irodori_release","_irodori_probe","_irodori_info","_irodori_map","_irodori_map_size","_irodori_decode","_irodori_pixels","_irodori_stride","_irodori_gamut"]' \
  -o "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/irodori-ultrahdr.mjs"
cp libultrahdr-2.0.2/LICENSE "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/LICENSE"
mkdir -p "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses"
cp libjpeg-turbo-3.1.0/LICENSE.md "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses/libjpeg-turbo.md"
cp libjpeg-turbo-3.1.0/README.ijg "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses/README.ijg"
cp libultrahdr-2.0.2/LICENSE-MIT "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses/ultrahdr-MIT"
cp libultrahdr-2.0.2/LICENSE-APACHE "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses/ultrahdr-Apache"
cp libultrahdr-2.0.2/adobe-hdr-gain-map-license/NOTICE "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/licenses/Adobe-NOTICE"
chmod 644 "$IRODORI_EXPORT_ROOT/vendor/ultrahdr/irodori-ultrahdr.wasm"
cd "$IRODORI_EXPORT_ROOT/vendor/ultrahdr"
shasum -a 256 irodori-ultrahdr.mjs irodori-ultrahdr.wasm > SHA256SUMS
