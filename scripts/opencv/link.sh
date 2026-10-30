#!/bin/bash
set -eu
cd /work/artifacts/opencv-build
em++ /work/scripts/opencv/bridge.cpp -O3 -fexceptions -msimd128 \
  -Ibuild -Iopencv-4.13.0/modules/core/include -Iopencv-4.13.0/modules/imgproc/include \
  -Iopencv-4.13.0/modules/features2d/include -Iopencv-4.13.0/modules/flann/include \
  -Iopencv-4.13.0/modules/calib3d/include -Iopencv-4.13.0/modules/video/include \
  -Wl,--start-group build/lib/libopencv_{video,calib3d,features2d,flann,imgproc,core}.a build/3rdparty/lib/libzlib.a -Wl,--end-group \
  -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=268435456 \
  -sINITIAL_MEMORY=33554432 -sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","HEAPF64"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_irodori_matches","_irodori_fit","_irodori_ecc","_irodori_features","_irodori_descriptors","_irodori_patches","_irodori_patch_stats"]' \
  -o /work/vendor/opencv/irodori-opencv.mjs
cp opencv-4.13.0/LICENSE /work/vendor/opencv/LICENSE
mkdir -p /work/vendor/opencv/licenses
cp opencv-4.13.0/3rdparty/zlib/LICENSE /work/vendor/opencv/licenses/zlib.txt
cp opencv-4.13.0/3rdparty/zlib-ng/LICENSE.md /work/vendor/opencv/licenses/zlib-ng.txt
sed -n '1,41p' opencv-4.13.0/modules/flann/include/opencv2/flann.hpp > /work/vendor/opencv/licenses/opencv-legacy.txt
sed -n '1,27p' opencv-4.13.0/modules/flann/include/opencv2/flann/defines.h > /work/vendor/opencv/licenses/flann.txt
sed -n '1,65p' opencv-4.13.0/modules/core/src/softfloat.cpp > /work/vendor/opencv/licenses/softfloat.txt
cd /work/vendor/opencv
sha256sum irodori-opencv.mjs irodori-opencv.wasm > SHA256SUMS
