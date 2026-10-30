#!/bin/bash
set -eu
IRODORI_EXPORT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$IRODORI_EXPORT_ROOT"
if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  exec node "$IRODORI_EXPORT_ROOT/scripts/ultrahdr/build-linux.mjs"
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'The native export encoder targets Linux x64 and macOS arm64.' >&2
  exit 1
fi
IRODORI_NATIVE_BUILD="$IRODORI_EXPORT_ROOT/artifacts/ultrahdr-native-build"
IRODORI_NATIVE_OUTPUT="$IRODORI_EXPORT_ROOT/vendor/ultrahdr/native/darwin-arm64"
mkdir -p "$IRODORI_NATIVE_BUILD" "$IRODORI_NATIVE_OUTPUT"
cd "$IRODORI_NATIVE_BUILD"
# Reuse verified source archives when the WASM build has already fetched them.
for archive in source.tar.gz jpeg.tar.gz; do
  if [ ! -f "$archive" ] && [ -f "$IRODORI_EXPORT_ROOT/artifacts/ultrahdr-build/$archive" ]; then
    cp "$IRODORI_EXPORT_ROOT/artifacts/ultrahdr-build/$archive" "$archive"
  fi
done
if [ ! -f source.tar.gz ]; then
  curl --fail -L https://codeload.github.com/google/libultrahdr/tar.gz/refs/tags/v2.0.2 -o source.tar.gz
fi
if [ ! -f jpeg.tar.gz ]; then
  curl --fail -L https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/refs/tags/3.1.0 -o jpeg.tar.gz
fi
printf '%s\n' 'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c  source.tar.gz' '35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285  jpeg.tar.gz' | shasum -a 256 -c -
tar -xzf source.tar.gz
tar -xzf jpeg.tar.gz
# Native builds keep upstream's bounded (at most four) encoder threads.
cmake -S libjpeg-turbo-3.1.0 -B jpeg-build -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DWITH_SIMD=ON -DWITH_TURBOJPEG=OFF -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0
cmake --build jpeg-build -j 4 --target jpeg-static
cmake -S libultrahdr-2.0.2 -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DUHDR_BUILD_EXAMPLES=OFF -DUHDR_BUILD_TESTS=OFF -DUHDR_ENABLE_INSTALL=OFF -DUHDR_ENABLE_INTRINSICS=ON -DUHDR_ENABLE_HEIF=OFF -DUHDR_WRITE_XMP=OFF -DUHDR_WRITE_ISO=ON -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_CXX_FLAGS="-I$IRODORI_NATIVE_BUILD/jpeg-build" -DJPEG_LIBRARY="$IRODORI_NATIVE_BUILD/jpeg-build/libjpeg.a" -DJPEG_INCLUDE_DIR="$IRODORI_NATIVE_BUILD/libjpeg-turbo-3.1.0/src"
cmake --build build -j 4
clang++ -std=c++17 -O3 -mmacosx-version-min=13.0 -Ilibultrahdr-2.0.2 \
  "$IRODORI_EXPORT_ROOT/scripts/ultrahdr/native.cpp" "$IRODORI_EXPORT_ROOT/scripts/ultrahdr/bridge.cpp" \
  build/libuhdr.a jpeg-build/libjpeg.a -o "$IRODORI_NATIVE_OUTPUT/irodori-ultrahdr"
cd "$IRODORI_NATIVE_OUTPUT"
shasum -a 256 irodori-ultrahdr > SHA256SUMS
