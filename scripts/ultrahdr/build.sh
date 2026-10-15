#!/bin/bash
set -eu
# Use Emscripten 4.0.20, either locally activated or emscripten/emsdk:4.0.20.
LUMA_EXPORT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$LUMA_EXPORT_ROOT"
mkdir -p artifacts/ultrahdr-build vendor/ultrahdr
cd artifacts/ultrahdr-build
curl --fail -L https://codeload.github.com/google/libultrahdr/tar.gz/refs/tags/v2.0.2 -o source.tar.gz
curl --fail -L https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/refs/tags/3.1.0 -o jpeg.tar.gz
printf '%s\n' 'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c  source.tar.gz' '35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285  jpeg.tar.gz' | shasum -a 256 -c -
tar -xzf source.tar.gz
tar -xzf jpeg.tar.gz
# Explicitly single-threaded, including hosts that report multiple logical cores.
python3 -c 'from pathlib import Path; p=Path("libultrahdr-2.0.2/lib/src/jpegr.cpp"); s=p.read_text(); old="return (std::max)(1u, std::thread::hardware_concurrency());"; assert s.count(old)==1; p.write_text(s.replace(old,"return 1u;"))'
emcmake cmake -S libjpeg-turbo-3.1.0 -B jpeg-build -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF
cmake --build jpeg-build -j 4 --target jpeg-static
emcmake cmake -S libultrahdr-2.0.2 -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DUHDR_BUILD_EXAMPLES=OFF -DUHDR_BUILD_TESTS=OFF -DUHDR_ENABLE_INSTALL=OFF -DUHDR_ENABLE_INTRINSICS=OFF -DUHDR_ENABLE_HEIF=OFF -DUHDR_WRITE_XMP=OFF -DUHDR_WRITE_ISO=ON -DCMAKE_CXX_FLAGS="-fexceptions -I$PWD/jpeg-build" -DJPEG_LIBRARY="$PWD/jpeg-build/libjpeg.a" -DJPEG_INCLUDE_DIR="$PWD/libjpeg-turbo-3.1.0/src"
cmake --build build -j 4
bash "$LUMA_EXPORT_ROOT/scripts/ultrahdr/link.sh"
